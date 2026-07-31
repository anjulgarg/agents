/**
 * Fast integration test for serializable extension UI projection over RpcChild JSONL.
 *
 * Run: npm run test:extensions
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	getSessionArguments,
	RpcChild,
	validateContextUsageSnapshot,
	validatePersistentChildSession,
} from "./rpc-client.ts";

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

// --------------------------------------------------------------------------
// Context telemetry: get_session_stats over the correlated RPC command channel.
// --------------------------------------------------------------------------
const validSnapshot = { tokens: 168000, contextWindow: 258000, percent: 65.11627906976744 };
const fullStatsResponse = {
	sessionFile: "/private/child-session.json",
	sessionId: "child-1",
	userMessages: 3,
	assistantMessages: 2,
	toolCalls: 4,
	toolResults: 4,
	totalMessages: 9,
	tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
	cost: 0.5,
	contextUsage: validSnapshot,
};
check(
	"context snapshot accepts finite non-negative values",
	JSON.stringify(validateContextUsageSnapshot(validSnapshot)) === JSON.stringify(validSnapshot),
	JSON.stringify(validateContextUsageSnapshot(validSnapshot)),
);
check(
	"context snapshot accepts unknown tokens and percent",
	JSON.stringify(
		validateContextUsageSnapshot({ tokens: null, contextWindow: 258000, percent: null }),
	) === '{"tokens":null,"contextWindow":258000,"percent":null}',
	JSON.stringify(
		validateContextUsageSnapshot({ tokens: null, contextWindow: 258000, percent: null }),
	),
);
check(
	"context validation rejects NaN, negative, and malformed values",
	[
		{ tokens: Number.NaN, contextWindow: 258000, percent: 0 },
		{ tokens: 1, contextWindow: Number.POSITIVE_INFINITY, percent: 0 },
		{ tokens: 1, contextWindow: 258000, percent: -1 },
		{ tokens: 1, contextWindow: -258000, percent: 0 },
		{ tokens: "100", contextWindow: 258000, percent: 0 },
		{ tokens: 1, contextWindow: 258000 },
		null,
		"garbage",
	].every((candidate) => validateContextUsageSnapshot(candidate) === undefined),
	"at least one malformed candidate was accepted",
);

const statsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-rpc-stats-test-"));
const statsPi = path.join(statsDir, "stats-pi.mjs");
const statsPrompt = path.join(statsDir, "system.md");
await fs.promises.writeFile(statsPrompt, "test", "utf8");
await fs.promises.writeFile(
	statsPi,
	`#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      console.log(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true }));
      console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }));
      console.log(JSON.stringify({ type: "agent_settled" }));
      continue;
    }
    if (command.type === "get_session_stats") {
      const config = JSON.parse(readFileSync(join(process.cwd(), "stats-config.json"), "utf8"));
      const entry = config.byId?.[command.id] ?? config.default ?? {};
      const delay = entry.delay ?? 0;
      const respond = () => {
        if (entry.success === false) {
          console.log(JSON.stringify({ type: "response", id: command.id, command: "get_session_stats", success: false, error: entry.error ?? "unsupported command" }));
          return;
        }
        console.log(JSON.stringify({ type: "response", id: command.id, command: "get_session_stats", success: true, data: entry.data ?? {} }));
      };
      if (delay > 0) setTimeout(respond, delay); else respond();
      continue;
    }
    console.log(JSON.stringify({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported" }));
  }
});
`,
	{ encoding: "utf8", mode: 0o755 },
);
const writeStatsConfig = (config: unknown) =>
	fs.promises.writeFile(path.join(statsDir, "stats-config.json"), JSON.stringify(config), "utf8");
const statsChildOptions = {
	cwd: statsDir,
	model: "test/model",
	thinking: "off" as const,
	tools: ["read"],
	systemPromptFile: statsPrompt,
	projectTrusted: false,
	piBin: statsPi,
};

await writeStatsConfig({ default: { data: fullStatsResponse } });
const statsChild = new RpcChild(statsChildOptions);
try {
	const snapshot = await statsChild.refreshSessionStats();
	check(
		"stats happy path exposes validated context occupancy",
		snapshot?.tokens === 168000 &&
			snapshot.contextWindow === 258000 &&
			Math.abs((snapshot.percent ?? 0) - 65.116) < 0.01,
		JSON.stringify(snapshot),
	);
	const copy = statsChild.contextSnapshot();
	check(
		"contextSnapshot returns a defensive copy",
		copy !== undefined &&
			copy !== snapshot &&
			JSON.stringify(copy) === JSON.stringify(validSnapshot),
		JSON.stringify(copy),
	);
	copy!.tokens = 1;
	check(
		"mutating the exposed copy never changes the child snapshot",
		statsChild.contextSnapshot()?.tokens === 168000,
		JSON.stringify(statsChild.contextSnapshot()),
	);
	check(
		"context refresh never changes cumulative UsageStats",
		statsChild.usage.input === 0 &&
			statsChild.usage.output === 0 &&
			statsChild.usage.turns === 0 &&
			statsChild.usage.cost === 0,
		JSON.stringify(statsChild.usage),
	);
	const exposed = JSON.stringify(statsChild.contextSnapshot());
	check(
		"snapshot carries exactly tokens/contextWindow/percent and no sessionFile or full stats",
		Object.keys(statsChild.contextSnapshot()!).sort().join(",") ===
			"contextWindow,percent,tokens" &&
			!exposed.includes("sessionFile") &&
			!exposed.includes("userMessages") &&
			!exposed.includes("cost"),
		exposed,
	);
} finally {
	await statsChild.terminate();
}

await writeStatsConfig({
	byId: {
		"cmd-1": {
			delay: 60,
			data: { contextUsage: { tokens: 1000, contextWindow: 258000, percent: 0.4 } },
		},
		"cmd-2": {
			delay: 10,
			data: { contextUsage: { tokens: 2000, contextWindow: 258000, percent: 0.8 } },
		},
	},
});
const orderChild = new RpcChild(statsChildOptions);
try {
	const first = orderChild.refreshSessionStats();
	const second = orderChild.refreshSessionStats();
	const [firstResult, secondResult] = await Promise.all([first, second]);
	check(
		"reverse-order refresh responses keep only the newest snapshot",
		orderChild.contextSnapshot()?.tokens === 2000 &&
			firstResult?.tokens === 2000 &&
			secondResult?.tokens === 2000 &&
			orderChild.contextSnapshot()?.tokens !== 1000,
		`first=${JSON.stringify(firstResult)} second=${JSON.stringify(secondResult)} latest=${JSON.stringify(orderChild.contextSnapshot())}`,
	);
} finally {
	await orderChild.terminate();
}

await writeStatsConfig({
	byId: {
		"cmd-1": { data: { contextUsage: { tokens: 168000, contextWindow: 258000, percent: 65.1 } } },
		"cmd-2": { data: { contextUsage: { tokens: null, contextWindow: 258000, percent: null } } },
	},
});
const compactChild = new RpcChild(statsChildOptions);
try {
	await compactChild.refreshSessionStats();
	const afterCompaction = await compactChild.refreshSessionStats();
	check(
		"post-compaction unknown tokens replace the previous known occupancy",
		afterCompaction?.tokens === null &&
			afterCompaction.contextWindow === 258000 &&
			afterCompaction.percent === null &&
			compactChild.contextSnapshot()?.tokens === null &&
			compactChild.contextSnapshot()?.contextWindow === 258000,
		JSON.stringify(afterCompaction),
	);
} finally {
	await compactChild.terminate();
}

const failureCases: Array<{ name: string; config: unknown }> = [
	{
		name: "unsupported stats command leaves context unavailable",
		config: { default: { success: false, error: "unsupported command" } },
	},
	{
		name: "negative stats values are rejected without persisting",
		config: {
			default: { data: { contextUsage: { tokens: 100, contextWindow: 258000, percent: -1 } } },
		},
	},
	{
		name: "missing contextUsage keeps sessionFile out of the projection",
		config: { default: { data: { sessionFile: "/private/session.json" } } },
	},
	{
		name: "structural garbage stats are rejected",
		config: { default: { data: { contextUsage: { tokens: "many", contextWindow: 0 } } } },
	},
];
const failingChild = new RpcChild(statsChildOptions);
try {
	for (const { name, config } of failureCases) {
		await writeStatsConfig(config);
		const snapshot = await failingChild.refreshSessionStats();
		check(
			name,
			snapshot === undefined && failingChild.contextSnapshot() === undefined,
			JSON.stringify({ snapshot, stored: failingChild.contextSnapshot() }),
		);
	}
} finally {
	await failingChild.terminate();
}
await fs.promises.rm(statsDir, { recursive: true, force: true });

console.log(
	failed === 0 ? "\nAll RPC UI bridge tests passed" : `\n${failed} RPC UI bridge test(s) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
