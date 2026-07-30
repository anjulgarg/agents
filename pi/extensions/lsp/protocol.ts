/**
 * Bounded JSON-RPC 2.0 over LSP Content-Length framing (stdio).
 * Node built-ins only; independently testable with any Duplex/Readable/Writable pair.
 */

import type { Readable, Writable } from "node:stream";

export const DEFAULT_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcFailure {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	error: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export class JsonRpcError extends Error {
	readonly code: number;
	readonly data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "JsonRpcError";
		this.code = code;
		this.data = data;
	}
}

export class ProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProtocolError";
	}
}

export interface EncodeOptions {
	maxMessageBytes?: number;
}

/** Encode one LSP-framed JSON-RPC message. */
export function encodeMessage(message: JsonRpcMessage, options: EncodeOptions = {}): Buffer {
	const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
	const body = Buffer.from(JSON.stringify(message), "utf8");
	if (body.byteLength > maxMessageBytes) {
		throw new ProtocolError(
			`Outgoing JSON-RPC message exceeds max size (${body.byteLength} > ${maxMessageBytes})`,
		);
	}
	const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8");
	return Buffer.concat([header, body]);
}

export interface FrameParseState {
	buffer: Buffer;
	maxMessageBytes: number;
	maxBufferBytes: number;
}

export type FrameParseResult =
	| { kind: "need_more"; state: FrameParseState }
	| { kind: "message"; message: JsonRpcMessage; state: FrameParseState }
	| { kind: "error"; error: ProtocolError; state: FrameParseState };

/** Append bytes and try to parse one framed message. May be called repeatedly. */
export function parseFrames(state: FrameParseState, chunk: Buffer): FrameParseResult {
	let buffer = Buffer.concat([state.buffer, chunk]);
	if (buffer.byteLength > state.maxBufferBytes) {
		return {
			kind: "error",
			error: new ProtocolError(
				`Incoming buffer exceeds max size (${buffer.byteLength} > ${state.maxBufferBytes})`,
			),
			state: { ...state, buffer: Buffer.alloc(0) },
		};
	}

	const headerEnd = buffer.indexOf("\r\n\r\n");
	if (headerEnd < 0) {
		return { kind: "need_more", state: { ...state, buffer } };
	}

	const headerText = buffer.subarray(0, headerEnd).toString("utf8");
	const lengthMatch = /^Content-Length:\s*(\d+)\s*$/im.exec(headerText);
	if (!lengthMatch) {
		return {
			kind: "error",
			error: new ProtocolError(
				`Missing or invalid Content-Length header: ${headerText.slice(0, 120)}`,
			),
			state: { ...state, buffer: Buffer.alloc(0) },
		};
	}

	const contentLength = Number(lengthMatch[1]);
	if (!Number.isInteger(contentLength) || contentLength < 0) {
		return {
			kind: "error",
			error: new ProtocolError(`Invalid Content-Length: ${lengthMatch[1]}`),
			state: { ...state, buffer: Buffer.alloc(0) },
		};
	}
	if (contentLength > state.maxMessageBytes) {
		return {
			kind: "error",
			error: new ProtocolError(
				`Incoming JSON-RPC message exceeds max size (${contentLength} > ${state.maxMessageBytes})`,
			),
			state: { ...state, buffer: Buffer.alloc(0) },
		};
	}

	const bodyStart = headerEnd + 4;
	const bodyEnd = bodyStart + contentLength;
	if (buffer.byteLength < bodyEnd) {
		return { kind: "need_more", state: { ...state, buffer } };
	}

	const body = buffer.subarray(bodyStart, bodyEnd);
	const rest = buffer.subarray(bodyEnd);
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.toString("utf8"));
	} catch (error) {
		return {
			kind: "error",
			error: new ProtocolError(
				`Malformed JSON-RPC body: ${error instanceof Error ? error.message : String(error)}`,
			),
			state: { ...state, buffer: rest },
		};
	}

	if (!isJsonRpcMessage(parsed)) {
		return {
			kind: "error",
			error: new ProtocolError("Parsed JSON is not a JSON-RPC 2.0 message"),
			state: { ...state, buffer: rest },
		};
	}

	return {
		kind: "message",
		message: parsed,
		state: { ...state, buffer: rest },
	};
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
	if (!value || typeof value !== "object") return false;
	const msg = value as Record<string, unknown>;
	if (msg.jsonrpc !== "2.0") return false;
	if (typeof msg.method === "string") {
		return msg.id === undefined || typeof msg.id === "number" || typeof msg.id === "string";
	}
	if ("result" in msg || "error" in msg) {
		return msg.id === null || typeof msg.id === "number" || typeof msg.id === "string";
	}
	return false;
}

export interface RequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface JsonRpcConnectionOptions {
	maxMessageBytes?: number;
	maxBufferBytes?: number;
	defaultTimeoutMs?: number;
	/** Optional label for error messages. */
	label?: string;
	/** Called once when the connection fails or is disposed. */
	onClose?: (error: Error) => void;
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
};

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (params: unknown) => Promise<unknown> | unknown;

/**
 * Bidirectional JSON-RPC connection with Content-Length framing,
 * concurrent request IDs, cancellation, and bounded buffering.
 */
export class JsonRpcConnection {
	private readonly writable: Writable;
	private readonly maxMessageBytes: number;
	private readonly maxBufferBytes: number;
	private readonly defaultTimeoutMs: number;
	private readonly label: string;
	private readonly onClose?: (error: Error) => void;
	private readonly pending = new Map<string, Pending>();
	private closeNotified = false;
	private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
	private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
	private frameState: FrameParseState;
	private nextId = 1;
	private closed = false;
	private fatalError: Error | undefined;
	private readonly onData: (chunk: Buffer | string) => void;
	private readonly onReadableError: (error: Error) => void;
	private readonly onWritableError: (error: Error) => void;
	private readonly onReadableEnd: () => void;

	constructor(
		private readonly readable: Readable,
		writable: Writable,
		options: JsonRpcConnectionOptions = {},
	) {
		this.writable = writable;
		this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.label = options.label ?? "json-rpc";
		this.onClose = options.onClose;
		this.frameState = {
			buffer: Buffer.alloc(0),
			maxMessageBytes: this.maxMessageBytes,
			maxBufferBytes: this.maxBufferBytes,
		};

		this.onData = (chunk) => {
			const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			this.ingest(buf);
		};
		this.onReadableError = (error) => this.failAll(error);
		this.onWritableError = (error) => this.failAll(error);
		this.onReadableEnd = () => this.failAll(new ProtocolError(`${this.label} stream ended`));

		this.readable.on("data", this.onData);
		this.readable.on("error", this.onReadableError);
		this.readable.on("end", this.onReadableEnd);
		this.writable.on("error", this.onWritableError);
	}

	get isClosed(): boolean {
		return this.closed;
	}

	onNotification(method: string, handler: NotificationHandler): () => void {
		let set = this.notificationHandlers.get(method);
		if (!set) {
			set = new Set();
			this.notificationHandlers.set(method, set);
		}
		set.add(handler);
		return () => set!.delete(handler);
	}

	onRequest(method: string, handler: ServerRequestHandler): void {
		this.serverRequestHandlers.set(method, handler);
	}

	async request<T = unknown>(
		method: string,
		params?: unknown,
		options: RequestOptions = {},
	): Promise<T> {
		if (this.closed) {
			throw this.fatalError ?? new ProtocolError(`${this.label} connection is closed`);
		}
		if (options.signal?.aborted) {
			throw abortError(options.signal);
		}

		const id = this.nextId++;
		const key = String(id);
		const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

		const result = await new Promise<unknown>((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
			const pending: Pending = { resolve, reject, signal: options.signal };

			const clear = () => clearPending(pending);

			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					this.pending.delete(key);
					clear();
					try {
						this.notify("$/cancelRequest", { id });
					} catch {
						// connection may already be closed
					}
					reject(new ProtocolError(`${this.label} request timed out: ${method} (${timeoutMs}ms)`));
				}, timeoutMs);
			}

			if (options.signal) {
				pending.onAbort = () => {
					this.pending.delete(key);
					clear();
					try {
						this.notify("$/cancelRequest", { id });
					} catch {
						// ignore
					}
					reject(abortError(options.signal!));
				};
				options.signal.addEventListener("abort", pending.onAbort, { once: true });
			}

			this.pending.set(key, pending);
			try {
				this.write(message);
			} catch (error) {
				this.pending.delete(key);
				clear();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});

		return result as T;
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		this.write({ jsonrpc: "2.0", method, params } satisfies JsonRpcNotification);
	}

	/** Reject pending requests and detach listeners. Idempotent. */
	dispose(error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.fatalError = error ?? this.fatalError;
		this.readable.off("data", this.onData);
		this.readable.off("error", this.onReadableError);
		this.readable.off("end", this.onReadableEnd);
		this.writable.off("error", this.onWritableError);
		this.failAll(error ?? new ProtocolError(`${this.label} connection disposed`));
	}

	private write(message: JsonRpcMessage): void {
		if (this.closed) {
			throw new ProtocolError(`${this.label} connection is closed`);
		}
		const framed = encodeMessage(message, { maxMessageBytes: this.maxMessageBytes });
		const ok = this.writable.write(framed);
		if (!ok) {
			// Backpressure: wait briefly; LSP stdio is typically fast enough.
			// Callers still get errors via the writable "error" handler.
		}
	}

	private ingest(chunk: Buffer): void {
		if (this.closed) return;
		let current = chunk;
		for (;;) {
			const result = parseFrames(this.frameState, current);
			current = Buffer.alloc(0);
			this.frameState = result.state;
			if (result.kind === "need_more") return;
			if (result.kind === "error") {
				this.failAll(result.error);
				return;
			}
			void this.dispatch(result.message);
			if (this.frameState.buffer.byteLength === 0) return;
			// More complete frames may remain in the buffer; re-parse with empty chunk.
		}
	}

	private async dispatch(message: JsonRpcMessage): Promise<void> {
		if ("method" in message && message.method) {
			if ("id" in message && message.id !== undefined) {
				const handler = this.serverRequestHandlers.get(message.method);
				if (!handler) {
					this.safeWrite({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: `Method not found: ${message.method}` },
					});
					return;
				}
				try {
					const result = await handler(message.params);
					this.safeWrite({ jsonrpc: "2.0", id: message.id, result });
				} catch (error) {
					this.safeWrite({
						jsonrpc: "2.0",
						id: message.id,
						error: {
							code: -32000,
							message: error instanceof Error ? error.message : String(error),
						},
					});
				}
				return;
			}

			const handlers = this.notificationHandlers.get(message.method);
			if (handlers) {
				for (const handler of handlers) {
					try {
						handler(message.params);
					} catch {
						// Notification handlers must not break the connection.
					}
				}
			}
			return;
		}

		if (!("id" in message) || message.id === null || message.id === undefined) return;
		const pending = this.pending.get(String(message.id));
		if (!pending) return;
		this.pending.delete(String(message.id));
		clearPending(pending);
		if ("error" in message && message.error) {
			pending.reject(
				new JsonRpcError(message.error.code, message.error.message, message.error.data),
			);
			return;
		}
		pending.resolve("result" in message ? message.result : undefined);
	}

	private safeWrite(message: JsonRpcMessage): void {
		if (this.closed) return;
		try {
			this.write(message);
		} catch {
			// Connection closed between check and write; ignore.
		}
	}

	private failAll(error: Error): void {
		this.fatalError = error;
		const pending = [...this.pending.entries()];
		this.pending.clear();
		for (const [, entry] of pending) {
			clearPending(entry);
			entry.reject(error);
		}
		if (!this.closed) {
			this.closed = true;
			this.readable.off("data", this.onData);
			this.readable.off("error", this.onReadableError);
			this.readable.off("end", this.onReadableEnd);
			this.writable.off("error", this.onWritableError);
		}
		if (!this.closeNotified) {
			this.closeNotified = true;
			try {
				this.onClose?.(error);
			} catch {
				// ignore
			}
		}
	}
}

function clearPending(pending: Pending): void {
	if (pending.timer) {
		clearTimeout(pending.timer);
		pending.timer = undefined;
	}
	if (pending.signal && pending.onAbort) {
		pending.signal.removeEventListener("abort", pending.onAbort);
		pending.onAbort = undefined;
	}
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	const error = new Error(reason ? String(reason) : "Aborted");
	error.name = "AbortError";
	return error;
}
