import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message, Usage } from "@earendil-works/pi-ai";

import {
	cumulativePersistentUsage,
	loadPersistentThreadHistory,
	mergePersistentMessages,
} from "./session-history.ts";

let failed = 0;

function check(name: string, condition: boolean, details = ""): void {
	if (condition) console.log(`PASS: ${name}`);
	else {
		failed++;
		console.error(`FAIL: ${name}${details ? `\n  ${details}` : ""}`);
	}
}

function usage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "subagent-session-history-"));
const cwd = path.join(root, "workspace");
const sessionDir = path.join(root, "sessions");
await fs.promises.mkdir(cwd);

try {
	const sessionId = "persistent-child-history";
	const manager = SessionManager.create(cwd, sessionDir, { id: sessionId });
	const firstUser: Message = { role: "user", content: "first prompt", timestamp: 100 };
	const firstAssistant: Message = {
		role: "assistant",
		content: [{ type: "text", text: "first answer" }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: usage(10, 2, 0.01),
		stopReason: "stop",
		timestamp: 200,
	};
	const nestedTool: Message = {
		role: "toolResult",
		toolCallId: "nested-1",
		toolName: "nested",
		content: [{ type: "text", text: "nested result" }],
		usage: usage(5, 1, 0.02),
		isError: false,
		timestamp: 300,
	};
	const secondUser: Message = { role: "user", content: "second prompt", timestamp: 400 };
	const secondAssistant: Message = {
		role: "assistant",
		content: [{ type: "text", text: "second answer" }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: usage(20, 4, 0.03),
		stopReason: "stop",
		timestamp: 500,
	};
	for (const message of [firstUser, firstAssistant, nestedTool, secondUser, secondAssistant]) {
		manager.appendMessage(message);
	}

	const history = await loadPersistentThreadHistory({ sessionId, sessionDir });
	check(
		"loads every message from the durable persistent child branch",
		history?.messages.length === 5 &&
			history.messages[0]?.role === "user" &&
			history.messages[0].content === "first prompt" &&
			history.messages.at(-1)?.role === "assistant",
		JSON.stringify(history?.messages.map((message) => message.role)),
	);
	const cumulative = cumulativePersistentUsage(history?.messages ?? []);
	check(
		"reconstructs cumulative turns, tokens, nested usage, and cost",
		cumulative.turns === 2 &&
			cumulative.input === 35 &&
			cumulative.output === 7 &&
			Math.abs(cumulative.cost - 0.06) < 1e-9,
		JSON.stringify(cumulative),
	);

	const liveAssistant: Message = {
		...secondAssistant,
		content: [{ type: "text", text: "second answer updated live" }],
	};
	const thirdAssistant: Message = {
		...secondAssistant,
		content: [{ type: "text", text: "third answer" }],
		usage: usage(30, 6, 0.04),
		timestamp: 600,
	};
	const merged = mergePersistentMessages(history?.messages ?? [], [liveAssistant, thirdAssistant]);
	const mergedUsage = cumulativePersistentUsage(merged);
	check(
		"merges live resumed events without duplicating durable messages",
		merged.length === 6 &&
			mergedUsage.turns === 3 &&
			mergedUsage.input === 65 &&
			mergedUsage.output === 13 &&
			Math.abs(mergedUsage.cost - 0.1) < 1e-9,
		JSON.stringify({ roles: merged.map((message) => message.role), usage: mergedUsage }),
	);
} finally {
	await fs.promises.rm(root, { recursive: true, force: true });
}

if (failed > 0) {
	console.error(`\n${failed} failing`);
	process.exitCode = 1;
} else console.log("\nAll subagent session-history tests passed.");
