/**
 * WorkspaceEdit validation, multi-lock transaction, atomic writes, and verified rollback.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { hashContent, type DocumentStore } from "./documents.ts";
import {
	assertUriInWorkspace,
	readFileIdentity,
	revalidateMutationTarget,
	toFileUri,
	toProjectRelative,
	type FileIdentity,
} from "./paths.ts";
import type { LspClient } from "./client.ts";

export const MAX_RENAME_FILES = 100;
export const MAX_RENAME_EDITS = 2_000;
export const MAX_REPLACEMENT_BYTES = 2 * 1024 * 1024;

export interface TextEdit {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	newText: string;
}

export interface ValidatedFileEdits {
	uri: string;
	absolutePath: string;
	canonicalPath: string;
	relativePath: string;
	expectedVersion: number | null;
	edits: TextEdit[];
	identity: FileIdentity;
}

export interface ApplyRenameResult {
	filesTouched: number;
	editCount: number;
	relativePaths: string[];
	summary: string;
}

export class WorkspaceEditError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceEditError";
	}
}

export class RenameRecoveryError extends Error {
	readonly uncertainFiles: string[];

	constructor(message: string, uncertainFiles: string[]) {
		super(message);
		this.name = "RenameRecoveryError";
		this.uncertainFiles = uncertainFiles;
	}
}

/**
 * Normalize and validate a WorkspaceEdit. Rejects resource operations and unsafe URIs.
 */
export function validateWorkspaceEdit(
	edit: unknown,
	trustedRoot: string,
	documentStore: DocumentStore,
): ValidatedFileEdits[] {
	if (!edit || typeof edit !== "object") {
		throw new WorkspaceEditError("Rename returned an empty or invalid WorkspaceEdit");
	}
	const body = edit as {
		changes?: Record<string, TextEdit[]>;
		documentChanges?: unknown[];
	};

	const hasChanges = body.changes != null && typeof body.changes === "object";
	const hasDocumentChanges = Array.isArray(body.documentChanges);
	if (hasChanges && hasDocumentChanges) {
		throw new WorkspaceEditError("WorkspaceEdit must not include both changes and documentChanges");
	}

	const byCanonical = new Map<string, ValidatedFileEdits>();

	if (hasDocumentChanges) {
		for (const change of body.documentChanges!) {
			if (!change || typeof change !== "object") {
				throw new WorkspaceEditError("Invalid documentChange entry in WorkspaceEdit");
			}
			const rec = change as Record<string, unknown>;
			if ("kind" in rec) {
				throw new WorkspaceEditError(
					`Unsupported WorkspaceEdit resource operation "${String(rec.kind)}". ` +
						`Create/delete/rename file operations are rejected; only text edits are applied.`,
				);
			}
			const textDocument = rec.textDocument as
				{ uri?: string; version?: number | null } | undefined;
			const edits = rec.edits as TextEdit[] | undefined;
			if (!textDocument?.uri || !Array.isArray(edits)) {
				throw new WorkspaceEditError("Invalid TextDocumentEdit in WorkspaceEdit");
			}
			if (
				textDocument.version !== null &&
				textDocument.version !== undefined &&
				(!Number.isInteger(textDocument.version) || textDocument.version < 0)
			) {
				throw new WorkspaceEditError(
					`Malformed document version for ${textDocument.uri}: ${String(textDocument.version)}`,
				);
			}
			mergeFileEdits(
				byCanonical,
				textDocument.uri,
				textDocument.version ?? null,
				edits,
				trustedRoot,
			);
		}
	} else if (hasChanges) {
		for (const [uri, edits] of Object.entries(body.changes!)) {
			if (!Array.isArray(edits)) {
				throw new WorkspaceEditError(`Invalid changes list for ${uri}`);
			}
			mergeFileEdits(byCanonical, uri, null, edits, trustedRoot);
		}
	} else {
		throw new WorkspaceEditError("WorkspaceEdit has no changes or documentChanges");
	}

	const files = [...byCanonical.values()].sort((a, b) =>
		a.canonicalPath.localeCompare(b.canonicalPath),
	);
	if (files.length === 0) {
		throw new WorkspaceEditError("WorkspaceEdit contained no text edits");
	}
	if (files.length > MAX_RENAME_FILES) {
		throw new WorkspaceEditError(
			`WorkspaceEdit touches too many files (${files.length} > ${MAX_RENAME_FILES})`,
		);
	}

	const seenInodes = new Map<string, string>();
	for (const file of files) {
		if (file.identity.nlink > 1) {
			throw new WorkspaceEditError(
				`Refusing to mutate hard-linked file ${file.relativePath} (nlink=${file.identity.nlink}); ` +
					`atomic replacement would break hard-link semantics`,
			);
		}
		const key = `${String(file.identity.dev)}:${String(file.identity.ino)}`;
		const prior = seenInodes.get(key);
		if (prior) {
			throw new WorkspaceEditError(
				`Duplicate physical target (same inode) via ${prior} and ${file.relativePath}`,
			);
		}
		seenInodes.set(key, file.relativePath);
	}

	let totalEdits = 0;
	let replacementBytes = 0;
	for (const file of files) {
		totalEdits += file.edits.length;
		for (const edit of file.edits) {
			replacementBytes += Buffer.byteLength(edit.newText, "utf8");
		}
		validateEditRanges(file);
		const synced = documentStore.get(file.uri);
		if (file.expectedVersion !== null && file.expectedVersion !== undefined) {
			if (!synced) {
				throw new WorkspaceEditError(
					`Stale WorkspaceEdit: no synced version for ${file.relativePath} ` +
						`(server expected version ${file.expectedVersion})`,
				);
			}
			if (synced.version !== file.expectedVersion) {
				throw new WorkspaceEditError(
					`Stale WorkspaceEdit for ${file.relativePath}: ` +
						`server version ${file.expectedVersion}, synced version ${synced.version}`,
				);
			}
		}
	}
	if (totalEdits > MAX_RENAME_EDITS) {
		throw new WorkspaceEditError(
			`WorkspaceEdit has too many edits (${totalEdits} > ${MAX_RENAME_EDITS})`,
		);
	}
	if (replacementBytes > MAX_REPLACEMENT_BYTES) {
		throw new WorkspaceEditError(
			`WorkspaceEdit replacement text exceeds ${MAX_REPLACEMENT_BYTES} bytes`,
		);
	}

	return files;
}

function mergeFileEdits(
	byCanonical: Map<string, ValidatedFileEdits>,
	uri: string,
	version: number | null,
	edits: TextEdit[],
	trustedRoot: string,
): void {
	const canonicalPath = assertUriInWorkspace(uri, trustedRoot, {
		rejectSymlinks: true,
		requireRegularFile: true,
	});
	let lexical: string;
	try {
		lexical = uri.startsWith("file:") ? fileURLToPath(uri) : canonicalPath;
	} catch {
		lexical = canonicalPath;
	}
	const absolutePathResolved = path.resolve(lexical);
	const relativePath = toProjectRelative(canonicalPath, trustedRoot);
	const normalizedUri = toFileUri(absolutePathResolved);
	const identity = readFileIdentity(absolutePathResolved);
	if (identity.canonicalPath !== canonicalPath) {
		throw new WorkspaceEditError(`Path identity mismatch for ${relativePath}`);
	}
	if (identity.nlink > 1) {
		throw new WorkspaceEditError(
			`Refusing to mutate hard-linked file ${relativePath} (nlink=${identity.nlink})`,
		);
	}

	const existing = byCanonical.get(canonicalPath);
	if (existing) {
		if (
			existing.expectedVersion !== null &&
			version !== null &&
			existing.expectedVersion !== version
		) {
			throw new WorkspaceEditError(`Conflicting document versions for ${relativePath}`);
		}
		if (
			existing.identity.dev !== identity.dev ||
			existing.identity.ino !== identity.ino ||
			existing.absolutePath !== absolutePathResolved
		) {
			throw new WorkspaceEditError(
				`Duplicate physical target via different paths: ${existing.relativePath} and ${relativePath}`,
			);
		}
		existing.edits.push(...edits);
		if (existing.expectedVersion === null && version !== null) {
			existing.expectedVersion = version;
		}
		return;
	}
	// Also reject when a different lexical path maps to the same inode.
	for (const other of byCanonical.values()) {
		if (other.identity.dev === identity.dev && other.identity.ino === identity.ino) {
			throw new WorkspaceEditError(
				`Duplicate physical target (same inode) via ${other.relativePath} and ${relativePath}`,
			);
		}
	}
	byCanonical.set(canonicalPath, {
		uri: normalizedUri,
		absolutePath: absolutePathResolved,
		canonicalPath,
		relativePath,
		expectedVersion: version,
		edits: [...edits],
		identity,
	});
}

function validateEditRanges(file: ValidatedFileEdits): void {
	for (const edit of file.edits) {
		if (!edit?.range?.start || !edit?.range?.end || typeof edit.newText !== "string") {
			throw new WorkspaceEditError(`Invalid text edit in ${file.relativePath}`);
		}
		const { start, end } = edit.range;
		if (
			!Number.isInteger(start.line) ||
			!Number.isInteger(start.character) ||
			!Number.isInteger(end.line) ||
			!Number.isInteger(end.character)
		) {
			throw new WorkspaceEditError(`Non-integer range in ${file.relativePath}`);
		}
		if (start.line < 0 || start.character < 0 || end.line < 0 || end.character < 0) {
			throw new WorkspaceEditError(`Negative range in ${file.relativePath}`);
		}
		if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
			throw new WorkspaceEditError(`Inverted range in ${file.relativePath}`);
		}
	}

	const sorted = [...file.edits].sort((a, b) => {
		if (a.range.start.line !== b.range.start.line) {
			return a.range.start.line - b.range.start.line;
		}
		return a.range.start.character - b.range.start.character;
	});

	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1]!;
		const cur = sorted[i]!;
		const prevEnd = prev.range.end;
		const curStart = cur.range.start;
		const samePoint = curStart.line === prevEnd.line && curStart.character === prevEnd.character;
		const bothInsert =
			samePoint &&
			prev.range.start.line === prev.range.end.line &&
			prev.range.start.character === prev.range.end.character &&
			cur.range.start.line === cur.range.end.line &&
			cur.range.start.character === cur.range.end.character;
		if (bothInsert) {
			throw new WorkspaceEditError(`Duplicate same-offset inserts in ${file.relativePath}`);
		}
		const overlaps =
			curStart.line < prevEnd.line ||
			(curStart.line === prevEnd.line && curStart.character < prevEnd.character);
		if (overlaps) {
			throw new WorkspaceEditError(`Overlapping text edits in ${file.relativePath}`);
		}
	}
}

export async function withOrderedFileLocks<T>(
	absolutePaths: string[],
	fn: () => Promise<T>,
): Promise<T> {
	const unique = [...new Set(absolutePaths.map((p) => path.resolve(p)))].sort((a, b) =>
		a.localeCompare(b),
	);
	const nest = async (index: number): Promise<T> => {
		if (index >= unique.length) return fn();
		return withFileMutationQueue(unique[index]!, () => nest(index + 1));
	};
	return nest(0);
}

/**
 * Apply validated edits under all held locks: preflight → write → rollback on failure.
 * Cancellation before the first write aborts with zero writes. After commit starts,
 * finish commit or verified rollback without observing the abort signal.
 */
export async function applyWorkspaceEdit(
	files: ValidatedFileEdits[],
	client: LspClient,
	trustedRoot: string,
	signal?: AbortSignal,
): Promise<ApplyRenameResult> {
	throwIfAborted(signal);

	const paths = files.map((f) => f.absolutePath);
	return withOrderedFileLocks(paths, async () => {
		throwIfAborted(signal);

		const originals = new Map<string, string>();
		const planned = new Map<string, string>();
		let editCount = 0;

		for (const file of files) {
			revalidateMutationTarget(
				file.absolutePath,
				{
					canonicalPath: file.canonicalPath,
					dev: file.identity.dev,
					ino: file.identity.ino,
				},
				trustedRoot,
			);
			let content: string;
			try {
				content = await fs.promises.readFile(file.absolutePath, "utf8");
			} catch {
				throw new WorkspaceEditError(`Preflight failed: missing file ${file.relativePath}`);
			}
			const synced = client.documents.get(file.uri);
			if (synced && synced.hash && synced.hash !== hashContent(content)) {
				throw new WorkspaceEditError(
					`Preflight failed: on-disk content for ${file.relativePath} differs from the synced LSP buffer.`,
				);
			}
			if (file.expectedVersion !== null && synced && synced.version !== file.expectedVersion) {
				throw new WorkspaceEditError(`Preflight version mismatch for ${file.relativePath}`);
			}
			const next = applyEditsToText(content, file.edits);
			editCount += file.edits.length;
			originals.set(file.absolutePath, content);
			planned.set(file.absolutePath, next);
		}

		throwIfAborted(signal);

		type Tracked = {
			file: ValidatedFileEdits;
			original: string;
			planned: string;
			mode: number;
			/** Marked before write begins so rollback covers partial failures. */
			possiblyModified: boolean;
			committed: boolean;
		};
		const tracked: Tracked[] = files.map((file) => ({
			file,
			original: originals.get(file.absolutePath)!,
			planned: planned.get(file.absolutePath)!,
			mode: file.identity.mode,
			possiblyModified: false,
			committed: false,
		}));

		let commitStarted = false;
		try {
			for (const item of tracked) {
				if (!commitStarted) throwIfAborted(signal);
				revalidateMutationTarget(
					item.file.absolutePath,
					{
						canonicalPath: item.file.canonicalPath,
						dev: item.file.identity.dev,
						ino: item.file.identity.ino,
					},
					trustedRoot,
				);
				const current = await fs.promises.readFile(item.file.absolutePath, "utf8");
				if (current !== item.original) {
					throw new WorkspaceEditError(
						`File changed under lock before write: ${item.file.relativePath}`,
					);
				}
				item.possiblyModified = true;
				commitStarted = true;
				await atomicWriteFile(item.file.absolutePath, item.planned, item.mode);
				const after = await fs.promises.readFile(item.file.absolutePath, "utf8");
				if (after !== item.planned) {
					throw new WorkspaceEditError(
						`Post-write verification failed for ${item.file.relativePath}`,
					);
				}
				item.committed = true;
				// Refresh identity after replace (new inode is expected for atomic rename).
				item.file.identity = readFileIdentity(item.file.absolutePath);
				item.file.canonicalPath = item.file.identity.canonicalPath;
				client.documents.invalidate(item.file.uri);
			}
		} catch (error) {
			const uncertain: string[] = [];
			for (const item of [...tracked].reverse()) {
				if (!item.possiblyModified) continue;
				try {
					revalidateMutationTarget(
						item.file.absolutePath,
						{
							canonicalPath: item.file.canonicalPath,
							dev: item.file.identity.dev,
							ino: item.file.identity.ino,
						},
						trustedRoot,
					);
					const current = await fs.promises.readFile(item.file.absolutePath, "utf8");
					// Unknown content is always uncertain, even if we never marked committed.
					if (current !== item.planned && current !== item.original) {
						uncertain.push(item.file.relativePath);
						continue;
					}
					if (current === item.original) {
						client.documents.invalidate(item.file.uri);
						continue;
					}
					// current === planned: restore original
					await atomicWriteFile(item.file.absolutePath, item.original, item.mode);
					const restored = await fs.promises.readFile(item.file.absolutePath, "utf8");
					if (hashContent(restored) !== hashContent(item.original)) {
						uncertain.push(item.file.relativePath);
					} else {
						item.file.identity = readFileIdentity(item.file.absolutePath);
						item.file.canonicalPath = item.file.identity.canonicalPath;
						client.documents.invalidate(item.file.uri);
					}
				} catch {
					uncertain.push(item.file.relativePath);
				}
			}

			for (const item of tracked) {
				if (!item.possiblyModified) continue;
				try {
					await client.ensureSynced(item.file.absolutePath, item.file.uri);
				} catch {
					// best-effort resync after rollback
				}
			}

			if (uncertain.length > 0) {
				throw new RenameRecoveryError(
					`Rename rollback incomplete; manual recovery required for: ${uncertain.join(", ")}. ` +
						`Original error: ${errorText(error)}`,
					uncertain,
				);
			}
			throw error;
		}

		// Post-commit: resync without abort signal so success is not flipped to ambiguous error.
		for (const file of files) {
			try {
				await client.ensureSynced(file.absolutePath, file.uri);
			} catch (error) {
				// Successful disk commit stands; report soft resync note in summary only.
				void error;
			}
		}

		const relativePaths = files.map((f) => f.relativePath);
		return {
			filesTouched: files.length,
			editCount,
			relativePaths,
			summary:
				`rename applied: ${files.length} file(s), ${editCount} edit(s)\n` +
				relativePaths.map((p) => `  ${p}`).join("\n"),
		};
	});
}

async function atomicWriteFile(absolutePath: string, content: string, mode: number): Promise<void> {
	const dir = path.dirname(absolutePath);
	const tmp = path.join(
		dir,
		`.pi-lsp-rename-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	const permission = mode & 0o7777;
	try {
		await fs.promises.writeFile(tmp, content, {
			encoding: "utf8",
			flag: "wx",
			mode: permission,
		});
		// writeFile mode is umask-masked; force the original permission bits.
		await fs.promises.chmod(tmp, permission);
		await fs.promises.rename(tmp, absolutePath);
	} catch (error) {
		try {
			await fs.promises.unlink(tmp);
		} catch {
			// ignore
		}
		throw error;
	}
}

export function applyEditsToText(content: string, edits: TextEdit[]): string {
	const sorted = [...edits].sort((a, b) => {
		if (a.range.start.line !== b.range.start.line) {
			return b.range.start.line - a.range.start.line;
		}
		return b.range.start.character - a.range.start.character;
	});

	let text = content;
	for (const edit of sorted) {
		const startOffset = offsetAt(text, edit.range.start.line, edit.range.start.character);
		const endOffset = offsetAt(text, edit.range.end.line, edit.range.end.character);
		if (startOffset < 0 || endOffset < 0 || endOffset < startOffset) {
			throw new WorkspaceEditError("Edit range out of bounds for file content");
		}
		text = text.slice(0, startOffset) + edit.newText + text.slice(endOffset);
	}
	return text;
}

export function offsetAt(text: string, line: number, character: number): number {
	if (line < 0 || character < 0) return -1;
	let currentLine = 0;
	let offset = 0;
	while (currentLine < line) {
		const next = text.indexOf("\n", offset);
		if (next < 0) return -1;
		offset = next + 1;
		currentLine++;
	}
	const lineEnd = text.indexOf("\n", offset);
	const lineLength = (lineEnd < 0 ? text.length : lineEnd) - offset;
	if (character > lineLength) return -1;
	return offset + character;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	const error = new Error(reason ? String(reason) : "Aborted");
	error.name = "AbortError";
	throw error;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
