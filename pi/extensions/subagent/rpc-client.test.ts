/**
 * Fast integration test for serializable extension UI projection over RpcChild JSONL.
 *
 * Run: npm run test:extensions
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RpcChild } from "./rpc-client.ts";

let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
	console.log(
		`${condition ? "PASS" : "FAIL"}: ${name}${condition || !detail ? "" : ` -- ${detail}`}`,
	);
	if (!condition) failed++;
}

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

console.log(
	failed === 0 ? "\nAll RPC UI bridge tests passed" : `\n${failed} RPC UI bridge test(s) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
