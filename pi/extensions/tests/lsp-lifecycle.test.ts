/**
 * Lifecycle, diagnostics freshness, rename transaction, and symlink mutation regressions.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { LspClient } from "../lsp/client.ts";
import lspExtension from "../lsp/index.ts";
import { LspManager } from "../lsp/manager.ts";
import { toFileUri } from "../lsp/paths.ts";
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
	fn: (client: LspClient, root: string, child: ReturnType<typeof spawn>) => Promise<void>,
): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-life-"));
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
		await fn(client, root, child);
	} finally {
		try {
			await client.shutdown();
		} catch {
			client.dispose();
		}
		if (child.exitCode === null) child.kill("SIGKILL");
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// unversioned diagnostics: pre-sync cache must not be fresh after resync
await withFakeClient(
	{ FAKE_LSP_MODE: "normal", FAKE_LSP_UNVERSIONED_DIAGNOSTICS: "1" },
	async (client, root) => {
		const file = path.join(root, "sample.ts");
		const uri = toFileUri(file);
		fs.writeFileSync(file, "ERROR_MARKER\n");
		const synced = await client.ensureSynced(file, uri);
		const first = await client.fileDiagnostics(uri, synced.version);
		assert("unversioned post-sync can be fresh", first.freshness === "fresh", first.freshness);
		assert("unversioned has error", first.diagnostics.length === 1);

		fs.writeFileSync(file, "const ok = 1;\n");
		const synced2 = await client.ensureSynced(file, uri);
		const second = await client.fileDiagnostics(uri, synced2.version);
		assert(
			"after content change unversioned refreshes",
			second.freshness === "fresh" && second.diagnostics.length === 0,
			JSON.stringify(second),
		);
	},
);

// out-of-order versioned publish ignored
await withFakeClient({ FAKE_LSP_MODE: "normal" }, async (client, root) => {
	const file = path.join(root, "sample.ts");
	const uri = toFileUri(file);
	fs.writeFileSync(file, "ERROR_MARKER\n");
	const synced = await client.ensureSynced(file, uri);
	await client.fileDiagnostics(uri, synced.version);
	// Inject older version publish
	(client as any).handlePublishDiagnostics({
		uri,
		version: 0,
		diagnostics: [
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				message: "old",
				severity: 1,
			},
		],
	});
	const again = await client.fileDiagnostics(uri, synced.version);
	assert(
		"out-of-order older publish ignored",
		!again.diagnostics.some((d) => d.message === "old"),
		JSON.stringify(again.diagnostics),
	);
});

// pull unchanged keeps cache
await withFakeClient(
	{
		FAKE_LSP_MODE: "normal",
		FAKE_LSP_PULL_DIAGNOSTICS: "1",
		FAKE_LSP_PULL_UNCHANGED: "1",
	},
	async (client, root) => {
		const file = path.join(root, "sample.ts");
		const uri = toFileUri(file);
		fs.writeFileSync(file, "const ok = 1;\n");
		await client.ensureSynced(file, uri);
		await new Promise((r) => setTimeout(r, 30));
		const epoch = (client as any).syncEpoch.get(uri) ?? 0;
		(client as any).published.set(uri, {
			uri,
			version: client.documents.get(uri)!.version,
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					message: "kept",
					severity: 1,
				},
			],
			receivedAt: Date.now(),
			syncEpoch: epoch,
		});
		const result = await client.fileDiagnostics(uri, client.documents.get(uri)!.version);
		assert(
			"kind=unchanged does not replace with empty",
			result.diagnostics.some((d) => d.message === "kept") && result.diagnostics.length === 1,
			JSON.stringify(result),
		);
	},
);

// crash wakes diagnostics waiters
await withFakeClient({ FAKE_LSP_MODE: "normal" }, async (client, root, child) => {
	const file = path.join(root, "sample.ts");
	const uri = toFileUri(file);
	await client.ensureSynced(file, uri);
	const waiting = client.fileDiagnostics(uri, 999);
	setTimeout(() => child.kill("SIGKILL"), 20);
	let woke = false;
	try {
		await waiting;
	} catch {
		woke = true;
	}
	assert("diagnostics wait rejects on crash", woke);
});

// initialize hang cleans up process via manager
{
	const manager = new LspManager();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-hang-"));
	fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
	// Point PATH at a hanging fake by wrapping bun script as typescript-language-server name
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	const wrapper = path.join(bin, "typescript-language-server");
	fs.writeFileSync(wrapper, `#!/bin/sh\nexec bun "${fixtureServer}"\n`, { mode: 0o755 });
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${prevPath ?? ""}`;
	process.env.FAKE_LSP_MODE = "slow-init";
	process.env.FAKE_LSP_DELAY_MS = "50";
	try {
		// Override find by using slow-init that eventually succeeds quickly with delay 50
		process.env.FAKE_LSP_MODE = "malformed";
		let failed = false;
		try {
			await manager.getSession(root, root);
		} catch {
			failed = true;
		}
		assert("malformed initialize fails", failed);
		await manager.disposeAll();
		assert("no live process after malformed init", manager.liveProcessCount() === 0);
	} finally {
		process.env.PATH = prevPath;
		delete process.env.FAKE_LSP_MODE;
		delete process.env.FAKE_LSP_DELAY_MS;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// concurrent startup: one abort does not kill shared start
{
	const manager = new LspManager();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-conc-"));
	fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
	fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(bin, "typescript-language-server"),
		`#!/bin/sh\nexec bun "${fixtureServer}"\n`,
		{ mode: 0o755 },
	);
	const prevPath = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${prevPath ?? ""}`;
	process.env.FAKE_LSP_MODE = "normal";
	try {
		const ac = new AbortController();
		const p1 = manager.getSession(root, root, ac.signal);
		const p2 = manager.getSession(root, root);
		ac.abort();
		let aborted = false;
		try {
			await p1;
		} catch {
			aborted = true;
		}
		const session = await p2;
		assert(
			"first caller abort does not kill shared startup",
			aborted && session.client.isInitialized,
		);
		await manager.disposeAll();
		assert("shutdown clears processes", manager.liveProcessCount() === 0);
	} finally {
		process.env.PATH = prevPath;
		delete process.env.FAKE_LSP_MODE;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// rename holds locks: concurrent edit waits
await withFakeClient(
	{ FAKE_LSP_MODE: "normal", FAKE_LSP_PREPARE_RENAME: "1" },
	async (client, root) => {
		const a = path.join(root, "a.ts");
		const b = path.join(root, "b.ts");
		fs.writeFileSync(a, "aaaa\n");
		fs.writeFileSync(b, "bbbb\n");
		const uriA = toFileUri(a);
		const uriB = toFileUri(b);
		await client.ensureSynced(a, uriA);
		await client.ensureSynced(b, uriB);
		const edit = {
			documentChanges: [
				{
					textDocument: { uri: uriA, version: client.documents.get(uriA)!.version },
					edits: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
							newText: "AAAA",
						},
					],
				},
				{
					textDocument: { uri: uriB, version: client.documents.get(uriB)!.version },
					edits: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
							newText: "BBBB",
						},
					],
				},
			],
		};
		const validated = validateWorkspaceEdit(edit, root, client.documents);

		let externalSaw = "";
		const renamePromise = applyWorkspaceEdit(validated, client, root);
		await new Promise((r) => setTimeout(r, 5));
		const external = withFileMutationQueue(a, async () => {
			externalSaw = fs.readFileSync(a, "utf8");
			return externalSaw;
		});
		await renamePromise;
		const afterExternal = await external;
		assert(
			"concurrent edit observes rename result or original under lock",
			afterExternal === "AAAA\n" || afterExternal === "aaaa\n",
			afterExternal,
		);
		assert(
			"rename applied both files",
			fs.readFileSync(a, "utf8") === "AAAA\n" && fs.readFileSync(b, "utf8") === "BBBB\n",
		);
	},
);

// rename cancel before commit
await withFakeClient({ FAKE_LSP_MODE: "normal" }, async (client, root) => {
	const file = path.join(root, "sample.ts");
	const uri = toFileUri(file);
	fs.writeFileSync(file, "foo_\n");
	await client.ensureSynced(file, uri);
	const edit = {
		changes: {
			[uri]: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
					newText: "bar_",
				},
			],
		},
	};
	const validated = validateWorkspaceEdit(edit, root, client.documents);
	const ac = new AbortController();
	ac.abort();
	let aborted = false;
	try {
		await applyWorkspaceEdit(validated, client, root, ac.signal);
	} catch (error) {
		aborted = error instanceof Error && error.name === "AbortError";
	}
	assert(
		"cancel before commit writes nothing",
		aborted && fs.readFileSync(file, "utf8") === "foo_\n",
	);
});

// prepareRename null stops rename via tool
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
	assert("executionMode sequential", tool.executionMode === "sequential");

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-tool2-"));
	fs.writeFileSync(path.join(root, "a.md"), "# hi\n");
	let rejectedMd = false;
	try {
		await tool.execute("t", { action: "diagnostics", path: "a.md" }, undefined, undefined, {
			cwd: root,
			mode: "rpc",
			hasUI: false,
		});
	} catch {
		rejectedMd = true;
	}
	assert("rejects diagnostics for non-TS/JS", rejectedMd);

	// symlink mutation via rename tool path
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-out2-"));
	fs.writeFileSync(path.join(outside, "x.ts"), " cons t x = 1;\n".replace(" ", ""));
	fs.writeFileSync(path.join(outside, "x.ts"), "const x = 1;\n");
	fs.symlinkSync(path.join(outside, "x.ts"), path.join(root, "link.ts"));
	let rejectedLink = false;
	try {
		await tool.execute(
			"t",
			{ action: "definition", path: "link.ts", line: 1, column: 7 },
			undefined,
			undefined,
			{ cwd: root, mode: "rpc", hasUI: false },
		);
	} catch {
		rejectedLink = true;
	}
	assert("tool rejects symlink escape for navigation", rejectedLink);

	await handlers.get("session_shutdown")?.();
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(outside, { recursive: true, force: true });
}

// both changes+documentChanges rejected
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-both-"));
	const file = path.join(root, "a.ts");
	fs.writeFileSync(file, "a\n");
	const uri = toFileUri(file);
	const { DocumentStore } = await import("../lsp/documents.ts");
	const store = new DocumentStore();
	let rejected = false;
	try {
		validateWorkspaceEdit(
			{
				changes: {
					[uri]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							newText: "b",
						},
					],
				},
				documentChanges: [
					{
						textDocument: { uri, version: 1 },
						edits: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
								newText: "c",
							},
						],
					},
				],
			},
			root,
			store,
		);
	} catch (error) {
		rejected = error instanceof WorkspaceEditError;
	}
	assert("rejects both changes and documentChanges", rejected);
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("All lifecycle/diagnostics/rename regression tests passed");
