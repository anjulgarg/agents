/**
 * LSP client: initialize, capability negotiation, document requests, diagnostics, shutdown.
 */

import {
	JsonRpcConnection,
	JsonRpcError,
	ProtocolError,
	type JsonRpcConnectionOptions,
} from "./protocol.ts";
import type { Readable, Writable } from "node:stream";
import { DocumentStore } from "./documents.ts";
import { assertUriInWorkspace } from "./paths.ts";
import {
	DEFAULT_DIAGNOSTIC_MAX,
	DEFAULT_MAX_RESULTS,
	MAX_SYMBOL_DEPTH,
	MAX_SYMBOL_NAME_CHARS,
	MAX_SYMBOL_NODES,
	MAX_SERVER_STRING_CHARS,
	capServerString,
	formatDiagnostics,
	formatDocumentSymbols,
	formatHover,
	formatLocationList,
	formatWorkspaceSymbols,
	locationFromLsp,
	oneBasedToLsp,
	lspPositionToOneBased,
	type LocationResult,
} from "./format.ts";

export const INIT_TIMEOUT_MS = 15_000;
export const INDEXING_TIMEOUT_MS = 45_000;
export const DIAGNOSTICS_WAIT_MS = 4_000;

export interface LspServerCapabilities {
	hoverProvider?: boolean | object;
	definitionProvider?: boolean | object;
	referencesProvider?: boolean | object;
	documentSymbolProvider?: boolean | object;
	workspaceSymbolProvider?: boolean | object;
	renameProvider?: boolean | { prepareProvider?: boolean };
	diagnosticProvider?:
		| boolean
		| {
				interFileDependencies?: boolean;
				workspaceDiagnostics?: boolean;
		  };
	textDocumentSync?: number | { change?: number; openClose?: boolean };
}

export interface PublishedDiagnostics {
	uri: string;
	version?: number;
	diagnostics: LspDiagnostic[];
	receivedAt: number;
	/** Sync barrier epoch when this entry was accepted (for unversioned freshness). */
	syncEpoch: number;
}

export interface LspDiagnostic {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

export interface LspClientOptions extends JsonRpcConnectionOptions {
	workspaceRoot: string;
	/** Security boundary for returned URIs; defaults to workspaceRoot. */
	trustedRoot?: string;
	rootUri: string;
	initializationOptions?: Record<string, unknown>;
	initTimeoutMs?: number;
}

export type LspConnection = JsonRpcConnection;

type DiagWaiter =
	| { kind: "entry"; wake: (entry: PublishedDiagnostics) => void }
	| { kind: "error"; wake: (error: Error) => void };

export class LspClient {
	readonly connection: JsonRpcConnection;
	readonly documents = new DocumentStore();
	readonly workspaceRoot: string;
	readonly trustedRoot: string;
	private capabilities: LspServerCapabilities = {};
	private initialized = false;
	private serverName?: string;
	private readonly published = new Map<string, PublishedDiagnostics>();
	private readonly waiters = new Map<string, Set<DiagWaiter>>();
	/** Incremented on every didOpen/didChange for a URI; used as freshness barrier. */
	private readonly syncEpoch = new Map<string, number>();
	private readonly lastSeenVersion = new Map<string, number>();

	constructor(
		readable: Readable,
		writable: Writable,
		private readonly options: LspClientOptions,
	) {
		this.workspaceRoot = options.workspaceRoot;
		this.trustedRoot = options.trustedRoot ?? options.workspaceRoot;
		this.connection = new JsonRpcConnection(readable, writable, {
			...options,
			label: options.label ?? "lsp",
			onClose: (error) => this.rejectDiagnosticWaiters(error),
		});
		this.documents.onSync((uri, _version) => {
			this.invalidateDiagnosticsCache(uri);
		});
		this.connection.onNotification("textDocument/publishDiagnostics", (params) => {
			this.handlePublishDiagnostics(params);
		});
		// Ignore common server noise.
		this.connection.onNotification("window/logMessage", () => undefined);
		this.connection.onNotification("window/showMessage", () => undefined);
		this.connection.onNotification("$/typescriptVersion", () => undefined);
		this.connection.onRequest("window/workDoneProgress/create", async () => null);
		this.connection.onRequest("client/registerCapability", async () => null);
		this.connection.onRequest("client/unregisterCapability", async () => null);
		this.connection.onRequest("workspace/configuration", async () => [{}]);
		this.connection.onRequest("workspace/workspaceFolders", async () => [
			{ uri: options.rootUri, name: "workspace" },
		]);
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	get serverCapabilities(): LspServerCapabilities {
		return this.capabilities;
	}

	get name(): string | undefined {
		return this.serverName;
	}

	notify(method: string, params?: unknown): void {
		this.connection.notify(method, params);
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		if (this.initialized) return;
		const result = await this.connection.request<{
			capabilities?: LspServerCapabilities;
			serverInfo?: { name?: string; version?: string };
		}>(
			"initialize",
			{
				processId: process.pid,
				rootUri: this.options.rootUri,
				rootPath: this.workspaceRoot,
				capabilities: {
					workspace: {
						configuration: true,
						workspaceFolders: true,
						applyEdit: false,
					},
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: false },
						hover: { contentFormat: ["markdown", "plaintext"] },
						definition: { linkSupport: false },
						references: {},
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						rename: { prepareSupport: true },
						publishDiagnostics: { relatedInformation: false, versionSupport: true },
						diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
					},
					window: { workDoneProgress: false },
					general: { positionEncodings: ["utf-16"] },
				},
				initializationOptions: this.options.initializationOptions ?? {},
				workspaceFolders: [{ uri: this.options.rootUri, name: "workspace" }],
			},
			{ timeoutMs: this.options.initTimeoutMs ?? INIT_TIMEOUT_MS, signal },
		);

		this.capabilities = result?.capabilities ?? {};
		this.serverName = result?.serverInfo?.name;
		this.connection.notify("initialized", {});
		this.initialized = true;
	}

	async shutdown(signal?: AbortSignal): Promise<void> {
		if (!this.initialized) {
			this.dispose();
			return;
		}
		try {
			this.documents.closeAll(this);
			await this.connection.request("shutdown", undefined, {
				timeoutMs: 5_000,
				signal,
			});
			this.connection.notify("exit");
		} catch {
			// best-effort
		} finally {
			this.dispose();
		}
	}

	dispose(error?: Error): void {
		const crash = error ?? new ProtocolError("LSP client disposed");
		this.documents.clear();
		this.published.clear();
		this.syncEpoch.clear();
		this.lastSeenVersion.clear();
		this.initialized = false;
		for (const [, set] of this.waiters) {
			for (const waiter of set) {
				if (waiter.kind === "error") waiter.wake(crash);
			}
		}
		this.waiters.clear();
		this.connection.dispose(crash);
	}

	private invalidateDiagnosticsCache(uri: string): void {
		const nextEpoch = (this.syncEpoch.get(uri) ?? 0) + 1;
		this.syncEpoch.set(uri, nextEpoch);
		this.published.delete(uri);
	}

	private rejectDiagnosticWaiters(error: Error): void {
		for (const [, set] of this.waiters) {
			for (const waiter of set) {
				if (waiter.kind === "error") waiter.wake(error);
			}
		}
		this.waiters.clear();
	}

	supportsPrepareRename(): boolean {
		const rename = this.capabilities.renameProvider;
		return typeof rename === "object" && rename?.prepareProvider === true;
	}

	supportsPullDiagnostics(): boolean {
		return Boolean(this.capabilities.diagnosticProvider);
	}

	supportsWorkspaceDiagnostics(): boolean {
		const diag = this.capabilities.diagnosticProvider;
		return typeof diag === "object" && diag.workspaceDiagnostics === true;
	}

	async ensureSynced(
		absolutePath: string,
		uri: string,
		signal?: AbortSignal,
	): Promise<{ version: number }> {
		const doc = await this.documents.syncFile(this, absolutePath, uri, signal);
		return { version: doc.version };
	}

	async definition(
		uri: string,
		line: number,
		column: number,
		signal?: AbortSignal,
	): Promise<LocationResult[]> {
		const result = await this.connection.request<unknown>(
			"textDocument/definition",
			{
				textDocument: { uri },
				position: oneBasedToLsp(line, column),
			},
			{ signal, timeoutMs: INDEXING_TIMEOUT_MS },
		);
		return normalizeLocations(result, this.trustedRoot);
	}

	async references(
		uri: string,
		line: number,
		column: number,
		signal?: AbortSignal,
	): Promise<LocationResult[]> {
		const result = await this.connection.request<unknown>(
			"textDocument/references",
			{
				textDocument: { uri },
				position: oneBasedToLsp(line, column),
				context: { includeDeclaration: true },
			},
			{ signal, timeoutMs: INDEXING_TIMEOUT_MS },
		);
		return normalizeLocations(result, this.trustedRoot);
	}

	async hover(uri: string, line: number, column: number, signal?: AbortSignal): Promise<string> {
		const result = await this.connection.request<{ contents?: unknown } | null>(
			"textDocument/hover",
			{
				textDocument: { uri },
				position: oneBasedToLsp(line, column),
			},
			{ signal },
		);
		return renderHoverContents(result?.contents);
	}

	async documentSymbols(uri: string, signal?: AbortSignal): Promise<unknown> {
		return this.connection.request(
			"textDocument/documentSymbol",
			{
				textDocument: { uri },
			},
			{ signal, timeoutMs: INDEXING_TIMEOUT_MS },
		);
	}

	async workspaceSymbols(query: string, signal?: AbortSignal): Promise<unknown> {
		return this.connection.request(
			"workspace/symbol",
			{ query },
			{
				signal,
				timeoutMs: INDEXING_TIMEOUT_MS,
			},
		);
	}

	async prepareRename(
		uri: string,
		line: number,
		column: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.connection.request(
			"textDocument/prepareRename",
			{
				textDocument: { uri },
				position: oneBasedToLsp(line, column),
			},
			{ signal },
		);
	}

	async rename(
		uri: string,
		line: number,
		column: number,
		newName: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.connection.request(
			"textDocument/rename",
			{
				textDocument: { uri },
				position: oneBasedToLsp(line, column),
				newName,
			},
			{ signal, timeoutMs: INDEXING_TIMEOUT_MS },
		);
	}

	async fileDiagnostics(
		uri: string,
		version: number,
		signal?: AbortSignal,
	): Promise<{
		diagnostics: LspDiagnostic[];
		freshness: "fresh" | "stale" | "unavailable";
		note?: string;
	}> {
		const barrierEpoch = this.syncEpoch.get(uri) ?? 0;

		if (this.supportsPullDiagnostics()) {
			try {
				const result = await this.connection.request<{
					kind?: string;
					items?: LspDiagnostic[];
					resultId?: string;
				}>(
					"textDocument/diagnostic",
					{
						textDocument: { uri },
						identifier: "pi",
					},
					{ signal, timeoutMs: DIAGNOSTICS_WAIT_MS },
				);
				if (result?.kind === "unchanged") {
					const cached = this.published.get(uri);
					if (cached && this.isFreshEntry(cached, version, barrierEpoch)) {
						return { diagnostics: cached.diagnostics, freshness: "fresh" };
					}
					return {
						diagnostics: cached?.diagnostics ?? [],
						freshness: cached ? "stale" : "unavailable",
						note: "Pull diagnostics returned kind=unchanged without a fresh cache.",
					};
				}
				const items = Array.isArray(result?.items) ? result.items : [];
				this.published.set(uri, {
					uri,
					version,
					diagnostics: items,
					receivedAt: Date.now(),
					syncEpoch: barrierEpoch,
				});
				this.lastSeenVersion.set(uri, version);
				return { diagnostics: items, freshness: "fresh" };
			} catch (error) {
				if (isAbort(error)) throw error;
				// Fall through to publishDiagnostics wait.
			}
		}

		const cached = this.published.get(uri);
		if (cached && this.isFreshEntry(cached, version, barrierEpoch)) {
			return { diagnostics: cached.diagnostics, freshness: "fresh" };
		}

		try {
			const entry = await this.waitForDiagnostics(
				uri,
				version,
				barrierEpoch,
				DIAGNOSTICS_WAIT_MS,
				signal,
			);
			return { diagnostics: entry.diagnostics, freshness: "fresh" };
		} catch (error) {
			if (isAbort(error)) throw error;
			if (
				error instanceof Error &&
				/disposed|stream ended|exited|closed|EPIPE|crash/i.test(error.message)
			) {
				throw error;
			}
			const stale = this.published.get(uri);
			if (stale) {
				return {
					diagnostics: stale.diagnostics,
					freshness: "stale",
					note:
						`Timed out waiting for diagnostics matching document version ${version}` +
						(stale.version !== undefined
							? ` (have version ${stale.version})`
							: " (unversioned cache)") +
						`.`,
				};
			}
			return {
				diagnostics: [],
				freshness: "unavailable",
				note: `Timed out waiting for diagnostics for version ${version}.`,
			};
		}
	}

	workspaceDiagnosticsUnsupportedMessage(): string {
		return (
			"Workspace diagnostics are unsupported for this server capability set. " +
			"typescript-language-server does not advertise reliable bounded workspace diagnostics " +
			"without opening every project file. Request diagnostics for specific files instead. " +
			"Fall back to the project build or test command for whole-project errors."
		);
	}

	private isFreshEntry(
		entry: PublishedDiagnostics,
		version: number,
		barrierEpoch: number,
	): boolean {
		if (entry.syncEpoch < barrierEpoch) return false;
		if (entry.version === undefined) {
			// Unversioned: current only if received for the latest sync barrier (never pre-sync cache).
			return entry.syncEpoch === barrierEpoch;
		}
		return entry.version === version && entry.syncEpoch >= barrierEpoch;
	}

	private handlePublishDiagnostics(params: unknown): void {
		if (!params || typeof params !== "object") return;
		const body = params as {
			uri?: string;
			version?: number;
			diagnostics?: LspDiagnostic[];
		};
		if (typeof body.uri !== "string" || !Array.isArray(body.diagnostics)) return;
		try {
			assertUriInWorkspace(body.uri, this.trustedRoot);
		} catch {
			return;
		}

		const barrierEpoch = this.syncEpoch.get(body.uri) ?? 0;
		if (typeof body.version === "number") {
			const last = this.lastSeenVersion.get(body.uri);
			if (last !== undefined && body.version < last) {
				return; // out-of-order older version
			}
			const doc = this.documents.get(body.uri);
			if (doc && body.version < doc.version) {
				return; // stale relative to synced document
			}
			this.lastSeenVersion.set(body.uri, body.version);
		}

		const entry: PublishedDiagnostics = {
			uri: body.uri,
			version: body.version,
			diagnostics: body.diagnostics,
			receivedAt: Date.now(),
			syncEpoch: barrierEpoch,
		};
		this.published.set(body.uri, entry);
		const waiters = this.waiters.get(body.uri);
		if (waiters) {
			for (const waiter of waiters) {
				if (waiter.kind === "entry") waiter.wake(entry);
			}
		}
	}

	private waitForDiagnostics(
		uri: string,
		version: number,
		barrierEpoch: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<PublishedDiagnostics> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(abortError(signal));
				return;
			}

			const cached = this.published.get(uri);
			if (cached && this.isFreshEntry(cached, version, barrierEpoch)) {
				resolve(cached);
				return;
			}

			let settled = false;
			const entryWaiter: DiagWaiter = {
				kind: "entry",
				wake: (entry) => {
					if (settled) return;
					if (!this.isFreshEntry(entry, version, barrierEpoch)) return;
					settled = true;
					cleanup();
					resolve(entry);
				},
			};
			const errorWaiter: DiagWaiter = {
				kind: "error",
				wake: (error) => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				},
			};

			let set = this.waiters.get(uri);
			if (!set) {
				set = new Set();
				this.waiters.set(uri, set);
			}
			set.add(entryWaiter);
			set.add(errorWaiter);

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new ProtocolError(`diagnostics wait timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(abortError(signal!));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				set!.delete(entryWaiter);
				set!.delete(errorWaiter);
				if (set!.size === 0) this.waiters.delete(uri);
			};
		});
	}
}

function normalizeLocations(result: unknown, workspaceRoot: string): LocationResult[] {
	if (!result) return [];
	const items = Array.isArray(result) ? result : [result];
	const out: LocationResult[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const rec = item as {
			uri?: string;
			targetUri?: string;
			range?: { start: { line: number; character: number } };
			targetRange?: { start: { line: number; character: number } };
			targetSelectionRange?: { start: { line: number; character: number } };
		};
		const uri = rec.uri ?? rec.targetUri;
		const range = rec.range ?? rec.targetSelectionRange ?? rec.targetRange;
		if (!uri || !range?.start) continue;
		try {
			assertUriInWorkspace(uri, workspaceRoot);
			out.push(locationFromLsp(uri, range, workspaceRoot));
		} catch {
			// skip escapes / non-file
		}
	}
	return out;
}

export function renderHoverContents(contents: unknown): string {
	const MAX_HOVER_NODES = 500;
	const MAX_HOVER_DEPTH = 32;
	const parts: string[] = [];
	const stack: Array<{ value: unknown; depth: number }> = [{ value: contents, depth: 0 }];
	let nodes = 0;

	while (stack.length > 0 && nodes < MAX_HOVER_NODES) {
		const frame = stack.pop()!;
		nodes++;
		const value = frame.value;
		if (value == null) continue;
		if (typeof value === "string") {
			parts.push(capServerString(value, MAX_SERVER_STRING_CHARS));
			continue;
		}
		if (Array.isArray(value)) {
			if (frame.depth >= MAX_HOVER_DEPTH) {
				parts.push("[truncated nested hover]");
				continue;
			}
			// Push in reverse so earlier elements render first.
			for (let i = value.length - 1; i >= 0; i--) {
				stack.push({ value: value[i], depth: frame.depth + 1 });
			}
			continue;
		}
		if (typeof value === "object") {
			const rec = value as { kind?: string; value?: string; language?: string };
			if (typeof rec.value === "string") {
				const body = capServerString(rec.value, MAX_SERVER_STRING_CHARS);
				if (rec.language) {
					parts.push(`\`\`\`${capServerString(String(rec.language), 40)}\n${body}\n\`\`\``);
				} else {
					parts.push(body);
				}
				continue;
			}
			if (frame.depth < MAX_HOVER_DEPTH) {
				for (const nested of Object.values(rec)) {
					if (nested && typeof nested === "object") {
						stack.push({ value: nested, depth: frame.depth + 1 });
					}
				}
			}
			continue;
		}
		parts.push(capServerString(String(value), MAX_SERVER_STRING_CHARS));
	}

	return parts.filter(Boolean).join("\n\n");
}

export function mapDocumentSymbols(
	raw: unknown,
	_workspaceRoot: string,
	_relativePath: string,
): Array<{ name: string; kind?: number; line: number; column: number; children?: unknown[] }> {
	if (!Array.isArray(raw)) return [];

	type Out = { name: string; kind?: number; line: number; column: number; children?: Out[] };
	const MAX_NODES = MAX_SYMBOL_NODES;
	const MAX_DEPTH = MAX_SYMBOL_DEPTH;

	const roots: Out[] = [];
	const stack: Array<{
		items: unknown[];
		index: number;
		depth: number;
		parentChildren: Out[];
	}> = [{ items: raw, index: 0, depth: 0, parentChildren: roots }];
	let nodes = 0;

	while (stack.length > 0 && nodes < MAX_NODES) {
		const frame = stack[stack.length - 1]!;
		if (frame.index >= frame.items.length) {
			stack.pop();
			continue;
		}
		const item = frame.items[frame.index++]!;
		if (!item || typeof item !== "object") continue;
		const rec = item as {
			name?: string;
			kind?: number;
			range?: { start: { line: number; character: number } };
			selectionRange?: { start: { line: number; character: number } };
			location?: { uri?: string; range?: { start: { line: number; character: number } } };
			children?: unknown[];
		};
		if (!rec.name) continue;
		const range = rec.selectionRange ?? rec.range ?? rec.location?.range;
		if (!range?.start) continue;
		const pos = lspPositionToOneBased(range.start);
		const mapped: Out = {
			name: capServerString(String(rec.name), MAX_SYMBOL_NAME_CHARS),
			kind: rec.kind,
			line: pos.line,
			column: pos.column,
		};
		frame.parentChildren.push(mapped);
		nodes++;
		if (
			frame.depth < MAX_DEPTH &&
			Array.isArray(rec.children) &&
			rec.children.length > 0 &&
			nodes < MAX_NODES
		) {
			mapped.children = [];
			stack.push({
				items: rec.children,
				index: 0,
				depth: frame.depth + 1,
				parentChildren: mapped.children,
			});
		}
	}

	return roots;
}

export function mapWorkspaceSymbols(
	raw: unknown,
	workspaceRoot: string,
): Array<{ name: string; kind?: number; path: string; line: number; column: number }> {
	if (!Array.isArray(raw)) return [];
	const out: Array<{ name: string; kind?: number; path: string; line: number; column: number }> =
		[];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const rec = item as {
			name?: string;
			kind?: number;
			location?: { uri?: string; range?: { start: { line: number; character: number } } };
		};
		if (!rec.name || !rec.location?.uri || !rec.location.range?.start) continue;
		try {
			const loc = locationFromLsp(rec.location.uri, rec.location.range, workspaceRoot, {
				includeContext: false,
			});
			out.push({
				name: capServerString(String(rec.name), MAX_SYMBOL_NAME_CHARS),
				kind: rec.kind,
				path: loc.path,
				line: loc.line,
				column: loc.column,
			});
		} catch {
			// skip non-file / escaped URIs
		}
	}
	return out;
}

export function diagnosticsToRows(
	uri: string,
	diagnostics: LspDiagnostic[],
	workspaceRoot: string,
): Array<{
	path: string;
	line: number;
	column: number;
	severity?: number;
	message: string;
	source?: string;
	code?: string | number;
}> {
	let relativePath: string;
	try {
		relativePath = locationFromLsp(uri, { start: { line: 0, character: 0 } }, workspaceRoot, {
			includeContext: false,
		}).path;
	} catch {
		return [];
	}

	return diagnostics.map((d) => {
		const pos = lspPositionToOneBased(d.range.start);
		return {
			path: relativePath,
			line: pos.line,
			column: pos.column,
			severity: d.severity,
			message: d.message,
			source: d.source,
			code: d.code,
		};
	});
}

export {
	formatDiagnostics,
	formatDocumentSymbols,
	formatHover,
	formatLocationList,
	formatWorkspaceSymbols,
	DEFAULT_MAX_RESULTS,
	DEFAULT_DIAGNOSTIC_MAX,
};

export function isJsonRpcMethodMissing(error: unknown): boolean {
	return error instanceof JsonRpcError && error.code === -32601;
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	const error = new Error(reason ? String(reason) : "Aborted");
	error.name = "AbortError";
	return error;
}
