#!/usr/bin/env bun
/**
 * Controllable fake LSP server for tests.
 * Speaks Content-Length JSON-RPC on stdio.
 *
 * Env:
 *   FAKE_LSP_MODE = normal | slow-init | crash-after-init | hang-request | oversized | malformed
 *   FAKE_LSP_DELAY_MS = delay before responding to requests (default 0)
 *   FAKE_LSP_PULL_DIAGNOSTICS = 1 to advertise pull diagnostics
 *   FAKE_LSP_WORKSPACE_DIAGNOSTICS = 1 to advertise workspace diagnostics
 *   FAKE_LSP_PREPARE_RENAME = 1 to advertise prepareProvider
 */

type JsonRpcId = number | string;

const mode = process.env.FAKE_LSP_MODE ?? "normal";
const delayMs = Number(process.env.FAKE_LSP_DELAY_MS ?? "0");
const pullDiagnostics = process.env.FAKE_LSP_PULL_DIAGNOSTICS === "1";
const workspaceDiagnostics = process.env.FAKE_LSP_WORKSPACE_DIAGNOSTICS === "1";
const prepareRename = process.env.FAKE_LSP_PREPARE_RENAME === "1";
const unversionedDiagnostics = process.env.FAKE_LSP_UNVERSIONED_DIAGNOSTICS === "1";
const pullUnchanged = process.env.FAKE_LSP_PULL_UNCHANGED === "1";
const prepareRenameNull = process.env.FAKE_LSP_PREPARE_RENAME_NULL === "1";

let buffer = Buffer.alloc(0);
const docs = new Map<string, { version: number; text: string }>();
let nextDiagVersion = new Map<string, number>();

function writeMessage(message: unknown): void {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
	process.stdout.write(body);
}

function respond(id: JsonRpcId, result: unknown): void {
	writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id: JsonRpcId, code: number, message: string): void {
	writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params: unknown): void {
	writeMessage({ jsonrpc: "2.0", method, params });
}

async function handle(message: Record<string, unknown>): Promise<void> {
	const method = message.method as string | undefined;
	const id = message.id as JsonRpcId | undefined;

	if (method === "initialize" && id !== undefined) {
		if (mode === "slow-init") {
			await sleep(Number(process.env.FAKE_LSP_DELAY_MS ?? "60_000"));
		}
		if (mode === "oversized") {
			const huge = "x".repeat(3 * 1024 * 1024);
			process.stdout.write(`Content-Length: ${huge.length}\r\n\r\n${huge}`);
			return;
		}
		if (mode === "malformed") {
			process.stdout.write("Content-Length: 5\r\n\r\n{not");
			return;
		}
		respond(id, {
			capabilities: {
				textDocumentSync: 1,
				hoverProvider: true,
				definitionProvider: true,
				referencesProvider: true,
				documentSymbolProvider: true,
				workspaceSymbolProvider: true,
				renameProvider: prepareRename ? { prepareProvider: true } : true,
				diagnosticProvider: pullDiagnostics
					? { interFileDependencies: false, workspaceDiagnostics }
					: undefined,
			},
			serverInfo: { name: "fake-lsp", version: "0.0.1" },
		});
		if (mode === "crash-after-init") {
			setTimeout(() => process.exit(2), 20);
		}
		return;
	}

	if (method === "initialized") return;
	if (method === "shutdown" && id !== undefined) {
		respond(id, null);
		return;
	}
	if (method === "exit") {
		process.exit(0);
	}
	if (method === "$/cancelRequest") return;

	if (delayMs > 0) await sleep(delayMs);
	if (mode === "hang-request" && id !== undefined && method !== "shutdown") {
		await sleep(60_000);
		return;
	}

	if (method === "textDocument/didOpen") {
		const params = message.params as {
			textDocument: { uri: string; version: number; text: string };
		};
		docs.set(params.textDocument.uri, {
			version: params.textDocument.version,
			text: params.textDocument.text,
		});
		publishDiagnostics(params.textDocument.uri, params.textDocument.version);
		return;
	}

	if (method === "textDocument/didChange") {
		const params = message.params as {
			textDocument: { uri: string; version: number };
			contentChanges: Array<{ text: string }>;
		};
		const text = params.contentChanges[0]?.text ?? "";
		docs.set(params.textDocument.uri, { version: params.textDocument.version, text });
		publishDiagnostics(params.textDocument.uri, params.textDocument.version);
		return;
	}

	if (method === "textDocument/didClose") {
		const params = message.params as { textDocument: { uri: string } };
		docs.delete(params.textDocument.uri);
		return;
	}

	if (id === undefined) return;

	if (method === "textDocument/definition") {
		const params = message.params as {
			textDocument: { uri: string };
			position: { line: number; character: number };
		};
		respond(id, {
			uri: params.textDocument.uri,
			range: {
				start: params.position,
				end: { line: params.position.line, character: params.position.character + 1 },
			},
		});
		return;
	}

	if (method === "textDocument/references") {
		const params = message.params as {
			textDocument: { uri: string };
			position: { line: number; character: number };
		};
		respond(id, [
			{
				uri: params.textDocument.uri,
				range: {
					start: params.position,
					end: { line: params.position.line, character: params.position.character + 1 },
				},
			},
		]);
		return;
	}

	if (method === "textDocument/hover") {
		respond(id, {
			contents: { kind: "markdown", value: "```ts\nconst fake: number\n```" },
		});
		return;
	}

	if (method === "textDocument/documentSymbol") {
		const params = message.params as { textDocument: { uri: string } };
		respond(id, [
			{
				name: "fakeFn",
				kind: 12,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
				selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
				children: [],
			},
			{
				name: "dup",
				kind: 13,
				location: {
					uri: params.textDocument.uri,
					range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
				},
			},
		]);
		return;
	}

	if (method === "workspace/symbol") {
		const params = message.params as { query: string };
		const uri = [...docs.keys()][0] ?? "file:///tmp/fake.ts";
		respond(id, [
			{
				name: params.query || "sym",
				kind: 12,
				location: {
					uri,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
				},
			},
		]);
		return;
	}

	if (method === "textDocument/diagnostic") {
		const params = message.params as { textDocument: { uri: string } };
		if (pullUnchanged) {
			respond(id, { kind: "unchanged" });
			return;
		}
		const doc = docs.get(params.textDocument.uri);
		respond(id, {
			kind: "full",
			items: buildDiagnostics(params.textDocument.uri, doc?.text ?? ""),
		});
		return;
	}

	if (method === "textDocument/prepareRename") {
		if (prepareRenameNull) {
			respond(id, null);
			return;
		}
		const params = message.params as { position: { line: number; character: number } };
		respond(id, {
			range: {
				start: params.position,
				end: { line: params.position.line, character: params.position.character + 4 },
			},
			placeholder: "fake",
		});
		return;
	}

	if (method === "textDocument/rename") {
		const params = message.params as {
			textDocument: { uri: string };
			position: { line: number; character: number };
			newName: string;
		};
		const doc = docs.get(params.textDocument.uri);
		respond(id, {
			documentChanges: [
				{
					textDocument: { uri: params.textDocument.uri, version: doc?.version ?? 1 },
					edits: [
						{
							range: {
								start: params.position,
								end: {
									line: params.position.line,
									character: params.position.character + 4,
								},
							},
							newText: params.newName,
						},
					],
				},
			],
		});
		return;
	}

	if (method === "workspace/diagnostic") {
		respondError(id, -32601, "Method not found");
		return;
	}

	respondError(id, -32601, `Method not found: ${method}`);
}

function publishDiagnostics(uri: string, version: number): void {
	const doc = docs.get(uri);
	const items = buildDiagnostics(uri, doc?.text ?? "");
	nextDiagVersion.set(uri, version);
	if (unversionedDiagnostics) {
		notify("textDocument/publishDiagnostics", { uri, diagnostics: items });
		return;
	}
	notify("textDocument/publishDiagnostics", { uri, version, diagnostics: items });
}

function buildDiagnostics(uri: string, text: string): unknown[] {
	if (!text.includes("ERROR_MARKER")) return [];
	return [
		{
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 5 },
			},
			severity: 1,
			source: "fake",
			message: `error in ${uri}`,
		},
	];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString("utf8");
		const match = /Content-Length:\s*(\d+)/i.exec(header);
		if (!match) {
			buffer = Buffer.alloc(0);
			return;
		}
		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		const bodyEnd = bodyStart + length;
		if (buffer.byteLength < bodyEnd) return;
		const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
		buffer = buffer.subarray(bodyEnd);
		try {
			const message = JSON.parse(body) as Record<string, unknown>;
			void handle(message);
		} catch {
			// ignore malformed inbound in fake server
		}
	}
});

// Keep alive
process.stdin.resume();
