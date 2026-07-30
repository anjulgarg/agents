/**
 * Final narrow regressions: mode preservation, hard links, deep nesting, URI security, error bounds.
 */

import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
	LspClient,
	mapDocumentSymbols,
	mapWorkspaceSymbols,
	renderHoverContents,
} from "../lsp/client.ts";
import { DocumentStore } from "../lsp/documents.ts";
import { locationFromLsp } from "../lsp/format.ts";
import lspExtension from "../lsp/index.ts";
import { PathSecurityError, toFileUri } from "../lsp/paths.ts";
import {
	applyWorkspaceEdit,
	RenameRecoveryError,
	validateWorkspaceEdit,
	WorkspaceEditError,
} from "../lsp/workspace-edit.ts";

function assert(name: string, condition: boolean, details?: string): void {
	if (!condition) throw new Error(`FAIL: ${name}${details ? `\n${details}` : ""}`);
	console.log(`PASS: ${name}`);
}

function makeClient(root: string): LspClient {
	const readable = new PassThrough();
	const writable = new PassThrough();
	writable.on("data", () => undefined);
	return new LspClient(readable, writable, {
		workspaceRoot: root,
		trustedRoot: root,
		rootUri: pathToFileURL(root).href,
	});
}

// --- mode preservation ---
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-mode-"));
	const file = path.join(root, "x.js");
	fs.writeFileSync(file, "#!/usr/bin/env node\nconsole.log(1)\n", { mode: 0o755 });
	assert("fixture starts executable", (fs.statSync(file).mode & 0o777) === 0o755);

	const uri = toFileUri(file);
	const client = makeClient(root);
	await client.documents.syncFile(client, file, uri);
	const validated = validateWorkspaceEdit(
		{
			changes: {
				[uri]: [
					{
						range: { start: { line: 1, character: 0 }, end: { line: 1, character: 14 } },
						newText: "console.log(2)",
					},
				],
			},
		},
		root,
		client.documents,
	);
	await applyWorkspaceEdit(validated, client, root);
	assert(
		"atomic rename preserves executable mode",
		(fs.statSync(file).mode & 0o777) === 0o755,
		(fs.statSync(file).mode & 0o777).toString(8),
	);
	client.dispose();
	fs.rmSync(root, { recursive: true, force: true });
}

// --- hard-link / duplicate physical target rejection ---
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-hl-"));
	const a = path.join(root, "a.ts");
	const b = path.join(root, "b.ts");
	fs.writeFileSync(a, "const x = 1;\n");
	fs.linkSync(a, b);
	const store = new DocumentStore();
	let rejected = false;
	try {
		validateWorkspaceEdit(
			{
				changes: {
					[toFileUri(a)]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							newText: "let x",
						},
					],
				},
			},
			root,
			store,
		);
	} catch (error) {
		rejected = error instanceof WorkspaceEditError && /hard-link/i.test(error.message);
	}
	assert("rejects hard-linked mutation target", rejected);

	const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-dup-"));
	const p1 = path.join(root2, "p1.ts");
	const p2 = path.join(root2, "p2.ts");
	fs.writeFileSync(p1, "aaaa\n");
	fs.linkSync(p1, p2);
	let rejectedDup = false;
	try {
		validateWorkspaceEdit(
			{
				changes: {
					[toFileUri(p1)]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
							newText: "bbbb",
						},
					],
					[toFileUri(p2)]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
							newText: "cccc",
						},
					],
				},
			},
			root2,
			store,
		);
	} catch (error) {
		rejectedDup = error instanceof WorkspaceEditError;
	}
	assert("rejects duplicate physical inode targets", rejectedDup);
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(root2, { recursive: true, force: true });
}

// --- same-path inode swap rejection ---
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-ino-"));
	const file = path.join(root, "swap.ts");
	fs.writeFileSync(file, "old\n");
	const uri = toFileUri(file);
	const client = makeClient(root);
	await client.documents.syncFile(client, file, uri);
	const validated = validateWorkspaceEdit(
		{
			changes: {
				[uri]: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
						newText: "new",
					},
				],
			},
		},
		root,
		client.documents,
	);
	const other = path.join(root, "other.ts");
	fs.writeFileSync(other, "old\n");
	fs.renameSync(other, file);
	let rejectedSwap = false;
	try {
		await applyWorkspaceEdit(validated, client, root);
	} catch (error) {
		rejectedSwap =
			error instanceof Error &&
			(/Inode identity changed|Canonical path changed|TOCTOU/i.test(error.message) ||
				error.name === "PathSecurityError");
	}
	assert("rejects same-path inode swap", rejectedSwap, "expected identity mismatch error");
	client.dispose();
	fs.rmSync(root, { recursive: true, force: true });
}

// --- unknown rollback content is not clobbered ---
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-unc-"));
	const a = path.join(root, "a.ts");
	const b = path.join(root, "b.ts");
	fs.writeFileSync(a, "aaaa\n");
	fs.writeFileSync(b, "bbbb\n");
	const uriA = toFileUri(a);
	const uriB = toFileUri(b);
	const client = makeClient(root);
	await client.documents.syncFile(client, a, uriA);
	await client.documents.syncFile(client, b, uriB);
	const validated = validateWorkspaceEdit(
		{
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
		},
		root,
		client.documents,
	);

	const writeFile = fs.promises.writeFile.bind(fs.promises);
	fs.promises.writeFile = (async (p: any, data: any, opts?: any) => {
		if (typeof data === "string" && data === "BBBB\n" && String(p).includes(".pi-lsp-rename-")) {
			if (fs.readFileSync(a, "utf8") === "AAAA\n") {
				fs.writeFileSync(a, "WEIRD\n");
			}
			throw new Error("forced second write failure");
		}
		return writeFile(p, data, opts);
	}) as typeof fs.promises.writeFile;

	let recovery = false;
	let keptWeird = false;
	try {
		await applyWorkspaceEdit(validated, client, root);
	} catch (error) {
		recovery = error instanceof RenameRecoveryError;
		keptWeird = fs.readFileSync(a, "utf8") === "WEIRD\n";
	} finally {
		fs.promises.writeFile = writeFile;
	}
	assert("rollback reports recovery-required for unknown content", recovery);
	assert("does not clobber unknown rollback content", keptWeird);
	client.dispose();
	fs.rmSync(root, { recursive: true, force: true });
}

// --- deep nesting: no stack overflow ---
{
	const depth = 20_000;
	let node: any = {
		name: "leaf",
		kind: 13,
		selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	};
	for (let i = 0; i < depth; i++) {
		node = {
			name: `n${i}`,
			kind: 5,
			selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			children: [node],
		};
	}
	let mapErr: unknown;
	try {
		mapDocumentSymbols([node], "/tmp", "a.ts");
	} catch (error) {
		mapErr = error;
	}
	assert("mapDocumentSymbols handles 20k depth", !mapErr, String(mapErr));

	let hover: any = { value: "x" };
	for (let i = 0; i < depth; i++) hover = [hover];
	let hoverErr: unknown;
	try {
		renderHoverContents(hover);
	} catch (error) {
		hoverErr = error;
	}
	assert("renderHoverContents handles 20k depth", !hoverErr, String(hoverErr));
}

// --- workspace symbol URI security ---
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-wsuri-"));
	fs.writeFileSync(path.join(root, "ok.ts"), "export {}\n");
	let nonFile = false;
	try {
		locationFromLsp("/etc/passwd", { start: { line: 0, character: 0 } }, root, {
			includeContext: false,
		});
	} catch (error) {
		nonFile = error instanceof PathSecurityError;
	}
	assert("locationFromLsp rejects non-file URI string", nonFile);

	const mapped = mapWorkspaceSymbols(
		[
			{
				name: "evil",
				kind: 12,
				location: {
					uri: "https://evil.example/x",
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				},
			},
			{
				name: "ok",
				kind: 12,
				location: {
					uri: toFileUri(path.join(root, "ok.ts")),
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				},
			},
		],
		root,
	);
	assert(
		"mapWorkspaceSymbols skips non-file and keeps in-root",
		mapped.length === 1 && mapped[0]!.name === "ok",
		JSON.stringify(mapped),
	);

	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-wsout-"));
	fs.writeFileSync(path.join(outside, "secret.ts"), "export const s = 1;\n");
	fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "link.ts"));
	const escaped = mapWorkspaceSymbols(
		[
			{
				name: "secret",
				kind: 13,
				location: {
					uri: toFileUri(path.join(root, "link.ts")),
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				},
			},
		],
		root,
	);
	assert("mapWorkspaceSymbols skips symlink escape", escaped.length === 0);
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(outside, { recursive: true, force: true });
}

// --- bounded thrown tool errors ---
{
	let tool: any;
	lspExtension({
		on() {},
		registerTool: (t: any) => {
			tool = t;
		},
		registerCommand: () => undefined,
	} as any);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-err-"));
	fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
	const huge = Array.from(
		{ length: 3_000 },
		(_, i) => `json-rpc error line ${i} ${"x".repeat(40)}`,
	).join("\n");

	const { LspManager } = await import("../lsp/manager.ts");
	const original = LspManager.prototype.getSession;
	LspManager.prototype.getSession = async () => {
		throw new Error(huge);
	};
	let thrown = "";
	try {
		await tool.execute(
			"t",
			{ action: "hover", path: "a.ts", line: 1, column: 1 },
			undefined,
			undefined,
			{ cwd: root, mode: "rpc", hasUI: false },
		);
	} catch (error) {
		thrown = error instanceof Error ? error.message : String(error);
	} finally {
		LspManager.prototype.getSession = original;
	}
	assert(
		"thrown tool errors are bounded",
		Buffer.byteLength(thrown, "utf8") <= 50 * 1024 + 500,
		String(Buffer.byteLength(thrown, "utf8")),
	);
	assert("bounded error states truncation", thrown.includes("truncated"));
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("All final narrow regression tests passed");
