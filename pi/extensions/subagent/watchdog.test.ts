/**
 * Pure unit tests for StuckDetector.
 *
 * Run: npm run test:extensions
 */
import type { RpcEvent } from "./rpc-client.ts";
import { StuckDetector, type SignalKind } from "./watchdog.ts";

let failed = 0;

function pass(name: string): void {
	console.log(`PASS: ${name}`);
}

function fail(name: string, detail: string): void {
	failed++;
	console.error(`FAIL: ${name}: ${detail}`);
}

function assert(name: string, cond: boolean, detail: string): void {
	if (cond) pass(name);
	else fail(name, detail);
}

function toolStart(id: string, toolName: string, args: unknown): RpcEvent {
	return { type: "tool_execution_start", toolCallId: id, toolName, args };
}

function toolEnd(id: string, toolName: string, isError = false): RpcEvent {
	return {
		type: "tool_execution_end",
		toolCallId: id,
		toolName,
		result: {},
		isError,
	};
}

function assistantEnd(costTotal: number): RpcEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			usage: { cost: { total: costTotal } },
		},
	};
}

function hasKind(kinds: SignalKind[] | undefined, kind: SignalKind): boolean {
	return kinds?.includes(kind) === true;
}

// --- a. Healthy stream -------------------------------------------------------
{
	const name = "a. healthy stream -> undefined";
	const d = new StuckDetector({ silenceMs: 60_000 });
	let t = 1000;
	d.observe(toolStart("c1", "bash", { command: "ls" }), t);
	t += 100;
	d.observe(toolEnd("c1", "bash"), t);
	t += 100;
	d.observe(assistantEnd(0.01), t);
	t += 100;
	d.observe({ type: "agent_settled" }, t);
	const diag = d.evaluate(t + 1000);
	assert(name, diag === undefined, `expected undefined, got ${JSON.stringify(diag)}`);
}

// --- a2. Bounded activity telemetry ------------------------------------------
{
	const name = "a2. activity captures recent tools, failures, and changed files";
	const d = new StuckDetector({ silenceMs: 60_000 });
	let t = 2_000;
	d.observe(toolStart("w1", "write", { path: "/tmp/result.ts" }), t++);
	d.observe(toolEnd("w1", "write"), t++);
	d.observe(toolStart("b1", "bash", { command: "false" }), t++);
	d.observe(toolEnd("b1", "bash", true), t++);
	const activity = d.activity(t);
	assert(
		name,
		activity?.toolCalls === 2 &&
			activity.succeededTools === 1 &&
			activity.failedTools === 1 &&
			activity.changedFiles[0] === "/tmp/result.ts" &&
			activity.recentTools.map((tool) => tool.status).join(",") === "succeeded,failed",
		`activity=${JSON.stringify(activity)}`,
	);
}

// --- b. Silence past threshold -----------------------------------------------
{
	const name = "b. silence past threshold -> SILENCE";
	const d = new StuckDetector({ silenceMs: 5_000 });
	const t0 = 10_000;
	d.observe({ type: "agent_settled" }, t0);
	const diag = d.evaluate(t0 + 5_000);
	assert(
		name,
		diag !== undefined && hasKind(diag.kind, "SILENCE"),
		`expected SILENCE, got ${JSON.stringify(diag)}`,
	);
}

// --- c. STUCK_IN_TOOL, steerable false ---------------------------------------
{
	const name = "c. open tool past threshold -> STUCK_IN_TOOL, steerable=false";
	const d = new StuckDetector({ silenceMs: 5_000 });
	const t0 = 20_000;
	d.observe(toolStart("c1", "bash", { command: "sleep 999" }), t0);
	// Keep events flowing so this is specifically STUCK_IN_TOOL, not only silence.
	// Spec: start with no matching end for silenceMs -- time from start.
	const diag = d.evaluate(t0 + 5_000);
	assert(
		name,
		diag !== undefined && hasKind(diag.kind, "STUCK_IN_TOOL") && diag.steerable === false,
		`expected STUCK_IN_TOOL steerable=false, got ${JSON.stringify(diag)}`,
	);
}

// --- d. Same tool+args 3x -> REPETITION, steerable true ----------------------
{
	const name = "d. same tool+args 3x -> REPETITION, steerable=true";
	const d = new StuckDetector({ silenceMs: 120_000, repeatThreshold: 3 });
	let t = 30_000;
	for (let i = 0; i < 3; i++) {
		d.observe(toolStart(`c${i}`, "bash", { command: "npm test" }), t);
		t += 10;
		d.observe(toolEnd(`c${i}`, "bash"), t);
		t += 10;
		d.observe(assistantEnd(0.01), t);
		t += 10;
	}
	const diag = d.evaluate(t);
	assert(
		name,
		diag !== undefined && hasKind(diag.kind, "REPETITION") && diag.steerable === true,
		`expected REPETITION steerable=true, got ${JSON.stringify(diag)}`,
	);
}

// --- e. Args key order differs still counts as repetition --------------------
{
	const name = "e. args key order differs -> still REPETITION";
	const d = new StuckDetector({ silenceMs: 120_000, repeatThreshold: 3 });
	let t = 40_000;
	const variants = [
		{ a: 1, b: 2 },
		{ b: 2, a: 1 },
		{ a: 1, b: 2 },
	];
	for (let i = 0; i < 3; i++) {
		d.observe(toolStart(`c${i}`, "read", variants[i]), t);
		t += 10;
		d.observe(toolEnd(`c${i}`, "read"), t);
		t += 10;
	}
	const diag = d.evaluate(t);
	assert(
		name,
		diag !== undefined && hasKind(diag.kind, "REPETITION"),
		`expected REPETITION despite key order, got ${JSON.stringify(diag)}`,
	);
}

// --- f. ERROR_STREAK; success resets ----------------------------------------
{
	const name = "f. 3 consecutive isError -> ERROR_STREAK; success resets";
	const d = new StuckDetector({ silenceMs: 120_000, errorStreakThreshold: 3 });
	let t = 50_000;

	for (let i = 0; i < 3; i++) {
		d.observe(toolStart(`e${i}`, "bash", { command: `fail${i}` }), t);
		t += 10;
		d.observe(toolEnd(`e${i}`, "bash", true), t);
		t += 10;
	}
	const streak = d.evaluate(t);
	const streakOk = streak !== undefined && hasKind(streak.kind, "ERROR_STREAK");

	// Reset with a success, then only 2 errors -- should not trip (after ack to clear latch)
	d.ack(t);
	t += 10;
	d.observe(toolStart("ok", "bash", { command: "ok" }), t);
	t += 10;
	d.observe(toolEnd("ok", "bash", false), t);
	t += 10;
	for (let i = 0; i < 2; i++) {
		d.observe(toolStart(`r${i}`, "bash", { command: `r${i}` }), t);
		t += 10;
		d.observe(toolEnd(`r${i}`, "bash", true), t);
		t += 10;
	}
	const afterReset = d.evaluate(t);
	const resetOk = afterReset === undefined || !hasKind(afterReset.kind, "ERROR_STREAK");

	assert(
		name,
		streakOk && resetOk,
		`streak=${JSON.stringify(streak)} afterReset=${JSON.stringify(afterReset)}`,
	);
}

// --- g. Cost over budget -----------------------------------------------------
{
	const name = "g. cost over budget -> BUDGET";
	const d = new StuckDetector({ silenceMs: 120_000, budgetUsd: 0.5 });
	let t = 60_000;
	d.observe(assistantEnd(0.3), t);
	t += 10;
	d.observe(assistantEnd(0.25), t);
	t += 10;
	const diag = d.evaluate(t);
	assert(
		name,
		diag !== undefined && hasKind(diag.kind, "BUDGET") && diag.facts.costUsd === 0.55,
		`expected BUDGET cost=0.55, got ${JSON.stringify(diag)}`,
	);
}

// --- h. Latch: no re-emit; 2x-worse does ------------------------------------
{
	const name = "h. latch: same signal no re-emit; 2x-worse does";
	const d = new StuckDetector({ silenceMs: 5_000 });
	const t0 = 70_000;
	d.observe({ type: "agent_settled" }, t0);

	const first = d.evaluate(t0 + 5_000);
	const firstOk = first !== undefined && hasKind(first.kind, "SILENCE");

	const second = d.evaluate(t0 + 5_000 + 100);
	const secondOk = second === undefined;

	// 2x silence threshold (10s) should re-emit
	const third = d.evaluate(t0 + 10_000);
	const thirdOk = third !== undefined && hasKind(third.kind, "SILENCE");

	assert(
		name,
		firstOk && secondOk && thirdOk,
		`first=${JSON.stringify(first)} second=${JSON.stringify(second)} third=${JSON.stringify(third)}`,
	);
}

// --- i. ack suppresses; lapse re-arms ----------------------------------------
{
	const name = "i. ack() suppresses; lapse re-arms";
	const d = new StuckDetector({ silenceMs: 5_000 });
	const t0 = 80_000;
	d.observe({ type: "agent_settled" }, t0);

	const tripped = d.evaluate(t0 + 5_000);
	const trippedOk = tripped !== undefined && hasKind(tripped.kind, "SILENCE");

	d.ack(t0 + 5_000, { snoozeMs: 3_000 });

	const during = d.evaluate(t0 + 5_000 + 1_000);
	const duringOk = during === undefined;

	// After snooze lapses, silence is still ongoing (>= silenceMs from last event)
	const after = d.evaluate(t0 + 5_000 + 3_000);
	const afterOk = after !== undefined && hasKind(after.kind, "SILENCE");

	assert(
		name,
		trippedOk && duringOk && afterOk,
		`tripped=${JSON.stringify(tripped)} during=${JSON.stringify(during)} after=${JSON.stringify(after)}`,
	);
}

if (failed > 0) {
	console.error(`\n${failed} test(s) failed`);
	process.exit(1);
}
console.log("\nAll tests passed");
