import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const CHUNK_CHARACTERS = 4_000;
const CHUNK_OVERLAP = 200;
const MAX_UNIQUE_TOKENS = 600;
const DEFAULT_RESULT_LIMIT = 50;
const INDEX_CONCURRENCY = 4;

export type SearchSource = "user" | "assistant" | "shell" | "summary" | "custom" | "metadata";

export interface ExtractedSessionText {
	source: SearchSource;
	text: string;
}

export interface SearchChunk extends ExtractedSessionText {
	normalized: string;
	similarityText: string;
	tokens: readonly string[];
	tokenSet: ReadonlySet<string>;
}

export interface IndexedSession {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	size: number;
	mtimeMs: number;
	malformedLines: number;
	chunks: readonly SearchChunk[];
}

export interface TextMatchRange {
	start: number;
	end: number;
}

export interface SessionSearchResult {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	pinned: boolean;
	score: number;
	source: SearchSource;
	snippet: string;
	matchRanges: readonly TextMatchRange[];
}

export interface RefreshProgress {
	loaded: number;
	total: number;
	path?: string;
}

export interface RefreshSummary {
	files: number;
	indexed: number;
	unchanged: number;
	removed: number;
	failed: number;
	malformedLines: number;
}

export interface SearchOptions {
	cwd?: string;
	limit?: number;
	pinnedPaths?: ReadonlySet<string>;
}

interface DiscoveredSessionFile {
	path: string;
	size: number;
	mtimeMs: number;
}

interface ParsedSessionMetadata {
	id?: string;
	cwd?: string;
	name?: string;
	created?: Date;
}

function abortError(): Error {
	const error = new Error("Session search cancelled");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => record(block))
		.filter((block): block is Record<string, unknown> => block?.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

/** Extract searchable conversation text without indexing tools, images, or reasoning blocks. */
export function extractEntryText(entry: unknown): ExtractedSessionText[] {
	const object = record(entry);
	if (!object) return [];
	const extracted: ExtractedSessionText[] = [];
	const add = (source: SearchSource, text: unknown): void => {
		if (typeof text !== "string") return;
		const trimmed = text.trim();
		if (trimmed) extracted.push({ source, text: trimmed });
	};

	if (object.type === "compaction" || object.type === "branch_summary") {
		add("summary", object.summary);
		return extracted;
	}
	if (object.type === "custom_message") {
		add("custom", contentText(object.content));
		return extracted;
	}
	if (object.type === "label") {
		add("metadata", object.label);
		return extracted;
	}
	if (object.type !== "message") return extracted;

	const message = record(object.message);
	if (!message || typeof message.role !== "string") return extracted;
	const role = message.role;
	if (role === "user") add("user", contentText(message.content));
	else if (role === "assistant") add("assistant", contentText(message.content));
	else if (role === "bashExecution") add("shell", message.command);
	else if (role === "custom") add("custom", contentText(message.content));
	return extracted;
}

export function normalizeSearchText(text: string): string {
	return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function similarityText(text: string): string {
	return normalizeSearchText(text).replace(/[^\p{L}\p{N}]+/gu, " ");
}

function tokenize(text: string): string[] {
	const unique = new Set<string>();
	for (const token of similarityText(text).match(/[\p{L}\p{N}_-]+/gu) ?? []) {
		if (!token || unique.has(token)) continue;
		unique.add(token);
		if (unique.size >= MAX_UNIQUE_TOKENS) break;
	}
	return [...unique];
}

function splitSearchText(value: ExtractedSessionText): SearchChunk[] {
	const text = value.text.replace(/\u0000/g, " ").trim();
	if (!text) return [];
	const chunks: SearchChunk[] = [];
	const step = CHUNK_CHARACTERS - CHUNK_OVERLAP;
	for (let offset = 0; offset < text.length; offset += step) {
		const slice = text.slice(offset, offset + CHUNK_CHARACTERS);
		const normalized = normalizeSearchText(slice);
		const tokens = tokenize(slice);
		chunks.push({
			source: value.source,
			text: slice,
			normalized,
			similarityText: similarityText(slice),
			tokens,
			tokenSet: new Set(tokens),
		});
		if (offset + CHUNK_CHARACTERS >= text.length) break;
	}
	return chunks;
}

function parseDate(value: unknown): Date | undefined {
	if (typeof value !== "string") return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function updateMetadata(entry: unknown, metadata: ParsedSessionMetadata): void {
	const object = record(entry);
	if (!object) return;
	if (object.type === "session") {
		if (typeof object.id === "string") metadata.id = object.id;
		if (typeof object.cwd === "string") metadata.cwd = object.cwd;
		metadata.created = parseDate(object.timestamp) ?? metadata.created;
	} else if (object.type === "session_info") {
		metadata.name =
			typeof object.name === "string" && object.name.trim() ? object.name.trim() : undefined;
	}
}

/** Parse one append-only Pi JSONL session into bounded searchable chunks. */
export async function parseSessionFile(
	file: DiscoveredSessionFile,
	signal?: AbortSignal,
): Promise<IndexedSession> {
	throwIfAborted(signal);
	const metadata: ParsedSessionMetadata = {};
	const chunks: SearchChunk[] = [];
	let malformedLines = 0;
	const stream = createReadStream(file.path, { encoding: "utf8", signal });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			throwIfAborted(signal);
			if (!line.trim()) continue;
			try {
				const entry: unknown = JSON.parse(line);
				updateMetadata(entry, metadata);
				for (const extracted of extractEntryText(entry)) chunks.push(...splitSearchText(extracted));
			} catch {
				malformedLines++;
			}
		}
	} catch (error) {
		if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
			throw abortError();
		throw error;
	} finally {
		lines.close();
	}

	const id = metadata.id ?? basename(file.path, ".jsonl");
	const cwd = metadata.cwd ?? "";
	const name = metadata.name;
	const metadataText = [id, name, cwd].filter(Boolean).join("\n");
	if (metadataText) chunks.push(...splitSearchText({ source: "metadata", text: metadataText }));
	return {
		path: file.path,
		id,
		cwd,
		name,
		created: metadata.created ?? new Date(file.mtimeMs),
		modified: new Date(file.mtimeMs),
		size: file.size,
		mtimeMs: file.mtimeMs,
		malformedLines,
		chunks,
	};
}

function isWithin(root: string, candidate: string, allowRoot = false): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	if (rel === "") return allowRoot;
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Discover regular JSONL files without following directory or file symlinks. */
export async function discoverSessionFiles(
	root: string,
	signal?: AbortSignal,
): Promise<DiscoveredSessionFile[]> {
	throwIfAborted(signal);
	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(root);
	} catch {
		return [];
	}
	const files: DiscoveredSessionFile[] = [];
	const directories = [canonicalRoot];
	while (directories.length > 0) {
		throwIfAborted(signal);
		const directory = directories.pop()!;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			throwIfAborted(signal);
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				directories.push(path);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			try {
				const [fileStats, canonicalPath] = await Promise.all([lstat(path), realpath(path)]);
				if (!fileStats.isFile() || !isWithin(canonicalRoot, canonicalPath)) continue;
				files.push({ path: canonicalPath, size: fileStats.size, mtimeMs: fileStats.mtimeMs });
			} catch {
				// The file raced away during discovery.
			}
		}
	}
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

function boundedLevenshtein(left: string, right: string, maximum: number): number | undefined {
	if (Math.abs(left.length - right.length) > maximum) return undefined;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row++) {
		const current = new Array<number>(right.length + 1);
		current[0] = row;
		let rowMinimum = row;
		for (let column = 1; column <= right.length; column++) {
			const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
			current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution);
			rowMinimum = Math.min(rowMinimum, current[column]!);
		}
		if (rowMinimum > maximum) return undefined;
		previous = current;
	}
	const distance = previous[right.length]!;
	return distance <= maximum ? distance : undefined;
}

function tokenSimilarity(queryToken: string, candidate: string): number {
	if (candidate === queryToken) return 1;
	if (queryToken.length >= 2 && candidate.startsWith(queryToken)) return 0.92;
	if (queryToken.length < 4 || queryToken.length > 64) return 0;
	const maximum = queryToken.length <= 5 ? 1 : queryToken.length <= 10 ? 2 : 3;
	if (
		candidate.length < 3 ||
		candidate.length > 64 ||
		Math.abs(candidate.length - queryToken.length) > maximum
	)
		return 0;
	const distance = boundedLevenshtein(queryToken, candidate, maximum);
	return distance === undefined
		? 0
		: 0.86 - (distance / Math.max(queryToken.length, candidate.length)) * 0.5;
}

function tokenMatchScore(queryToken: string, chunk: SearchChunk): number {
	if (chunk.tokenSet.has(queryToken)) return 1;
	let best = 0;
	for (const token of chunk.tokens) best = Math.max(best, tokenSimilarity(queryToken, token));
	return best;
}

function queryGrams(query: string): string[] {
	const compact = similarityText(query);
	if (compact.length < 3) return [];
	const grams = new Set<string>();
	for (let index = 0; index <= compact.length - 3; index++) {
		const gram = compact.slice(index, index + 3);
		if (!gram.includes(" ") && gram.trim().length >= 2) grams.add(gram);
	}
	return [...grams];
}

function sourceBoost(source: SearchSource): number {
	switch (source) {
		case "metadata":
			return 14;
		case "user":
			return 12;
		case "summary":
			return 8;
		case "shell":
			return 5;
		default:
			return 3;
	}
}

function scoreChunk(
	query: string,
	queryTokens: readonly string[],
	grams: readonly string[],
	chunk: SearchChunk,
): number | undefined {
	const exactPhrase = query.length >= 2 && chunk.normalized.includes(query);
	if (exactPhrase) return 350 + sourceBoost(chunk.source);

	let gramCoverage = 0;
	if (grams.length > 0) {
		let matched = 0;
		for (const gram of grams) if (chunk.similarityText.includes(gram)) matched++;
		gramCoverage = matched / grams.length;
		if (grams.length >= 4 && queryTokens.length > 1 && gramCoverage < 0.18) return undefined;
	}
	const tokenScores = queryTokens.map((token) => tokenMatchScore(token, chunk));
	const matchedTokens = tokenScores.filter((score) => score >= 0.74).length;
	const tokenAverage = tokenScores.length
		? tokenScores.reduce((total, score) => total + score, 0) / tokenScores.length
		: 0;
	const requiredTokens =
		queryTokens.length <= 2 ? queryTokens.length : Math.ceil(queryTokens.length * 0.7);
	const tokenMatch =
		queryTokens.length > 0 && matchedTokens >= requiredTokens && tokenAverage >= 0.74;
	const sentenceFallback = queryTokens.length >= 3 && matchedTokens >= 1 && gramCoverage >= 0.66;
	if (!tokenMatch && !sentenceFallback) return undefined;
	return tokenAverage * 100 + gramCoverage * 40 + sourceBoost(chunk.source);
}

function collapseSnippet(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Locate the exact source characters selected by phrase, prefix, or typo matching. */
export function findTextMatchRanges(text: string, query: string): TextMatchRange[] {
	const normalizedQuery = normalizeSearchText(query);
	if (!normalizedQuery) return [];
	// Preserve source indices for rendering. NFKC can expand characters such as
	// the leading snippet ellipsis, so normalized offsets cannot safely index text.
	const indexQuery = query.replace(/\s+/g, " ").trim().toLocaleLowerCase();
	const exactIndex = text.toLocaleLowerCase().indexOf(indexQuery);
	if (exactIndex >= 0) return [{ start: exactIndex, end: exactIndex + indexQuery.length }];

	const queryTokens = tokenize(normalizedQuery);
	const candidates = [...text.matchAll(/[\p{L}\p{N}_-]+/gu)].map((match) => ({
		value: normalizeSearchText(match[0]),
		start: match.index,
		end: match.index + match[0].length,
	}));
	const claimed = new Set<number>();
	const ranges: TextMatchRange[] = [];
	for (const queryToken of queryTokens) {
		let bestIndex = -1;
		let bestScore = 0;
		for (const [index, candidate] of candidates.entries()) {
			if (claimed.has(index)) continue;
			const score = tokenSimilarity(queryToken, candidate.value);
			if (score > bestScore) {
				bestIndex = index;
				bestScore = score;
			}
		}
		if (bestIndex < 0 || bestScore < 0.74) continue;
		claimed.add(bestIndex);
		const candidate = candidates[bestIndex]!;
		ranges.push({ start: candidate.start, end: candidate.end });
	}
	return ranges.sort((left, right) => left.start - right.start);
}

export function buildSnippet(
	chunk: SearchChunk,
	normalizedQuery: string,
	_queryTokens: readonly string[],
	limit = 220,
): string {
	const text = collapseSnippet(chunk.text);
	if (text.length <= limit) return text;
	const matchIndex = findTextMatchRanges(text, normalizedQuery)[0]?.start ?? 0;
	const start = Math.max(0, matchIndex - Math.floor(limit * 0.3));
	const end = Math.min(text.length, start + limit);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export class SessionSearchIndex {
	private readonly sessions = new Map<string, IndexedSession>();

	get size(): number {
		return this.sessions.size;
	}

	getSessions(): readonly IndexedSession[] {
		return [...this.sessions.values()];
	}

	async refresh(
		root: string,
		signal?: AbortSignal,
		onProgress?: (progress: RefreshProgress) => void,
	): Promise<RefreshSummary> {
		const discovered = await discoverSessionFiles(root, signal);
		const discoveredByPath = new Map(discovered.map((file) => [file.path, file]));
		const changed = discovered.filter((file) => {
			const cached = this.sessions.get(file.path);
			return !cached || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs;
		});
		const parsed = new Map<string, IndexedSession>();
		const failures = new Set<string>();
		let next = 0;
		let loaded = 0;
		const worker = async (): Promise<void> => {
			while (next < changed.length) {
				const file = changed[next++]!;
				throwIfAborted(signal);
				try {
					parsed.set(file.path, await parseSessionFile(file, signal));
				} catch (error) {
					if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
						throw error;
					failures.add(file.path);
				} finally {
					loaded++;
					onProgress?.({ loaded, total: changed.length, path: file.path });
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(INDEX_CONCURRENCY, Math.max(1, changed.length)) }, worker),
		);
		throwIfAborted(signal);

		let removed = 0;
		for (const path of this.sessions.keys()) {
			if (!discoveredByPath.has(path)) {
				this.sessions.delete(path);
				removed++;
			}
		}
		for (const [path, session] of parsed) this.sessions.set(path, session);
		return {
			files: discovered.length,
			indexed: parsed.size,
			unchanged: discovered.length - changed.length,
			removed,
			failed: failures.size,
			malformedLines: [...this.sessions.values()].reduce(
				(total, session) => total + session.malformedLines,
				0,
			),
		};
	}

	search(query: string, options: SearchOptions = {}): SessionSearchResult[] {
		const normalizedQuery = normalizeSearchText(query);
		const queryTokens = tokenize(normalizedQuery);
		const grams = queryGrams(normalizedQuery);
		const cwd = options.cwd ? resolve(options.cwd) : undefined;
		const results: SessionSearchResult[] = [];

		for (const session of this.sessions.values()) {
			if (cwd && (!session.cwd || resolve(session.cwd) !== cwd)) continue;
			const pinned = options.pinnedPaths?.has(resolve(session.path)) ?? false;
			if (!normalizedQuery) {
				const chunk = session.chunks.find(({ source }) => source === "user") ?? session.chunks[0];
				results.push({
					path: session.path,
					id: session.id,
					cwd: session.cwd,
					name: session.name,
					created: session.created,
					modified: session.modified,
					pinned,
					score: 0,
					source: chunk?.source ?? "metadata",
					snippet: chunk ? buildSnippet(chunk, "", []) : "(no searchable text)",
					matchRanges: [],
				});
				continue;
			}

			let best: { chunk: SearchChunk; score: number } | undefined;
			let matchingChunks = 0;
			for (const chunk of session.chunks) {
				const score = scoreChunk(normalizedQuery, queryTokens, grams, chunk);
				if (score === undefined) continue;
				matchingChunks++;
				if (!best || score > best.score) best = { chunk, score };
			}
			if (!best) continue;
			const ageDays = Math.max(0, (Date.now() - session.modified.getTime()) / 86_400_000);
			const recencyBoost = 5 / (1 + ageDays / 30);
			const snippet = buildSnippet(best.chunk, normalizedQuery, queryTokens);
			results.push({
				path: session.path,
				id: session.id,
				cwd: session.cwd,
				name: session.name,
				created: session.created,
				modified: session.modified,
				pinned,
				score: best.score + Math.min(8, Math.log2(matchingChunks + 1) * 2) + recencyBoost,
				source: best.chunk.source,
				snippet,
				matchRanges: findTextMatchRanges(snippet, normalizedQuery),
			});
		}

		results.sort((left, right) => {
			const pinOrder = Number(right.pinned) - Number(left.pinned);
			if (pinOrder !== 0) return pinOrder;
			return normalizedQuery
				? right.score - left.score || right.modified.getTime() - left.modified.getTime()
				: right.modified.getTime() - left.modified.getTime();
		});
		return results.slice(0, options.limit ?? DEFAULT_RESULT_LIMIT);
	}
}

/** Resolve the all-project root for default Pi storage while preserving custom session roots. */
export function resolveSessionSearchRoot(sessionDir: string, agentSessionsRoot: string): string {
	const root = resolve(agentSessionsRoot);
	const directory = resolve(sessionDir);
	return isWithin(root, directory, true) ? root : directory;
}
