/**
 * End-to-end: real Supervisor driving real `pi --mode rpc` children.
 *
 * The unit suites use fake children, so they prove the wake logic but not that it fires
 * against a live child. This closes that gap: real spawn, real agent_settled, real wake,
 * real kill. Makes real LLM calls.
 *
 * Run: npx tsx pi/extensions/subagent/supervisor.e2e.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RpcChild } from "./rpc-client.ts";
import { Supervisor } from "./supervisor.ts";

const MODEL = "openai-codex/gpt-5.6-luna";
const TIMEOUT_MS = 180_000;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : ` -- ${detail}`}`);
	if (!ok) failures++;
}

/**
 * Recursion guard. RpcChild falls back to getPiInvocation() when piBin is absent, which
 * resolves to "the currently running script" -- i.e. this file. A misconfigured spawn
 * then re-runs this test instead of pi, and each copy spawns more. Cheap insurance.
 */
if (process.env.PI_E2E_RUNNING === "1") {
	console.error("FAIL: supervisor.e2e.ts re-entered itself -- a child spawn is missing piBin");
	process.exit(1);
}
process.env.PI_E2E_RUNNING = "1";

async function main(): Promise<void> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sup-e2e-"));
	try {
		await run(dir);
	} finally {
		// Always reclaim the temp dir, including when a check throws.
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
	console.log(failures === 0 ? "\nAll e2e checks passed" : `\n${failures} e2e check(s) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

async function run(dir: string): Promise<void> {
	const promptFile = path.join(dir, "system.md");
	await fs.promises.writeFile(promptFile, "You are a terse test subagent.", "utf8");

	const wakes: Array<{ content: string; steer: boolean }> = [];
	// No `as any` here on purpose: casting is what let a previous version pass wrong
	// option names, which silently fell back to getPiInvocation() and re-spawned this
	// very script instead of pi.
	let spawned: RpcChild | undefined;
	const supervisor = new Supervisor({
		sendUserMessage: (content, options) => {
			wakes.push({ content: String(content), steer: options?.deliverAs === "steer" });
		},
		createChild: (options) => {
			spawned = new RpcChild({ ...options, piBin: "pi" });
			return spawned;
		},
		taskTimeoutMs: TIMEOUT_MS,
	});

	const { runId, taskIds } = supervisor.spawn([
		{
			task: "Reply with exactly the word DONE and nothing else. Do not use tools.",
			model: MODEL,
			thinking: "low",
			workspace: "shared",
			cwd: dir,
			tools: ["read", "ls"],
			systemPromptFile: promptFile,
			projectTrusted: false,
			piBin: "pi",
		},
	]);

	// Non-blocking: spawn returned with the task still running.
	const snapshotAtSpawn = supervisor.status(runId);
	const runningAtSpawn = JSON.stringify(snapshotAtSpawn).includes("running");
	check("spawn() returns while task still running (non-blocking)", runningAtSpawn);
	check("spawn() returns a runId and taskId", Boolean(runId) && taskIds.length === 1);

	// Parent settles with work outstanding -> must NOT wake yet, must wait.
	supervisor.onParentSettled();
	check(
		"parent settling with work outstanding does not wake immediately",
		wakes.length === 0,
		`wakes=${wakes.length}`,
	);

	// Wait for the real child to finish and the real wake to fire.
	const deadline = Date.now() + TIMEOUT_MS;
	while (wakes.length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	check("real child completion woke the parent", wakes.length === 1, `wakes=${wakes.length}`);
	if (wakes[0]) {
		check("wake was plain (parent was waiting), not steer", wakes[0].steer === false);
		check(
			"wake payload is terse (<400 chars, no transcript)",
			wakes[0].content.length < 400,
			`len=${wakes[0].content.length}`,
		);
		console.log(`  wake content: ${JSON.stringify(wakes[0].content)}`);
	}

	if (spawned?.stderr)
		console.log(`  child stderr: ${JSON.stringify(spawned.stderr.slice(0, 600))}`);
	console.log(`  child exitCode: ${spawned?.exitCode}`);

	const result = supervisor.result(runId, taskIds[0]);
	check(
		"result() carries the child's real output",
		/DONE/i.test(String(result?.output ?? "")),
		JSON.stringify(result?.output),
	);
	check("result() carries real usage", (result?.usage?.turns ?? 0) >= 1);

	const after = supervisor.status(runId);
	check("status() shows task done", JSON.stringify(after).includes("done"));
	check(
		"successful task process was reaped",
		spawned?.exited === true && JSON.stringify(after).includes('"reaped":true'),
		JSON.stringify(after),
	);

	supervisor.killAll();
	supervisor.dispose?.();

	await concurrencyAndControl(dir, promptFile);
}

/**
 * Two real children at once (their JSONL streams interleave in the parent), plus a
 * third that the parent kills mid-flight. Proves per-task isolation and parent control.
 */
async function concurrencyAndControl(dir: string, promptFile: string): Promise<void> {
	console.log("\n-- concurrency + control --");
	const wakes: string[] = [];
	const supervisor = new Supervisor({
		sendUserMessage: (content) => {
			wakes.push(String(content));
		},
		createChild: (options) => new RpcChild({ ...options, piBin: "pi" }),
		taskTimeoutMs: TIMEOUT_MS,
	});

	const base = {
		model: MODEL,
		thinking: "low" as const,
		workspace: "shared" as const,
		cwd: dir,
		tools: ["read", "ls"],
		systemPromptFile: promptFile,
		projectTrusted: false,
		piBin: "pi",
	};
	const { runId, taskIds } = supervisor.spawn([
		{ ...base, task: "Reply with exactly the word ALPHA and nothing else. Do not use tools." },
		{ ...base, task: "Reply with exactly the word BETA and nothing else. Do not use tools." },
	]);

	const deadline = Date.now() + TIMEOUT_MS;
	while (wakes.length < 1 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	check(
		"two concurrent children produced one terminal-run wake",
		wakes.length === 1 && (wakes[0].match(/Subagent task/g) ?? []).length === 2,
		`wakes=${wakes.length}`,
	);
	const alpha = String(supervisor.result(runId, taskIds[0]).output ?? "");
	const beta = String(supervisor.result(runId, taskIds[1]).output ?? "");
	console.log(`  task1=${JSON.stringify(alpha)} task2=${JSON.stringify(beta)}`);
	check(
		"concurrent outputs are not cross-contaminated",
		/ALPHA/i.test(alpha) && /BETA/i.test(beta) && !/BETA/i.test(alpha) && !/ALPHA/i.test(beta),
	);

	// Parent control: kill a live child on demand.
	const killRun = supervisor.spawn([
		{ ...base, task: "Count slowly from 1 to 500, one number per line, no tools." },
	]);
	await new Promise((resolve) => setTimeout(resolve, 2500));
	supervisor.killTask(killRun.runId, killRun.taskIds[0]);
	await new Promise((resolve) => setTimeout(resolve, 2500));
	const killedStatus = JSON.stringify(supervisor.status(killRun.runId));
	check(
		"killTask() terminates a live child (task no longer running)",
		!killedStatus.includes('"status":"running"'),
		killedStatus.slice(0, 160),
	);

	supervisor.killAll();
	supervisor.dispose?.();
}

void main();
