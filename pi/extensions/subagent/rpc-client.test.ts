/**
 * Fast integration test for serializable extension UI projection over RpcChild JSONL.
 *
 * Run: npm run test:extensions
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getSessionArguments, RpcChild, validatePersistentChildSession } from "./rpc-client.ts";

let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
	console.log(
		`${condition ? "PASS" : "FAIL"}: ${name}${condition || !detail ? "" : ` -- ${detail}`}`,
	);
	if (!condition) failed++;
}

check(
	"ephemeral CLI arguments are sessionless",
	JSON.stringify(getSessionArguments(undefined)) === '["--no-session"]',
);
check(
	"persistent CLI arguments carry the exact session",
	JSON.stringify(getSessionArguments({ sessionId: "child-1", sessionDir: "/tmp/child-1" })) ===
		'["--session-id","child-1","--session-dir","/tmp/child-1"]',
);
check(
	"persistent CLI arguments never include no-session",
	!getSessionArguments({ sessionId: "child-1", sessionDir: "/tmp/child-1" }).includes(
		"--no-session",
	),
);
let invalidDescriptorRejected = false;
try {
	validatePersistentChildSession({ sessionId: "child-1", sessionDir: "" });
} catch {
	invalidDescriptorRejected = true;
}
check("incomplete persistent descriptor is rejected", invalidDescriptorRejected);

const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-rpc-ui-test-"));
const fakePi = path.join(dir, "fake-pi.mjs");
const promptFile = path.join(dir, "system.md");
await fs.promises.writeFile(promptFile, "test", "utf8");
await fs.promises.writeFile(
	fakePi,
	`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: "ignore" });
writeFileSync(join(process.cwd(), "grandchild.pid"), String(stubborn.pid));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type !== "prompt") continue;
    console.log(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true }));
    if (command.message === "crash") {
      setTimeout(() => process.exit(7), 10);
      continue;
    }
    setTimeout(() => {
      console.log(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "setStatus", statusKey: "working", statusText: "Indexing files..." }));
      console.log(JSON.stringify({ type: "extension_ui_request", id: "ui-2", method: "setWidget", widgetKey: "queue", widgetLines: ["2 remaining"], widgetPlacement: "belowEditor" }));
      console.log(JSON.stringify({ type: "extension_ui_request", id: "ui-3", method: "notify", message: "Cache miss", notifyType: "warning" }));
      console.log(JSON.stringify({ type: "extension_ui_request", id: "ui-4", method: "setStatus", statusKey: "owner", statusText: process.env.PI_SUBAGENT_OWNER_TOKEN }));
      console.log(JSON.stringify({ type: "agent_settled" }));
    }, 10);
  }
});
`,
	{ encoding: "utf8", mode: 0o755 },
);

const child = new RpcChild({
	cwd: dir,
	model: "test/model",
	thinking: "off",
	tools: ["read"],
	systemPromptFile: promptFile,
	projectTrusted: false,
	ownerToken: "owner-test-token",
	piBin: fakePi,
});

try {
	await child.prompt("test");
	await child.settled();
	const ui = child.uiSnapshot();
	check("captures status", ui.statuses.working === "Indexing files...", JSON.stringify(ui));
	check("captures widget", ui.widgets.queue?.lines[0] === "2 remaining", JSON.stringify(ui));
	check("captures notification", ui.notifications[0]?.type === "warning", JSON.stringify(ui));
	check("passes ownership token", ui.statuses.owner === "owner-test-token", JSON.stringify(ui));
	const grandchildPid = Number(
		await fs.promises.readFile(path.join(dir, "grandchild.pid"), "utf8"),
	);
	const reaped = await child.terminate();
	check(
		"confirms process-group cleanup",
		reaped && child.exited,
		`reaped=${reaped} exited=${child.exited}`,
	);
	let grandchildAlive = true;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			process.kill(grandchildPid, 0);
		} catch {
			grandchildAlive = false;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	check(
		"reaps stubborn grandchildren",
		!grandchildAlive,
		`grandchild pid ${grandchildPid} survived group cleanup`,
	);

	const crashed = new RpcChild({
		cwd: dir,
		model: "test/model",
		thinking: "off",
		tools: ["read"],
		systemPromptFile: promptFile,
		projectTrusted: false,
		ownerToken: "crash-owner-token",
		piBin: fakePi,
	});
	await crashed.prompt("crash");
	const expectedCrash = crashed.settled().catch(() => undefined);
	await crashed.waitForExit();
	await expectedCrash;
	const crashedGrandchildPid = Number(
		await fs.promises.readFile(path.join(dir, "grandchild.pid"), "utf8"),
	);
	const crashReaped = await crashed.terminate();
	let crashedGrandchildAlive = true;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			process.kill(crashedGrandchildPid, 0);
		} catch {
			crashedGrandchildAlive = false;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	check(
		"unexpected leader exit still reaps descendants",
		crashReaped && !crashedGrandchildAlive,
		`reaped=${crashReaped} grandchild=${crashedGrandchildPid}`,
	);
} finally {
	child.kill();
	await child.waitForExit();
	await fs.promises.rm(dir, { recursive: true, force: true });
}

const continuityRoot = await fs.promises.mkdtemp(
	path.join(os.tmpdir(), "pi-rpc-persistent-continuity-"),
);
const continuityPi = path.join(continuityRoot, "continuity-pi.mjs");
const continuityPrompt = path.join(continuityRoot, "system.md");
const continuitySessionDir = path.join(continuityRoot, "child-session");
await fs.promises.writeFile(continuityPrompt, "exact persistent prompt", "utf8");
await fs.promises.writeFile(
	continuityPi,
	`#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const sessionId = args[args.indexOf("--session-id") + 1];
const sessionDir = args[args.indexOf("--session-dir") + 1];
mkdirSync(sessionDir, { recursive: true });
writeFileSync(sessionDir + "/invocation-args.json", JSON.stringify({ sessionId, sessionDir, args }));
const marker = sessionDir + "/first-turn-marker";
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type !== "prompt") continue;
    const retained = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    if (!retained) writeFileSync(marker, "first-turn-marker");
    const text = retained ? "resumed:" + retained : "initial-turn";
    console.log(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true }));
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
  }
});
`,
	{ encoding: "utf8", mode: 0o755 },
);
const persistentDescriptor = { sessionId: "persistent-child-1", sessionDir: continuitySessionDir };
const continuityChildren = [
	new RpcChild({
		cwd: continuityRoot,
		model: "test/model",
		thinking: "off",
		tools: ["read"],
		systemPromptFile: continuityPrompt,
		projectTrusted: false,
		persistentSession: persistentDescriptor,
		piBin: continuityPi,
	}),
	new RpcChild({
		cwd: continuityRoot,
		model: "test/model",
		thinking: "off",
		tools: ["read"],
		systemPromptFile: continuityPrompt,
		projectTrusted: false,
		persistentSession: persistentDescriptor,
		piBin: continuityPi,
	}),
];
try {
	await continuityChildren[0].prompt("first invocation");
	await continuityChildren[0].settled();
	await continuityChildren[1].prompt("second invocation");
	await continuityChildren[1].settled();
	const invocation = JSON.parse(
		await fs.promises.readFile(path.join(continuitySessionDir, "invocation-args.json"), "utf8"),
	);
	check(
		"two persistent RPC processes reuse the exact descriptor",
		invocation.sessionId === persistentDescriptor.sessionId &&
			invocation.sessionDir === persistentDescriptor.sessionDir,
	);
	check(
		"persistent RPC continuity retains the first-turn marker",
		continuityChildren[1].output() === "resumed:first-turn-marker",
		continuityChildren[1].output(),
	);
	check(
		"persistent RPC usage is per invocation",
		continuityChildren[0].usage.input === 7 &&
			continuityChildren[1].usage.input === 7 &&
			continuityChildren[1].usage.turns === 1,
		JSON.stringify({ first: continuityChildren[0].usage, second: continuityChildren[1].usage }),
	);
} finally {
	for (const continuityChild of continuityChildren) {
		await continuityChild.terminate();
	}
	await fs.promises.rm(continuityRoot, { recursive: true, force: true });
}

console.log(
	failed === 0 ? "\nAll RPC UI bridge tests passed" : `\n${failed} RPC UI bridge test(s) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
