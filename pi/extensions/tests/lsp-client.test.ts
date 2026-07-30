/**
 * Document sync, diagnostics freshness, workspace-edit apply/rollback, extension registration.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LspClient } from "../lsp/client.ts";
import { DocumentStore, hashContent } from "../lsp/documents.ts";
import lspExtension, { LSP_GUIDANCE } from "../lsp/index.ts";
import { LspManager } from "../lsp/manager.ts";
import { toFileUri } from "../lsp/paths.ts";
import { findTypescriptLanguageServer } from "../lsp/servers.ts";
import {
	applyWorkspaceEdit,
	validateWorkspaceEdit,
	WorkspaceEditError,
} from "../lsp/workspace-edit.ts";

function assert(name: string, condition: boolean, details?: string): void {
	if (!condition) throw new Error(`FAIL: ${name}${details ? `\n${details}` : ""}`);
	console.log(`PASS: ${name}`);
}

const fixtureServer = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures/lsp/fake-server.ts",
);

async function withFakeClient(
	env: Record<string, string>,
	fn: (client: LspClient, root: string) => Promise<void>,
): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-client-"));
	fs.writeFileSync(path.join(root, "sample.ts"), "const foo = 1;\n");
	const child = spawn("bun", [fixtureServer], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});
	const client = new LspClient(child.stdout!, child.stdin!, {
		workspaceRoot: root,
		trustedRoot: root,
		rootUri: pathToFileURL(root).href,
		label: "fake-client",
	});
	try {
		await client.initialize();
		await fn(client, root);
	} finally {
		try {
			await client.shutdown();
		} catch {
			client.dispose();
		}
		if (child.exitCode === null) {
			child.kill("SIGKILL");
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// document sync freshness
await withFakeClient({ FAKE_LSP_MODE: "normal" }, async (client, root) => {
	const file = path.join(root, "sample.ts");
	const uri = toFileUri(file);
	const first = await client.ensureSynced(file, uri);
	assert("initial sync version 1", first.version === 1);
	const again = await client.ensureSynced(file, uri);
	assert("unchanged content does not bump version", again.version === 1);

	fs.writeFileSync(file, "const foo = 2;\n");
	const changed = await client.ensureSynced(file, uri);
	assert("disk change bumps version", changed.version === 2);

	const hover = await client.hover(uri, 1, 7);
	assert("hover returns content after sync", hover.includes("fake"));
});

// diagnostics: publishDiagnostics version wait + stale
await withFakeClient({ FAKE_LSP_MODE: "normal" }, async (client, root) => {
	const file = path.join(root, "sample.ts");
	const uri = toFileUri(file);
	fs.writeFileSync(file, "ERROR_MARKER\n");
	const synced = await client.ensureSynced(file, uri);
	const result = await client.fileDiagnostics(uri, synced.version);
	assert("fresh diagnostics after publish", result.freshness === "fresh");
	assert("diagnostics include marker error", result.diagnostics.length === 1);

	fs.writeFileSync(file, "const ok = 1;\n");
	const synced2 = await client.ensureSynced(file, uri);
	const result2 = await client.fileDiagnostics(uri, synced2.version);
	assert("cleared diagnostics when marker removed", result2.diagnostics.length === 0);
});

// pull diagnostics path
await withFakeClient(
	{ FAKE_LSP_MODE: "normal", FAKE_LSP_PULL_DIAGNOSTICS: "1" },
	async (client, root) => {
		assert("advertises pull diagnostics", client.supportsPullDiagnostics());
		const file = path.join(root, "sample.ts");
		const uri = toFileUri(file);
		fs.writeFileSync(file, "ERROR_MARKER\n");
		const synced = await client.ensureSynced(file, uri);
		const result = await client.fileDiagnostics(uri, synced.version);
		assert(
			"pull diagnostics fresh",
			result.freshness === "fresh" && result.diagnostics.length === 1,
		);
	},
);

// workspace diagnostics unsupported message
await withFakeClient({ FAKE_LSP_MODE: "normal" }, async (client) => {
	assert(
		"workspace diagnostics message is actionable",
		client.workspaceDiagnosticsUnsupportedMessage().includes("unsupported"),
	);
});

// rename apply + rollback
await withFakeClient(
	{ FAKE_LSP_MODE: "normal", FAKE_LSP_PREPARE_RENAME: "1" },
	async (client, root) => {
		const file = path.join(root, "sample.ts");
		const uri = toFileUri(file);
		fs.writeFileSync(file, "foo_bar\n");
		await client.ensureSynced(file, uri);
		const edit = await client.rename(uri, 1, 1, "baz_qux");
		const validated = validateWorkspaceEdit(edit, root, client.documents);
		const applied = await applyWorkspaceEdit(validated, client, root);
		assert("rename touches one file", applied.filesTouched === 1);
		assert("file content renamed", fs.readFileSync(file, "utf8").startsWith("baz_qux"));

		// rollback path: force write failure on second file
		const file2 = path.join(root, "other.ts");
		fs.writeFileSync(file2, "aaaa\n");
		const uri2 = toFileUri(file2);
		await client.ensureSynced(file2, uri2);
		const original1 = fs.readFileSync(file, "utf8");
		const badEdit = {
			documentChanges: [
				{
					textDocument: { uri, version: client.documents.get(uri)!.version },
					edits: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
							newText: "changed",
						},
					],
				},
				{
					textDocument: { uri: uri2, version: client.documents.get(uri2)!.version },
					edits: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
							newText: "bbbb",
						},
					],
				},
			],
		};
		const validated2 = validateWorkspaceEdit(badEdit, root, client.documents);
		// Make second path a directory so writeFile fails after first write succeeds.
		fs.rmSync(file2);
		fs.mkdirSync(file2);
		let failed = false;
		try {
			await applyWorkspaceEdit(validated2, client, root);
		} catch {
			failed = true;
		}
		assert("apply fails when a write fails", failed);
		assert(
			"rolls back earlier successful writes",
			fs.readFileSync(file, "utf8") === original1,
			fs.readFileSync(file, "utf8"),
		);
		fs.rmSync(file2, { recursive: true, force: true });
	},
);

// stale version rejection
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-stale-"));
	const file = path.join(root, "a.ts");
	fs.writeFileSync(file, "abc\n");
	const uri = toFileUri(file);
	const store = new DocumentStore();
	const mock = {
		notify() {},
	};
	await store.syncFile(mock, file, uri);
	let stale = false;
	try {
		validateWorkspaceEdit(
			{
				documentChanges: [
					{
						textDocument: { uri, version: 99 },
						edits: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
								newText: "z",
							},
						],
					},
				],
			},
			root,
			store,
		);
	} catch (error) {
		stale = error instanceof WorkspaceEditError && error.message.includes("Stale");
	}
	assert("rejects stale document version", stale);
	fs.rmSync(root, { recursive: true, force: true });
}

// hash helper
assert(
	"hashContent stable",
	hashContent("a") === hashContent("a") && hashContent("a") !== hashContent("b"),
);

// extension registration + missing server status
{
	let tool: any;
	let statusCommand: any;
	const handlers = new Map<string, Function>();
	lspExtension({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerTool: (t: any) => {
			tool = t;
		},
		registerCommand: (name: string, command: any) => {
			if (name === "lsp:status") statusCommand = command;
		},
	} as any);

	assert("registers lsp tool", tool?.name === "lsp");
	assert("registers /lsp:status", statusCommand?.description?.includes("Inspect and stop active"));
	let statusNotification = "";
	await statusCommand.handler("", {
		cwd: process.cwd(),
		ui: {
			notify: (message: string) => {
				statusNotification = message;
			},
		},
	});
	assert("/lsp:status reports server state", statusNotification.includes("server:"));
	const lspStyleCalls: string[] = [];
	const lspTheme = {
		fg: (color: string, text: string) => {
			lspStyleCalls.push(color);
			return text;
		},
		bold: (text: string) => text,
	};
	const failedContext = {
		args: { action: "status" },
		toolCallId: "lsp-failed",
		invalidate: () => undefined,
		state: {},
		executionStarted: true,
		isPartial: false,
		expanded: false,
		isError: true,
	} as any;
	const failedCall = tool.renderCall({ action: "status" }, lspTheme, failedContext);
	const failedResult = tool.renderResult(
		{ content: [{ type: "text", text: "failure" }] },
		{ expanded: false, isPartial: false },
		lspTheme,
		failedContext,
	);
	assert(
		"collapsed LSP call renders action summary",
		failedCall.render(80).join("").includes("lsp status"),
	);
	assert(
		"collapsed LSP failure remains visible",
		failedResult.render(80).join("").includes("× failure"),
	);
	lspStyleCalls.length = 0;
	const successfulLspTheme = {
		fg: (color: string, text: string) => {
			lspStyleCalls.push(color);
			return text;
		},
		bold: (text: string) => text,
	};
	tool.renderResult(
		{ content: [{ type: "text", text: "definition result" }] },
		{ expanded: true, isPartial: false },
		successfulLspTheme,
		{ expanded: true, isError: false },
	);
	assert(
		"successful LSP output uses muted styling",
		lspStyleCalls.includes("muted") && !lspStyleCalls.includes("text"),
		JSON.stringify(lspStyleCalls),
	);
	assert(
		"prompt guidelines mention lsp preference",
		Array.isArray(tool.promptGuidelines) &&
			tool.promptGuidelines.some((g: string) => g.includes("Prefer the lsp tool")),
	);
	assert("exports LSP_GUIDANCE", LSP_GUIDANCE.includes("Prefer the lsp tool"));

	const emit = (event: string, payload: any = {}) => {
		handlers.get(event)?.(payload, {});
	};
	const renderText = (args: any, context: any, width = 120): string =>
		tool.renderCall(args, lspTheme, context).render(width).join("\n");
	const callContext = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
		toolCallId,
		invalidate: () => undefined,
		executionStarted: true,
		expanded: false,
		isError: false,
		...extra,
	});

	emit("session_start");
	emit("tool_execution_start", { toolName: "lsp" });
	const groupedFirst = renderText(
		{ action: "definition", path: "src/first.ts", line: 4, column: 2 },
		callContext("lsp-1"),
	);
	emit("tool_execution_start", { toolName: "lsp" });
	const groupedSecond = renderText(
		{ action: "references", path: "src/second.ts", line: 8, column: 3, query: "needle" },
		callContext("lsp-2"),
	);
	assert(
		"consecutive lsp calls form one exact-name tree",
		groupedFirst.includes("lsp definition") &&
			groupedSecond.split("\n")[0]?.trim() === "lsp" &&
			groupedSecond.includes("├─ definition src/first.ts:4:2") &&
			groupedSecond.includes("└─ references · needle src/second.ts:8:3"),
		JSON.stringify({ groupedFirst, groupedSecond }),
	);

	emit("tool_execution_start", { toolName: "not-lsp" });
	const afterOtherTool = renderText(
		{ action: "hover", path: "src/third.ts", line: 2, column: 1 },
		callContext("lsp-3"),
	);
	assert(
		"a different tool breaks the lsp group",
		afterOtherTool.includes("lsp hover") && !afterOtherTool.includes(" · 3 ·"),
		afterOtherTool,
	);

	const errorArgs = { action: "definition", path: "src/error.ts", line: 1, column: 1 };
	const errorContext = callContext("lsp-error", { isError: true });
	const errorCall = renderText(errorArgs, errorContext);
	const errorResult = tool.renderResult(
		{ content: [{ type: "text", text: "definition failed" }] },
		{ expanded: false, isPartial: false },
		lspTheme,
		errorContext,
	);
	assert(
		"failed lsp calls keep an error subject",
		errorCall.includes("lsp definition") &&
			errorCall.includes("src/error.ts:1:1") &&
			errorResult.render(120).join("\n").includes("× definition failed"),
		JSON.stringify({ errorCall, error: errorResult.render(120) }),
	);

	const expandedCall = renderText(
		{
			action: "workspace_symbols",
			path: "packages/example/src/very-long-symbol-file.ts",
			query: "Widget",
		},
		callContext("lsp-expanded", { expanded: true }),
	);
	assert(
		"expanded lsp calls keep action path and query chrome",
		expandedCall.includes("lsp workspace_symbols") &&
			expandedCall.includes("packages/example/src/very-long-symbol-file.ts") &&
			expandedCall.includes("Widget"),
		expandedCall,
	);

	const lookup = findTypescriptLanguageServer({ PATH: "/nonexistent" });
	assert("missing server detected", lookup.available === false && Boolean(lookup.error));

	const manager = new LspManager();
	const status = manager.statusFor(process.cwd());
	const result = await tool.execute("t1", { action: "status" }, undefined, undefined, {
		cwd: process.cwd(),
		mode: "rpc",
		hasUI: false,
	});
	const text = result.content[0]?.text ?? "";
	assert("status action returns text", text.includes("language:") && text.includes("server:"));
	await handlers.get("session_shutdown")?.();
	await manager.disposeAll();
	void status;
}

// path security via tool
{
	let tool: any;
	const handlers = new Map<string, Function>();
	lspExtension({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerTool: (t: any) => {
			tool = t;
		},
		registerCommand: () => undefined,
	} as any);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-tool-"));
	fs.writeFileSync(path.join(root, "a.ts"), "const x = 1;\n");
	let failed = false;
	try {
		await tool.execute(
			"t2",
			{ action: "definition", path: "../etc/passwd", line: 1, column: 1 },
			undefined,
			undefined,
			{ cwd: root, mode: "rpc", hasUI: false },
		);
	} catch {
		failed = true;
	}
	assert("tool rejects escaped path", failed);
	await handlers.get("session_shutdown")?.();
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("All client/extension tests passed");
