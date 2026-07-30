/**
 * Hermetic tests for the real job process factory.
 *
 * Every command is a short local shell builtin: no network, no fixtures, and no
 * sleep longer than the assertion needs. Process-group assertions are POSIX only
 * and are skipped on Windows.
 *
 * Run: npm run test:extensions
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isTerminalJobStatus, type JobProcessHooks, type JobSpec } from "./contracts.ts";
import { JobManager } from "./manager.ts";
import { createJobProcess } from "./process.ts";

const POSIX = process.platform !== "win32";

let failed = 0;

function pass(name: string): void {
	console.log(`PASS: ${name}`);
}

function fail(name: string, detail: string): void {
	failed++;
	console.log(`FAIL: ${name}: ${detail}`);
}

function assert(name: string, condition: boolean, detail: string): void {
	if (condition) pass(name);
	else fail(name, detail);
}

function skip(name: string, reason: string): void {
	console.log(`SKIP: ${name}: ${reason}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Exit {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

interface Recorder {
	hooks: JobProcessHooks;
	stdout: string;
	stderr: string;
	merged: string;
	errors: Error[];
	exits: Exit[];
	exited: Promise<Exit>;
}

function recorder(): Recorder {
	const settled = Promise.withResolvers<Exit>();
	const state: Recorder = {
		stdout: "",
		stderr: "",
		merged: "",
		errors: [],
		exits: [],
		exited: settled.promise,
		hooks: {
			onOutput: (chunk, stream) => {
				const text = chunk.toString("utf8");
				state.merged += text;
				if (stream === "stdout") state.stdout += text;
				else state.stderr += text;
			},
			onExit: (exitCode, signal) => {
				state.exits.push({ exitCode, signal });
				settled.resolve({ exitCode, signal });
			},
			onError: (error) => {
				state.errors.push(error);
			},
		},
	};
	return state;
}

function jobSpec(command: string, overrides: Partial<JobSpec> = {}): JobSpec {
	return { command, cwd: tmpdir(), label: "test", timeoutMs: 10_000, ...overrides };
}

async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Wait until a pid is gone, using a signal-0 probe. */
async function waitGone(pid: number, timeoutMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		}
		if (Date.now() >= deadline) return false;
		await sleep(10);
	}
}

async function run(test: () => Promise<void>): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			test(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timed out after 10000ms")), 10_000);
			}),
		]);
	} catch (error) {
		fail(test.name, error instanceof Error ? error.message : String(error));
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function testStreamsAndZeroExit(): Promise<void> {
	const name = "captures stdout and stderr and reports a zero exit";
	const seen = recorder();
	const handle = createJobProcess(
		jobSpec("printf 'to-stdout\\n'; printf 'to-stderr\\n' >&2"),
		seen.hooks,
	);
	try {
		const exit = await withDeadline(seen.exited, 5_000, "exit");
		assert(
			name,
			exit.exitCode === 0 &&
				exit.signal === null &&
				seen.stdout === "to-stdout\n" &&
				seen.stderr === "to-stderr\n" &&
				seen.exits.length === 1 &&
				seen.errors.length === 0 &&
				typeof handle.pid === "number",
			JSON.stringify({ exit, stdout: seen.stdout, stderr: seen.stderr, pid: handle.pid }),
		);
	} finally {
		await handle.terminate();
	}
}

async function testNonZeroExit(): Promise<void> {
	const name = "reports a nonzero exit status";
	const seen = recorder();
	const handle = createJobProcess(jobSpec("printf 'boom\\n' >&2; exit 7"), seen.hooks);
	try {
		const exit = await withDeadline(seen.exited, 5_000, "exit");
		assert(
			name,
			exit.exitCode === 7 && exit.signal === null && seen.stderr === "boom\n",
			JSON.stringify({ exit, stderr: seen.stderr }),
		);
	} finally {
		await handle.terminate();
	}
}

async function testStdinIsIgnored(): Promise<void> {
	const name = "stdin is ignored so readers finish instead of blocking";
	const seen = recorder();
	const handle = createJobProcess(jobSpec("cat; printf 'cat-exit:%s\\n' \"$?\""), seen.hooks);
	try {
		const exit = await withDeadline(seen.exited, 5_000, "exit");
		assert(
			name,
			exit.exitCode === 0 && seen.stdout === "cat-exit:0\n",
			JSON.stringify({ exit, stdout: seen.stdout }),
		);
	} finally {
		await handle.terminate();
	}
}

async function testEnvironmentIsInheritedWithoutProfileHooks(): Promise<void> {
	const name = "environment is inherited but shell profile hooks are dropped";
	const previousToken = process.env.PI_JOBS_TEST_TOKEN;
	const previousBashEnv = process.env.BASH_ENV;
	process.env.PI_JOBS_TEST_TOKEN = "inherited-value";
	process.env.BASH_ENV = join(tmpdir(), "pi-jobs-should-not-be-sourced.sh");
	const seen = recorder();
	const handle = createJobProcess(
		jobSpec('printf \'token=%s bash_env=[%s]\\n\' "$PI_JOBS_TEST_TOKEN" "$BASH_ENV"'),
		seen.hooks,
	);
	try {
		const exit = await withDeadline(seen.exited, 5_000, "exit");
		assert(
			name,
			exit.exitCode === 0 && seen.stdout === "token=inherited-value bash_env=[]\n",
			JSON.stringify({ exit, stdout: seen.stdout }),
		);
	} finally {
		await handle.terminate();
		if (previousToken === undefined) delete process.env.PI_JOBS_TEST_TOKEN;
		else process.env.PI_JOBS_TEST_TOKEN = previousToken;
		if (previousBashEnv === undefined) delete process.env.BASH_ENV;
		else process.env.BASH_ENV = previousBashEnv;
	}
}

async function testMissingCwdIsReported(): Promise<void> {
	const name = "an unusable working directory is reported as an error";
	const seen = recorder();
	const missing = join(tmpdir(), `pi-jobs-missing-${process.pid}-${Date.now()}`);
	const handle = createJobProcess(jobSpec("printf 'never\\n'", { cwd: missing }), seen.hooks);
	await sleep(20);
	assert(
		name,
		seen.errors.length === 1 &&
			seen.errors[0]!.message.includes(missing) &&
			seen.exits.length === 0 &&
			handle.pid === undefined &&
			(await handle.terminate()) === true,
		JSON.stringify({ errors: seen.errors.map((error) => error.message), exits: seen.exits.length }),
	);
}

async function testTerminateAfterExitIsSafe(): Promise<void> {
	const name = "terminating an already finished process confirms cleanup";
	const seen = recorder();
	const handle = createJobProcess(jobSpec("printf 'done\\n'"), seen.hooks);
	await withDeadline(seen.exited, 5_000, "exit");
	const reaped = await handle.terminate();
	assert(
		name,
		reaped === true && seen.exits.length === 1,
		`reaped=${reaped} exits=${seen.exits.length}`,
	);
}

async function testTerminateKillsProcessGroup(): Promise<void> {
	const name = "terminate stops the whole process group";
	if (!POSIX) {
		skip(name, "process groups are POSIX only");
		return;
	}
	const seen = recorder();
	const handle = createJobProcess(
		jobSpec("sleep 30 & printf 'child:%s\\n' \"$!\"; wait"),
		seen.hooks,
	);
	let descendant = 0;
	try {
		await withDeadline(
			(async () => {
				while (!/child:(\d+)/.test(seen.stdout)) await sleep(5);
			})(),
			5_000,
			"descendant pid",
		);
		descendant = Number(/child:(\d+)/.exec(seen.stdout)![1]);
		const reaped = await handle.terminate();
		const exit = await withDeadline(seen.exited, 5_000, "exit");
		const descendantGone = await waitGone(descendant);
		assert(
			name,
			reaped === true &&
				descendantGone &&
				(exit.signal === "SIGTERM" || exit.exitCode === 143) &&
				seen.exits.length === 1,
			JSON.stringify({ reaped, descendant, descendantGone, exit }),
		);
	} finally {
		handle.forceKill();
		if (descendant) {
			try {
				process.kill(descendant, "SIGKILL");
			} catch {
				// Already gone, which is the expected case.
			}
		}
	}
}

async function testForceKillIsSynchronous(): Promise<void> {
	const name = "forceKill returns synchronously and kills the group";
	if (!POSIX) {
		skip(name, "signal semantics differ on Windows");
		return;
	}
	const seen = recorder();
	const handle = createJobProcess(jobSpec("sleep 30 & printf 'ready\\n'; wait"), seen.hooks);
	try {
		await withDeadline(
			(async () => {
				while (!seen.stdout.includes("ready")) await sleep(5);
			})(),
			5_000,
			"process start",
		);
		const pid = handle.pid!;
		const before = Date.now();
		handle.forceKill();
		const elapsed = Date.now() - before;
		const exit = await withDeadline(seen.exited, 5_000, "exit");
		const groupGone = await waitGone(pid);
		assert(
			name,
			elapsed < 50 && exit.signal === "SIGKILL" && groupGone,
			JSON.stringify({ elapsed, exit, groupGone }),
		);
	} finally {
		handle.forceKill();
	}
}

async function testLateOutputIsNotLost(): Promise<void> {
	const name = "output written just before exit is still captured";
	const seen = recorder();
	const handle = createJobProcess(
		jobSpec("for i in 1 2 3 4 5; do printf 'chunk-%s\\n' \"$i\"; done"),
		seen.hooks,
	);
	try {
		await withDeadline(seen.exited, 5_000, "exit");
		assert(
			name,
			seen.merged === "chunk-1\nchunk-2\nchunk-3\nchunk-4\nchunk-5\n",
			JSON.stringify(seen.merged),
		);
	} finally {
		await handle.terminate();
	}
}

async function testNaturalExitSweepsBackgroundDescendants(): Promise<void> {
	const name = "natural leader exit sweeps remaining POSIX process group";
	if (!POSIX) {
		skip(name, "process groups are POSIX only");
		return;
	}
	const seen = recorder();
	const handle = createJobProcess(
		jobSpec("sleep 30 >/dev/null 2>&1 & printf 'child:%s\\n' \"$!\"; exit 0"),
		seen.hooks,
	);
	let descendant = 0;
	try {
		await withDeadline(
			(async () => {
				while (!/child:(\d+)/.test(seen.stdout)) await sleep(5);
			})(),
			5_000,
			"descendant pid",
		);
		descendant = Number(/child:(\d+)/.exec(seen.stdout)![1]);
		const exit = await withDeadline(seen.exited, 5_000, "exit");
		const descendantGone = await waitGone(descendant);
		assert(
			name,
			exit.exitCode === 0 && exit.signal === null && descendantGone && seen.exits.length === 1,
			JSON.stringify({ exit, descendant, descendantGone }),
		);
	} finally {
		handle.forceKill();
		if (descendant) {
			try {
				process.kill(descendant, "SIGKILL");
			} catch {
				// Already gone, which is the expected case.
			}
		}
	}
}

async function testManagerAndRealProcessIntegration(): Promise<void> {
	const name = "manager and real process integrate for failure output and cancellation";
	const manager = new JobManager({ createProcess: createJobProcess, sendWake: () => undefined });
	try {
		const failedJob = manager.start(
			jobSpec("printf 'manager-out\\n'; printf 'manager-err\\n' >&2; exit 3"),
		);
		await withDeadline(
			(async () => {
				while (!isTerminalJobStatus(manager.status(failedJob.jobId)[0]!.status)) await sleep(5);
			})(),
			5_000,
			"manager failure completion",
		);
		const failedResult = manager.result(failedJob.jobId);

		const cancelledJob = manager.start(jobSpec("sleep 30"));
		const cancelled = await manager.cancel(cancelledJob.jobId, "integration test cleanup");
		assert(
			name,
			failedResult.snapshot.status === "failed" &&
				failedResult.snapshot.exitCode === 3 &&
				failedResult.output.includes("manager-out") &&
				failedResult.output.includes("manager-err") &&
				cancelled.status === "cancelled",
			JSON.stringify({ failedResult, cancelled }),
		);
	} finally {
		await manager.dispose();
	}
}

async function main(): Promise<void> {
	const tests = [
		testStreamsAndZeroExit,
		testNonZeroExit,
		testStdinIsIgnored,
		testEnvironmentIsInheritedWithoutProfileHooks,
		testMissingCwdIsReported,
		testTerminateAfterExitIsSafe,
		testTerminateKillsProcessGroup,
		testForceKillIsSynchronous,
		testLateOutputIsNotLost,
		testNaturalExitSweepsBackgroundDescendants,
		testManagerAndRealProcessIntegration,
	];
	for (const test of tests) await run(test);

	if (failed > 0) {
		console.log(`\n${failed} failure(s)`);
		process.exit(1);
	}
	console.log("\nAll tests passed.");
}

void main();
