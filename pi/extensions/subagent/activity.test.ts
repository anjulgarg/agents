/** Pure unit tests for bounded subagent activity telemetry. */
import type { RpcEvent } from "./rpc-client.ts";
import {
	ActivityTracker,
	MAX_CHANGED_FILES,
	MAX_RECENT_TOOL_ERRORS,
	MAX_RECENT_TOOLS,
} from "./activity.ts";

let failed = 0;

function assert(name: string, condition: boolean, detail: string): void {
	if (condition) console.log(`PASS: ${name}`);
	else {
		failed++;
		console.error(`FAIL: ${name}: ${detail}`);
	}
}

function toolStart(id: string, toolName: string, args: unknown): RpcEvent {
	return { type: "tool_execution_start", toolCallId: id, toolName, args };
}

function toolEnd(id: string, toolName: string, isError = false): RpcEvent {
	return {
		type: "tool_execution_end",
		toolCallId: id,
		toolName,
		result: isError ? { message: "failed lookup" } : {},
		isError,
	};
}

{
	const name = "activity is absent before the first RPC event";
	const tracker = new ActivityTracker();
	assert(name, tracker.activity(1_000) === undefined, JSON.stringify(tracker.activity(1_000)));
}

{
	const name = "activity captures tool outcomes, mutation targets, and event age";
	const tracker = new ActivityTracker();
	let now = 2_000;
	tracker.observe(toolStart("w1", "write", { path: "/tmp/result.ts" }), now++);
	tracker.observe(toolEnd("w1", "write"), now++);
	tracker.observe(toolStart("b1", "bash", { command: "false" }), now++);
	tracker.observe(toolEnd("b1", "bash", true), now++);
	const activity = tracker.activity(now + 20);
	assert(
		name,
		activity?.toolCalls === 2 &&
			activity.succeededTools === 1 &&
			activity.failedTools === 1 &&
			activity.changedFiles[0] === "/tmp/result.ts" &&
			activity.recentTools.map((tool) => tool.status).join(",") === "succeeded,failed" &&
			activity.silentMs === 21,
		`activity=${JSON.stringify(activity)}`,
	);
}

{
	const name = "activity telemetry is bounded";
	const tracker = new ActivityTracker();
	let now = 3_000;
	for (let index = 0; index < 14; index++) {
		const id = `w${index}`;
		tracker.observe(toolStart(id, "write", { path: `/tmp/file-${index}.ts` }), now++);
		tracker.observe(toolEnd(id, "write", index >= 9), now++);
	}
	const activity = tracker.activity(now);
	assert(
		name,
		activity?.recentTools.length === MAX_RECENT_TOOLS &&
			activity.recentErrors.length === MAX_RECENT_TOOL_ERRORS &&
			activity.changedFiles.length === MAX_CHANGED_FILES &&
			activity.consecutiveToolFailures === 5,
		`activity=${JSON.stringify(activity)}`,
	);
}

{
	const name = "assistant usage accumulates without classifying health";
	const tracker = new ActivityTracker();
	tracker.observe(
		{
			type: "message_end",
			message: { role: "assistant", usage: { output: 80, cost: { total: 0.1 } } },
		},
		4_000,
	);
	tracker.observe(
		{
			type: "message_end",
			message: { role: "assistant", usage: { output: 20, cost: { total: 0.05 } } },
		},
		4_001,
	);
	const activity = tracker.activity(4_002);
	assert(
		name,
		activity?.turns === 2 &&
			activity.outputTokens === 100 &&
			Math.abs(activity.costUsd - 0.15) < 0.000001,
		`activity=${JSON.stringify(activity)}`,
	);
}

if (failed > 0) {
	console.error(`\n${failed} failure(s)`);
	process.exit(1);
}
console.log("\nAll tests passed.");
