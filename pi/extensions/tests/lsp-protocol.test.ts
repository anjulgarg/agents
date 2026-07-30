/**
 * JSON-RPC / LSP framing tests with PassThrough streams and the fake server.
 */

import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	encodeMessage,
	parseFrames,
	JsonRpcConnection,
	ProtocolError,
	DEFAULT_MAX_MESSAGE_BYTES,
} from "../lsp/protocol.ts";

function assert(name: string, condition: boolean, details?: string): void {
	if (!condition) throw new Error(`FAIL: ${name}${details ? `\n${details}` : ""}`);
	console.log(`PASS: ${name}`);
}

const fixtureServer = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures/lsp/fake-server.ts",
);

// --- encode / parse ---

{
	const msg = { jsonrpc: "2.0" as const, id: 1, method: "initialize", params: {} };
	const framed = encodeMessage(msg);
	const text = framed.toString("utf8");
	assert("encode includes Content-Length header", text.startsWith("Content-Length:"));
	assert("encode includes body separator", text.includes("\r\n\r\n"));
}

{
	const a = encodeMessage({ jsonrpc: "2.0", id: 1, result: "one" });
	const b = encodeMessage({ jsonrpc: "2.0", method: "ping", params: { n: 2 } });
	const combined = Buffer.concat([a, b]);
	let state = {
		buffer: Buffer.alloc(0),
		maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
		maxBufferBytes: 4 * 1024 * 1024,
	};
	const first = parseFrames(state, combined);
	assert("parse first of multiple frames", first.kind === "message");
	state = first.state;
	const second = parseFrames(state, Buffer.alloc(0));
	assert("parse second remaining frame", second.kind === "message");
}

{
	const full = encodeMessage({ jsonrpc: "2.0", id: 7, result: { ok: true } });
	const mid = Math.floor(full.byteLength / 2);
	let state = {
		buffer: Buffer.alloc(0),
		maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
		maxBufferBytes: 4 * 1024 * 1024,
	};
	const part1 = parseFrames(state, full.subarray(0, mid));
	assert("split frame needs more", part1.kind === "need_more");
	state = part1.state;
	const part2 = parseFrames(state, full.subarray(mid));
	assert(
		"split frame completes",
		part2.kind === "message" &&
			part2.kind === "message" &&
			"result" in part2.message &&
			(part2.message as { id: number }).id === 7,
	);
}

{
	let state = {
		buffer: Buffer.alloc(0),
		maxMessageBytes: 64,
		maxBufferBytes: 4 * 1024 * 1024,
	};
	const oversized = Buffer.from("Content-Length: 1000\r\n\r\n" + "x".repeat(100), "utf8");
	const result = parseFrames(state, oversized);
	assert("oversized message rejected", result.kind === "error");
}

{
	let state = {
		buffer: Buffer.alloc(0),
		maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
		maxBufferBytes: 4 * 1024 * 1024,
	};
	const bad = Buffer.from("Content-Length: 4\r\n\r\n{not", "utf8");
	const result = parseFrames(state, bad);
	assert("malformed JSON rejected", result.kind === "error");
}

// --- connection correlation / cancel / timeout ---

{
	const serverToClient = new PassThrough();
	const clientToServer = new PassThrough();
	const conn = new JsonRpcConnection(serverToClient, clientToServer, {
		defaultTimeoutMs: 2_000,
		label: "test",
	});

	const chunks: Buffer[] = [];
	clientToServer.on("data", (c) => chunks.push(Buffer.from(c)));

	const pending = conn.request("echo", { n: 1 });
	await new Promise((r) => setTimeout(r, 10));
	const outbound = Buffer.concat(chunks).toString("utf8");
	assert("request writes framed JSON-RPC", outbound.includes('"method":"echo"'));

	const idMatch = /"id":(\d+)/.exec(outbound);
	assert("request has id", Boolean(idMatch));
	const id = Number(idMatch![1]);
	serverToClient.write(encodeMessage({ jsonrpc: "2.0", id, result: { n: 1 } }));
	const result = await pending;
	assert("correlates response by id", (result as { n: number }).n === 1);

	const idA = { current: 0 };
	const idB = { current: 0 };
	const reqA = conn.request("a", {});
	const reqB = conn.request("b", {});
	await new Promise((r) => setTimeout(r, 20));
	const out2 = Buffer.concat(chunks).toString("utf8");
	const methodIds: Array<{ method: string; id: number }> = [];
	for (const match of out2.matchAll(/\{"jsonrpc":"2\.0","id":(\d+),"method":"([ab])"/g)) {
		methodIds.push({ id: Number(match[1]), method: match[2]! });
	}
	assert("captured two concurrent request ids", methodIds.length >= 2, out2);
	const a = methodIds.find((m) => m.method === "a")!;
	const b = methodIds.find((m) => m.method === "b")!;
	idA.current = a.id;
	idB.current = b.id;
	serverToClient.write(encodeMessage({ jsonrpc: "2.0", id: idB.current, result: "second" }));
	serverToClient.write(encodeMessage({ jsonrpc: "2.0", id: idA.current, result: "first" }));
	const [ra, rb] = await Promise.all([reqA, reqB]);
	assert("concurrent out-of-order responses", ra === "first" && rb === "second", `${ra},${rb}`);

	conn.dispose();
}

{
	const serverToClient = new PassThrough();
	const clientToServer = new PassThrough();
	const conn = new JsonRpcConnection(serverToClient, clientToServer, {
		defaultTimeoutMs: 50,
		label: "timeout-test",
	});
	let sawCancel = false;
	clientToServer.on("data", (c) => {
		if (Buffer.from(c).toString("utf8").includes("$/cancelRequest")) sawCancel = true;
	});
	let rejected: Error | undefined;
	try {
		await conn.request("slow", {});
	} catch (error) {
		rejected = error as Error;
	}
	assert(
		"request timeout rejects",
		rejected instanceof ProtocolError && rejected.message.includes("timed out"),
		rejected?.message,
	);
	assert("timeout sends cancel notification", sawCancel);
	conn.dispose();
}

{
	const serverToClient = new PassThrough();
	const clientToServer = new PassThrough();
	const conn = new JsonRpcConnection(serverToClient, clientToServer, {
		defaultTimeoutMs: 5_000,
		label: "abort-test",
	});
	const ac = new AbortController();
	const pending = conn.request("x", {}, { signal: ac.signal });
	ac.abort();
	let rejected: Error | undefined;
	try {
		await pending;
	} catch (error) {
		rejected = error as Error;
	}
	assert("abort signal cancels request", rejected?.name === "AbortError", rejected?.message);
	conn.dispose();
}

{
	const serverToClient = new PassThrough();
	const clientToServer = new PassThrough();
	const conn = new JsonRpcConnection(serverToClient, clientToServer, { label: "notify-test" });
	let seen: unknown;
	conn.onNotification("hello", (params) => {
		seen = params;
	});
	serverToClient.write(encodeMessage({ jsonrpc: "2.0", method: "hello", params: { ok: true } }));
	await new Promise((r) => setTimeout(r, 10));
	assert("notification delivered", (seen as { ok: boolean })?.ok === true);
	conn.dispose();
}

{
	const serverToClient = new PassThrough();
	const clientToServer = new PassThrough();
	const conn = new JsonRpcConnection(serverToClient, clientToServer, { label: "crash-test" });
	const pending = conn.request("x", {}, { timeoutMs: 5_000 });
	serverToClient.destroy(new Error("boom"));
	let rejected: Error | undefined;
	try {
		await pending;
	} catch (error) {
		rejected = error as Error;
	}
	assert("stream error fails pending requests", Boolean(rejected), rejected?.message);
	conn.dispose();
}

// --- fake server process: shutdown ---

{
	const child = spawn("bun", [fixtureServer], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, FAKE_LSP_MODE: "normal" },
	});
	const conn = new JsonRpcConnection(child.stdout!, child.stdin!, {
		label: "fake",
		defaultTimeoutMs: 5_000,
	});
	const init = await conn.request<{ capabilities: object }>("initialize", {
		processId: null,
		rootUri: null,
		capabilities: {},
	});
	assert("fake server initializes", Boolean(init.capabilities));
	conn.notify("initialized", {});
	await conn.request("shutdown", null);
	conn.notify("exit");
	const code = await new Promise<number | null>((resolve) => {
		child.on("exit", (c) => resolve(c));
		setTimeout(() => {
			child.kill("SIGKILL");
			resolve(null);
		}, 2000);
	});
	conn.dispose();
	assert("fake server exits after shutdown", code === 0, `code=${code}`);
}

console.log("All protocol tests passed");
