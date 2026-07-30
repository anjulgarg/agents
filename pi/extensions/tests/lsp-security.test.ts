/**
 * Regression: symlink escapes, absolute executable PATH, output bounds, protocol abort cleanup.
 */

import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { encodeMessage, JsonRpcConnection } from "../lsp/protocol.ts";
import {
	PathSecurityError,
	resolveWorkspacePath,
	assertUriInWorkspace,
	fromFileUri,
} from "../lsp/paths.ts";
import { findTypescriptLanguageServer } from "../lsp/servers.ts";
import {
	boundToolOutput,
	flattenSymbolsIterative,
	formatDiagnostics,
	formatHover,
	formatLocationList,
	formatWorkspaceSymbols,
	MAX_SYMBOL_NODES,
	type LocationResult,
} from "../lsp/format.ts";

function assert(name: string, condition: boolean, details?: string): void {
	if (!condition) throw new Error(`FAIL: ${name}${details ? `\n${details}` : ""}`);
	console.log(`PASS: ${name}`);
}

// --- symlink escape ---
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-sym-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-out-"));
	const secret = path.join(outside, "secret.ts");
	fs.writeFileSync(secret, "export const secret = 1;\n");
	const link = path.join(root, "linked.ts");
	fs.symlinkSync(secret, link);
	fs.writeFileSync(path.join(root, "ok.ts"), "export const ok = 1;\n");

	let rejected = false;
	try {
		resolveWorkspacePath("linked.ts", root);
	} catch (error) {
		rejected = error instanceof PathSecurityError;
	}
	assert("rejects workspace symlink to external file", rejected);

	let uriRejected = false;
	try {
		assertUriInWorkspace(pathToFileURL(link).href, root);
	} catch {
		uriRejected = true;
	}
	assert("rejects symlink URI escape", uriRejected);

	const ok = resolveWorkspacePath("ok.ts", root);
	assert("allows normal in-root file", ok.relativePath === "ok.ts" && ok.isRegularFile !== false);

	let authRejected = false;
	try {
		fromFileUri("file://evil.example/etc/passwd");
	} catch {
		authRejected = true;
	}
	assert("rejects file URI authority", authRejected);

	let encodedRejected = false;
	try {
		resolveWorkspacePath("%2e%2e/secret.ts", root);
	} catch {
		encodedRejected = true;
	}
	assert("rejects encoded traversal", encodedRejected);

	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(outside, { recursive: true, force: true });
}

// --- executable absolute realpath ---
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-bin-"));
	const binDir = path.join(root, "bin");
	fs.mkdirSync(binDir);
	const script = path.join(binDir, "typescript-language-server");
	fs.writeFileSync(script, "#!/bin/sh\necho ok\n", { mode: 0o755 });
	const lookup = findTypescriptLanguageServer(
		{ ...process.env, PATH: `bin${path.delimiter}/usr/bin` },
		root,
	);
	assert("finds relative PATH entry", lookup.available === true, lookup.error);
	assert(
		"resolves executable to absolute path",
		Boolean(lookup.executable?.command && path.isAbsolute(lookup.executable.command)),
		lookup.executable?.command,
	);
	assert(
		"realpath is stable under different cwd",
		lookup.executable!.command === fs.realpathSync(script),
	);

	// Spawn using resolved command with a misleading cwd must still run the absolute binary.
	const child = spawn(lookup.executable!.command, ["--help"], {
		cwd: "/tmp",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const code = await new Promise<number | null>((resolve) => {
		child.on("exit", (c) => resolve(c));
		setTimeout(() => {
			child.kill();
			resolve(null);
		}, 2000);
	});
	assert("absolute executable runs with foreign cwd", code !== null);
	fs.rmSync(root, { recursive: true, force: true });
}

// --- output bounds ---
{
	const huge = "x".repeat(100_000);
	const locs: LocationResult[] = [
		{
			path: "a.ts",
			line: 1,
			column: 1,
			context: [`> 1| ${huge}`],
		},
	];
	const text = formatLocationList("definition", locs);
	assert(
		"formatLocationList bounded under 50KB",
		Buffer.byteLength(text, "utf8") <= 50 * 1024 + 200,
		String(Buffer.byteLength(text, "utf8")),
	);
	assert("formatLocationList states truncation", text.includes("truncated"));

	const diag = formatDiagnostics(
		"a.ts",
		[{ path: "a.ts", line: 1, column: 1, severity: 1, message: huge }],
		{ freshness: "fresh" },
	);
	assert("diagnostic messages capped", Buffer.byteLength(diag, "utf8") < 10_000);

	const hover = formatHover({ path: "a.ts", line: 1, column: 1 }, `${"```ts\n"}${huge}${"\n```"}`);
	assert("hover bounded", Buffer.byteLength(hover, "utf8") <= 50 * 1024 + 200);

	const deep: any = { name: "root", kind: 5, line: 1, column: 1, children: [] };
	let cur = deep;
	for (let i = 0; i < 10_000; i++) {
		const child = { name: `n${i}`, kind: 6, line: 1, column: 1, children: [] as any[] };
		cur.children.push(child);
		cur = child;
	}
	const flat = flattenSymbolsIterative([deep]);
	assert("symbol flatten caps nodes", flat.length <= MAX_SYMBOL_NODES);
	assert("deep nesting does not throw", flat.length > 0);

	const ws = formatWorkspaceSymbols([{ name: huge, kind: 12, path: "a.ts", line: 1, column: 1 }], {
		kind: 12,
	});
	assert(
		"workspace symbol names capped and kind filter works",
		ws.includes("function") && !ws.includes(huge.slice(0, 500)),
	);

	const bounded = boundToolOutput(`${"line\n".repeat(5000)}`);
	assert("boundToolOutput enforces line cap", bounded.includes("truncated"));
}

// --- protocol abort listener cleanup ---
{
	const serverToClient = new PassThrough();
	const clientToServer = new PassThrough();
	const conn = new JsonRpcConnection(serverToClient, clientToServer, { label: "abort-cleanup" });
	const ac = new AbortController();
	let listenerCount = 0;
	const originalAdd = ac.signal.addEventListener.bind(ac.signal);
	const originalRemove = ac.signal.removeEventListener.bind(ac.signal);
	ac.signal.addEventListener = ((type: string, listener: any, opts?: any) => {
		if (type === "abort") listenerCount++;
		return originalAdd(type, listener, opts);
	}) as typeof ac.signal.addEventListener;
	ac.signal.removeEventListener = ((type: string, listener: any, opts?: any) => {
		if (type === "abort") listenerCount = Math.max(0, listenerCount - 1);
		return originalRemove(type, listener, opts);
	}) as typeof ac.signal.removeEventListener;

	const pending = conn.request("echo", {}, { signal: ac.signal, timeoutMs: 5_000 });
	await new Promise((r) => setTimeout(r, 10));
	const out = await new Promise<Buffer>((resolve) => {
		clientToServer.once("data", (c) => resolve(Buffer.from(c)));
	});
	const id = Number(/"id":(\d+)/.exec(out.toString("utf8"))![1]);
	serverToClient.write(encodeMessage({ jsonrpc: "2.0", id, result: "ok" }));
	await pending;
	assert("abort listener removed after success", listenerCount === 0, String(listenerCount));

	const pendingErr = conn.request("echo2", {}, { signal: ac.signal, timeoutMs: 5_000 });
	await new Promise((r) => setTimeout(r, 15));
	// Collect recent outbound and respond with error for the latest id
	let latestId = 0;
	const grab = (c: Buffer | string) => {
		const text = Buffer.from(c as Buffer).toString("utf8");
		for (const m of text.matchAll(/"id":(\d+)/g)) latestId = Number(m[1]);
	};
	clientToServer.on("data", grab);
	await new Promise((r) => setTimeout(r, 20));
	clientToServer.off("data", grab);
	// Re-read by issuing and capturing from a dedicated PassThrough is hard; use nextId behavior:
	// We already have latest from first request (id=1). Second request is id=2.
	serverToClient.write(
		encodeMessage({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "nope" } }),
	);
	try {
		await pendingErr;
	} catch {
		// expected
	}
	assert("abort listener removed after JSON-RPC error", listenerCount === 0, String(listenerCount));
	conn.dispose();
}

console.log("All security/bounds/protocol regression tests passed");
