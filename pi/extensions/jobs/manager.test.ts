/**
 * Deterministic JobManager tests driven by a fake process.
 *
 * Run: npm run test:extensions
 */
import { SHIMMER_TIMING } from "../lib/pi-tui-soft-group/timing.ts";
import type { JobSpec, JobWakeDelivery, PersistedJobRecord } from "./contracts.ts";
import { createFakeProcessFleet, type FakeProcessBehavior } from "./fake-process.ts";
import {
	INVALIDATE_INTERVAL_MS,
	JobManager,
	SNAPSHOT_TAIL_BYTES,
	STATUS_LIST_LIMIT,
	sanitizeJobText,
} from "./manager.ts";

interface Wake {
	content: string;
	deliverAs?: JobWakeDelivery;
}

interface Harness {
	manager: JobManager;
	fleet: ReturnType<typeof createFakeProcessFleet>;
	wakes: Wake[];
	persisted: PersistedJobRecord[];
}

function harness(
	overrides: {
		maxActiveJobs?: number;
		maxOutputBytes?: number;
		behavior?: FakeProcessBehavior;
		now?: () => number;
		persist?: boolean;
		sendWake?: (content: string, deliverAs?: JobWakeDelivery) => void;
	} = {},
): Harness {
	const wakes: Wake[] = [];
	const persisted: PersistedJobRecord[] = [];
	const fleet = createFakeProcessFleet(overrides.behavior ?? {});
	const manager = new JobManager({
		createProcess: fleet.factory,
		sendWake:
			overrides.sendWake ??
			((content, deliverAs) => {
				wakes.push({ content, deliverAs });
			}),
		persist:
			overrides.persist === false
				? undefined
				: (record) => {
						persisted.push(record);
					},
		now: overrides.now,
		maxActiveJobs: overrides.maxActiveJobs,
		maxOutputBytes: overrides.maxOutputBytes,
	});
	return { manager, fleet, wakes, persisted };
}

function spec(overrides: Partial<JobSpec> = {}): JobSpec {
	return { command: "echo hi", cwd: "/tmp", timeoutMs: 60_000, ...overrides };
}

/** Let the zero-delay wake flush and any pending microtasks run. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 1));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(2);
	}
	return predicate();
}

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

assert(
	"job invalidation derives its cadence from the shared shimmer contract",
	INVALIDATE_INTERVAL_MS === SHIMMER_TIMING.frameIntervalMs && INVALIDATE_INTERVAL_MS === 200,
	JSON.stringify({ INVALIDATE_INTERVAL_MS, SHIMMER_TIMING }),
);

/**
 * Run one test with a hard deadline. The guard timer is deliberately not
 * unref'ed so a hung await fails loudly instead of letting the runner exit.
 */
async function run(test: () => Promise<void>): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			test(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timed out after 5000ms")), 5_000);
			}),
		]);
	} catch (error) {
		fail(test.name, error instanceof Error ? error.message : String(error));
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function throws(fn: () => unknown): string | undefined {
	try {
		fn();
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function testStartIsNonBlocking(): Promise<void> {
	const name = "start returns a durable id immediately without waiting for the process";
	const { manager, fleet } = harness();
	try {
		const before = Date.now();
		const snapshot = manager.start(spec({ label: "build" }));
		const elapsed = Date.now() - before;
		const listed = manager.status(snapshot.jobId)[0];
		assert(
			name,
			snapshot.jobId.startsWith("job-") &&
				snapshot.status === "running" &&
				snapshot.finishedAt === undefined &&
				snapshot.pid === fleet.last().pid &&
				listed?.jobId === snapshot.jobId &&
				elapsed < 50,
			`status=${snapshot.status} pid=${snapshot.pid} elapsed=${elapsed}ms`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testZeroExitCompletes(): Promise<void> {
	const name = "zero exit completes with merged output in arrival order";
	let clock = 1_000;
	const { manager, fleet } = harness({ now: () => clock });
	try {
		const started = manager.start(spec({ label: "unit" }));
		const fake = fleet.last();
		fake.stdout("one\n");
		fake.stderr("two\n");
		fake.stdout("three\n");
		clock = 2_500;
		fake.exit(0);
		const result = manager.result(started.jobId);
		assert(
			name,
			result.snapshot.status === "completed" &&
				result.snapshot.exitCode === 0 &&
				result.output === "one\ntwo\nthree\n" &&
				result.truncated === false &&
				result.snapshot.outputBytes === 14 &&
				result.snapshot.outputLines === 3 &&
				result.snapshot.lastOutputAt === 1_000 &&
				result.snapshot.durationMs === 1_500,
			JSON.stringify({
				status: result.snapshot.status,
				output: result.output,
				bytes: result.snapshot.outputBytes,
				lines: result.snapshot.outputLines,
				duration: result.snapshot.durationMs,
			}),
		);
	} finally {
		await manager.dispose();
	}
}

async function testNonZeroExitFails(): Promise<void> {
	const name = "nonzero exit fails with the real exit code";
	const { manager, fleet } = harness();
	try {
		const started = manager.start(spec());
		fleet.last().exit(3);
		const snapshot = manager.status(started.jobId)[0]!;
		assert(
			name,
			snapshot.status === "failed" &&
				snapshot.exitCode === 3 &&
				snapshot.error === "exited with code 3",
			`status=${snapshot.status} exit=${snapshot.exitCode} error=${snapshot.error}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testSignalExitFails(): Promise<void> {
	const name = "signal death fails and records the signal";
	const { manager, fleet } = harness();
	try {
		const started = manager.start(spec());
		fleet.last().exit(null, "SIGSEGV");
		const snapshot = manager.status(started.jobId)[0]!;
		assert(
			name,
			snapshot.status === "failed" && snapshot.signal === "SIGSEGV",
			`status=${snapshot.status} signal=${snapshot.signal}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testSpawnErrorFailsAndReleasesSlot(): Promise<void> {
	const name = "spawn failure fails the job and releases its slot";
	const { manager, fleet } = harness({
		maxActiveJobs: 1,
		behavior: { spawnError: "shell missing" },
	});
	try {
		const broken = manager.start(spec());
		fleet.behavior.spawnError = undefined;
		const healthy = manager.start(spec());
		const first = manager.status(broken.jobId)[0]!;
		const second = manager.status(healthy.jobId)[0]!;
		assert(
			name,
			first.status === "failed" &&
				first.error === "shell missing" &&
				second.status === "running" &&
				fleet.all.length === 1,
			`first=${first.status}/${first.error} second=${second.status} processes=${fleet.all.length}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testProcessErrorAfterStartFails(): Promise<void> {
	const name = "asynchronous process error fails the job once";
	const { manager, fleet } = harness();
	try {
		const started = manager.start(spec());
		const fake = fleet.last();
		fake.fail("cwd vanished");
		fake.exit(1);
		const snapshot = manager.status(started.jobId)[0]!;
		assert(
			name,
			snapshot.status === "failed" &&
				snapshot.error === "cwd vanished" &&
				snapshot.exitCode === undefined,
			`status=${snapshot.status} error=${snapshot.error} exit=${snapshot.exitCode}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testUtf8SafeAcrossChunks(): Promise<void> {
	const name = "multi-byte characters split across chunks decode intact";
	const { manager, fleet } = harness();
	try {
		const started = manager.start(spec());
		const fake = fleet.last();
		const encoded = Buffer.from("héllo", "utf8");
		fake.write(encoded.subarray(0, 2));
		fake.write(encoded.subarray(2));
		fake.exit(0);
		const result = manager.result(started.jobId);
		assert(
			name,
			result.output === "héllo" &&
				result.snapshot.outputBytes === encoded.length &&
				result.snapshot.outputLines === 1,
			`output=${JSON.stringify(result.output)} bytes=${result.snapshot.outputBytes}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testIncompleteUtf8IsFlushed(): Promise<void> {
	const name = "incomplete final UTF-8 bytes are flushed instead of silently dropped";
	const { manager, fleet } = harness();
	try {
		const started = manager.start(spec());
		fleet.last().write(Buffer.from([0xe2, 0x82]));
		fleet.last().exit(0);
		const result = manager.result(started.jobId);
		assert(
			name,
			result.output === "�" && result.snapshot.outputBytes === 2,
			JSON.stringify(result),
		);
	} finally {
		await manager.dispose();
	}
}

async function testOutputIsBounded(): Promise<void> {
	const name = "output capture stays inside the byte ceiling while totals keep counting";
	const { manager, fleet } = harness({ maxOutputBytes: 64 });
	try {
		const started = manager.start(spec());
		const fake = fleet.last();
		for (let i = 0; i < 50; i++) fake.stdout(`${String(i).padStart(3, "0")}-abcdefghij\n`);
		const running = manager.result(started.jobId);
		fake.exit(0);
		const result = manager.result(started.jobId);
		const capturedBytes = Buffer.byteLength(result.output, "utf8");
		const snapshotBytes = Buffer.byteLength(result.snapshot.outputTail, "utf8");
		assert(
			name,
			capturedBytes <= 64 &&
				Buffer.byteLength(running.output, "utf8") <= 64 &&
				snapshotBytes <= Math.min(64, SNAPSHOT_TAIL_BYTES) &&
				result.truncated &&
				result.snapshot.truncated &&
				result.snapshot.outputBytes === 50 * 15 &&
				result.snapshot.outputLines === 50 &&
				result.output.endsWith("049-abcdefghij\n"),
			`captured=${capturedBytes} total=${result.snapshot.outputBytes} lines=${result.snapshot.outputLines} truncated=${result.truncated}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testQueueOverflow(): Promise<void> {
	const name = "active jobs are capped and overflow runs in queue order";
	const { manager, fleet } = harness({ maxActiveJobs: 2 });
	try {
		const ids = ["a", "b", "c", "d"].map((label) => manager.start(spec({ label })).jobId);
		const statusesAfterStart = ids.map((id) => manager.status(id)[0]!.status);
		fleet.byLabel("a").exit(0);
		const afterFirstExit = ids.map((id) => manager.status(id)[0]!.status);
		fleet.byLabel("b").exit(0);
		const afterSecondExit = ids.map((id) => manager.status(id)[0]!.status);
		assert(
			name,
			statusesAfterStart.join(",") === "running,running,queued,queued" &&
				afterFirstExit.join(",") === "completed,running,running,queued" &&
				afterSecondExit.join(",") === "completed,completed,running,running" &&
				fleet.all.length === 4 &&
				fleet.all.map((process) => process.spec.label).join(",") === "a,b,c,d",
			`${statusesAfterStart} | ${afterFirstExit} | ${afterSecondExit} | processes=${fleet.all.length}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testTimeout(): Promise<void> {
	const name = "a job past its timeout is terminated and marked timed_out";
	const { manager, fleet } = harness({ maxActiveJobs: 1 });
	try {
		const timed = manager.start(spec({ timeoutMs: 10 }));
		const queued = manager.start(spec());
		const fake = fleet.all[0]!;
		await waitFor(() => manager.status(timed.jobId)[0]!.status === "timed_out");
		const snapshot = manager.status(timed.jobId)[0]!;
		assert(
			name,
			snapshot.status === "timed_out" &&
				snapshot.signal === "SIGTERM" &&
				fake.terminateCalls === 1 &&
				manager.status(queued.jobId)[0]!.status === "running",
			`status=${snapshot.status} signal=${snapshot.signal} terminate=${fake.terminateCalls} queued=${manager.status(queued.jobId)[0]!.status}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testCancelRunningJob(): Promise<void> {
	const name = "cancel reports stopping, then a cancelled terminal state with the reason";
	const { manager, fleet } = harness({ behavior: { manualTerminate: true } });
	try {
		const started = manager.start(spec());
		const fake = fleet.last();
		const cancelling = manager.cancel(started.jobId, "user changed their mind");
		const stopping = manager.status(started.jobId)[0]!.status;
		fake.releaseTerminate();
		const snapshot = await cancelling;
		assert(
			name,
			stopping === "stopping" &&
				snapshot.status === "cancelled" &&
				snapshot.cancelReason === "user changed their mind" &&
				fake.terminateCalls === 1,
			`stopping=${stopping} final=${snapshot.status} reason=${snapshot.cancelReason}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testCancelRaceWithExit(): Promise<void> {
	const name = "cancel racing a natural exit yields exactly one terminal transition";
	const { manager, fleet, persisted, wakes } = harness({ maxActiveJobs: 1 });
	try {
		// Only the racing process holds its terminate open; later ones behave normally.
		fleet.behavior.manualTerminate = true;
		const first = manager.start(spec({ label: "racing" }));
		fleet.behavior.manualTerminate = false;
		const second = manager.start(spec({ label: "queued-behind" }));
		const third = manager.start(spec({ label: "still-queued" }));
		const fake = fleet.byLabel("racing");
		const cancelling = manager.cancel(first.jobId, "superseded");
		// The process finishes on its own while the stop is in flight.
		fake.exit(0);
		fake.releaseTerminate();
		const snapshot = await cancelling;
		await flush();
		const terminalRecords = persisted.filter(
			(record) =>
				record.snapshot.jobId === first.jobId &&
				(record.snapshot.status === "cancelled" || record.snapshot.status === "completed"),
		);
		const wakeLines = wakes
			.flatMap((wake) => wake.content.split("\n"))
			.filter((line) => line.includes(first.jobId));
		assert(
			name,
			snapshot.status === "cancelled" &&
				terminalRecords.length === 1 &&
				wakeLines.length === 1 &&
				manager.status(second.jobId)[0]!.status === "running" &&
				manager.status(third.jobId)[0]!.status === "queued" &&
				fleet.all.length === 2,
			`final=${snapshot.status} terminalRecords=${terminalRecords.length} wakeLines=${wakeLines.length} processes=${fleet.all.length}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testCancelIsIdempotentForTerminalJobs(): Promise<void> {
	const name = "cancelling a finished job is a no-op";
	const { manager, fleet } = harness();
	try {
		const started = manager.start(spec());
		const fake = fleet.last();
		fake.exit(0);
		const first = await manager.cancel(started.jobId, "too late");
		const second = await manager.cancel(started.jobId, "still too late");
		assert(
			name,
			first.status === "completed" &&
				second.status === "completed" &&
				first.cancelReason === undefined &&
				fake.terminateCalls === 0,
			`first=${first.status} second=${second.status} terminate=${fake.terminateCalls}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testCancelQueuedJob(): Promise<void> {
	const name = "cancelling a queued job never starts a process";
	const { manager, fleet } = harness({ maxActiveJobs: 1 });
	try {
		const running = manager.start(spec({ label: "first" }));
		const queued = manager.start(spec({ label: "second" }));
		const cancelled = await manager.cancel(queued.jobId, "not needed");
		fleet.byLabel("first").exit(0);
		assert(
			name,
			cancelled.status === "cancelled" &&
				cancelled.cancelReason === "not needed" &&
				cancelled.pid === undefined &&
				manager.status(queued.jobId)[0]!.status === "cancelled" &&
				manager.status(running.jobId)[0]!.status === "completed" &&
				fleet.all.length === 1,
			`cancelled=${cancelled.status} processes=${fleet.all.length}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testUnknownIdsAreDeterministic(): Promise<void> {
	const name = "unknown job ids produce deterministic errors";
	const { manager } = harness();
	try {
		const statusError = throws(() => manager.status("job-missing"));
		const resultError = throws(() => manager.result("job-missing"));
		const invalidatorError = throws(() => manager.registerInvalidator("job-missing", () => {}));
		let cancelError = "";
		await manager.cancel("job-missing", "why").catch((error: Error) => {
			cancelError = error.message;
		});
		const expected = "unknown job: job-missing";
		assert(
			name,
			statusError === expected &&
				resultError === expected &&
				invalidatorError === expected &&
				cancelError === expected,
			`${statusError} | ${resultError} | ${invalidatorError} | ${cancelError}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testWakeSteersActiveParent(): Promise<void> {
	const name = "completion steers an active parent turn";
	const { manager, fleet, wakes } = harness();
	try {
		const started = manager.start(spec({ label: "lint" }));
		fleet.last().exit(0);
		await flush();
		assert(
			name,
			wakes.length === 1 &&
				wakes[0]!.deliverAs === "steer" &&
				wakes[0]!.content.includes(started.jobId),
			JSON.stringify(wakes),
		);
	} finally {
		await manager.dispose();
	}
}

async function testWakeUsesFollowUpWhenParentSettled(): Promise<void> {
	const name = "completion wakes a settled parent without steering";
	const { manager, fleet, wakes } = harness();
	try {
		manager.setParentSettled(true);
		manager.start(spec());
		fleet.last().exit(0);
		await flush();
		assert(name, wakes.length === 1 && wakes[0]!.deliverAs === undefined, JSON.stringify(wakes));
	} finally {
		await manager.dispose();
	}
}

async function testWakeBatching(): Promise<void> {
	const name = "completions in one tick collapse into a single wake";
	const { manager, fleet, wakes } = harness({ maxActiveJobs: 3 });
	try {
		const ids = ["a", "b", "c"].map((label) => manager.start(spec({ label })).jobId);
		for (const label of ["a", "b", "c"]) fleet.byLabel(label).exit(0);
		await flush();
		const content = wakes[0]?.content ?? "";
		assert(
			name,
			wakes.length === 1 && ids.every((id) => content.includes(id)),
			`wakes=${wakes.length} content=${content}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testWakeSuppression(): Promise<void> {
	const name = "suppressed wakes are held and flushed once after unsuppression";
	const { manager, fleet, wakes } = harness({ maxActiveJobs: 2 });
	try {
		manager.setWakeSuppressed(true);
		const first = manager.start(spec({ label: "a" })).jobId;
		const second = manager.start(spec({ label: "b" })).jobId;
		fleet.byLabel("a").exit(0);
		await flush();
		const duringSuppression = wakes.length;
		fleet.byLabel("b").exit(1);
		manager.setWakeSuppressed(false);
		await flush();
		const content = wakes[0]?.content ?? "";
		assert(
			name,
			duringSuppression === 0 &&
				wakes.length === 1 &&
				content.includes(first) &&
				content.includes(second),
			`duringSuppression=${duringSuppression} wakes=${wakes.length} content=${content}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testWakeTextIsBoundedAndDescriptive(): Promise<void> {
	const name = "wake text carries id, label, state, and duration but never output";
	let clock = 1_000;
	const { manager, fleet, wakes } = harness({ maxActiveJobs: 3, now: () => clock });
	try {
		const completed = manager.start(spec({ label: "build" })).jobId;
		const timedLabel = manager.start(spec({ label: "slow" })).jobId;
		const cancelled = manager.start(spec({ label: "doomed" })).jobId;
		fleet.byLabel("build").stdout("SECRET-OUTPUT-SHOULD-NOT-LEAK\n");
		clock = 2_500;
		fleet.byLabel("build").exit(0);
		await manager.cancel(cancelled, "no longer relevant");
		await flush();
		const content = wakes.map((wake) => wake.content).join("\n");
		const lines = content.split("\n");
		assert(
			name,
			wakes.length === 1 &&
				content.includes(completed) &&
				content.includes("[build]") &&
				content.includes("completed (exit 0)") &&
				content.includes("after 1.5s") &&
				content.includes("cancelled (no longer relevant)") &&
				!content.includes("SECRET-OUTPUT-SHOULD-NOT-LEAK") &&
				!content.includes(timedLabel) &&
				lines.every((line) => line.length <= 200),
			content,
		);
	} finally {
		await manager.dispose();
	}
}

async function testRestore(): Promise<void> {
	const name = "restore rebuilds history and converts live records to interrupted";
	const { manager, fleet, persisted, wakes } = harness();
	try {
		const records: PersistedJobRecord[] = [
			{
				snapshot: {
					jobId: "job-done",
					command: "make",
					label: "make",
					cwd: "/tmp",
					status: "completed",
					startedAt: 10,
					finishedAt: 20,
					durationMs: 10,
					timeoutMs: 1_000,
					exitCode: 0,
					outputBytes: 6,
					outputLines: 1,
					outputTail: "built\n",
					truncated: false,
				},
			},
			{
				snapshot: {
					jobId: "job-live",
					command: "sleep 100",
					label: "sleeper",
					cwd: "/tmp",
					status: "running",
					pid: 9_999,
					startedAt: 30,
					durationMs: 5,
					timeoutMs: 1_000,
					outputBytes: 3,
					outputLines: 1,
					outputTail: "abc",
					truncated: false,
				},
			},
			{ snapshot: undefined as never },
		];
		const restored = manager.restore(records);
		await flush();
		const done = manager.status("job-done")[0]!;
		const live = manager.status("job-live")[0]!;
		const interruptedRecords = persisted.filter(
			(record) => record.snapshot.status === "interrupted",
		);
		assert(
			name,
			restored &&
				done.status === "completed" &&
				manager.result("job-done").output === "built\n" &&
				live.status === "interrupted" &&
				live.finishedAt !== undefined &&
				live.error !== undefined &&
				manager.status().length === 2 &&
				interruptedRecords.length === 1 &&
				fleet.all.length === 0 &&
				wakes.length === 0,
			`restored=${restored} done=${done.status} live=${live.status} records=${interruptedRecords.length} wakes=${wakes.length}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testMalformedRestoreIsSanitized(): Promise<void> {
	const name = "malformed persisted records restore into bounded safe snapshots";
	const { manager } = harness();
	try {
		const malformed = {
			snapshot: {
				jobId: "job-malformed",
				command: 42,
				label: "bad\u001b[2Jlabel",
				cwd: 99,
				status: "running",
				startedAt: Number.NaN,
				durationMs: Number.NaN,
				timeoutMs: Number.NaN,
				outputBytes: Number.NaN,
				outputLines: Number.NaN,
				outputTail: 123,
				truncated: false,
			},
		} as unknown as PersistedJobRecord;
		assert(
			"malformed persisted records are accepted for reconciliation",
			manager.restore([malformed]),
			"record was not restored",
		);
		const [snapshot] = manager.status("job-malformed");
		assert(
			name,
			snapshot?.status === "interrupted" &&
				snapshot.command === "42" &&
				snapshot.label === "badlabel" &&
				snapshot.cwd === "99" &&
				Number.isFinite(snapshot.startedAt) &&
				Number.isFinite(snapshot.timeoutMs) &&
				Number.isFinite(snapshot.outputBytes) &&
				snapshot.outputTail === "123",
			JSON.stringify(snapshot),
		);
	} finally {
		await manager.dispose();
	}
}

async function testInvalidation(): Promise<void> {
	const name = "registered invalidators animate live jobs and stop at terminal state";
	const { manager, fleet } = harness();
	try {
		const started = manager.start(spec());
		let calls = 0;
		const unregister = manager.registerInvalidator(started.jobId, () => {
			calls++;
		});
		const animated = await waitFor(() => calls >= 2, 1_000);
		const beforeExit = calls;
		fleet.last().exit(0);
		const onTransition = calls > beforeExit;
		const afterTransition = calls;
		await sleep(60);
		const quiescent = calls === afterTransition;
		unregister();
		assert(
			name,
			animated && onTransition && quiescent,
			`animated=${animated} onTransition=${onTransition} calls=${calls} afterTransition=${afterTransition}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testInvalidatorUnregisterStopsSubscription(): Promise<void> {
	const name = "unregistering the last invalidator stops its animation subscription";
	const { manager } = harness();
	try {
		const started = manager.start(spec());
		let calls = 0;
		const unregister = manager.registerInvalidator(started.jobId, () => {
			calls++;
		});
		await waitFor(() => calls >= 1, 500);
		unregister();
		const settled = calls;
		await sleep(60);
		assert(name, calls === settled, `calls=${calls} settled=${settled}`);
	} finally {
		await manager.dispose();
	}
}

async function testDispose(): Promise<void> {
	const name = "dispose interrupts live jobs, terminates processes, and silences wakes";
	const { manager, fleet, wakes, persisted } = harness({
		maxActiveJobs: 2,
		behavior: { exitOnTerminate: false },
	});
	try {
		const first = manager.start(spec({ label: "a" })).jobId;
		const second = manager.start(spec({ label: "b" })).jobId;
		let invalidations = 0;
		manager.registerInvalidator(first, () => {
			invalidations++;
		});
		await manager.dispose();
		const afterDispose = invalidations;
		await sleep(40);
		const statuses = [first, second].map((id) => manager.status(id)[0]!.status);
		const interrupted = persisted.filter((record) => record.snapshot.status === "interrupted");
		assert(
			name,
			statuses.join(",") === "interrupted,interrupted" &&
				fleet.all.every((process) => process.terminateCalls === 1) &&
				wakes.length === 0 &&
				interrupted.length === 2 &&
				invalidations === afterDispose &&
				throws(() => manager.start(spec())) === "job manager is disposed",
			`statuses=${statuses} terminate=${fleet.all.map((p) => p.terminateCalls)} wakes=${wakes.length}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testRestoreReactivatesDisposedManager(): Promise<void> {
	const name = "session restore reactivates a disposed manager for the next session";
	const { manager, fleet } = harness();
	try {
		manager.start(spec({ label: "old-session" }));
		await manager.dispose();
		const restored = manager.restore([]);
		const next = manager.start(spec({ label: "next-session" }));
		assert(
			name,
			!restored &&
				manager.status().length === 1 &&
				manager.status(next.jobId)[0]?.status === "running" &&
				fleet.all.length === 2,
			JSON.stringify({ restored, status: manager.status(next.jobId), processes: fleet.all.length }),
		);
	} finally {
		await manager.dispose();
	}
}

async function testPersistsOnlyLifecycleTransitions(): Promise<void> {
	const name = "persistence records lifecycle transitions only";
	const { manager, fleet, persisted } = harness();
	try {
		const started = manager.start(spec());
		const fake = fleet.last();
		for (let i = 0; i < 5; i++) fake.stdout(`line ${i}\n`);
		const duringRun = persisted.map((record) => record.snapshot.status).join(",");
		fake.exit(0);
		const statuses = persisted.map((record) => record.snapshot.status).join(",");
		assert(
			name,
			duringRun === "queued,running" &&
				statuses === "queued,running,completed" &&
				persisted[2]!.snapshot.jobId === started.jobId,
			`duringRun=${duringRun} statuses=${statuses}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testInvalidSpecsRejected(): Promise<void> {
	const name = "invalid job specs are rejected before anything is queued";
	const { manager, fleet } = harness();
	try {
		const emptyCommand = throws(() => manager.start(spec({ command: "  " })));
		const emptyCwd = throws(() => manager.start(spec({ cwd: "" })));
		const badTimeout = throws(() => manager.start(spec({ timeoutMs: 0 })));
		assert(
			name,
			emptyCommand === "job command must not be empty" &&
				emptyCwd === "job cwd must not be empty" &&
				badTimeout === "job timeoutMs must be a positive number, received 0" &&
				manager.status().length === 0 &&
				fleet.all.length === 0,
			`${emptyCommand} | ${emptyCwd} | ${badTimeout}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testUnconfirmedCleanupIsReported(): Promise<void> {
	const name = "an unconfirmed reap is reported on the cancelled job";
	const { manager, fleet } = harness({ behavior: { exitOnTerminate: false, reap: false } });
	try {
		const started = manager.start(spec());
		const snapshot = await manager.cancel(started.jobId, "stop now");
		assert(
			name,
			snapshot.status === "cancelled" &&
				snapshot.error === "process cleanup could not be confirmed" &&
				fleet.last().terminateCalls === 1,
			`status=${snapshot.status} error=${snapshot.error}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testSanitizesOutputAndLabels(): Promise<void> {
	const name = "output, labels, and cancel text are sanitized before snapshots and wakes";
	const wakes: Wake[] = [];
	const { manager, fleet } = harness({
		behavior: { manualTerminate: true },
		sendWake: (content, deliverAs) => wakes.push({ content, deliverAs }),
	});
	try {
		const started = manager.start(
			spec({
				label: `build\u001b[2J\u0007\uFFF9`,
			}),
		);
		const fake = fleet.last();
		fake.stdout("start\u001b[2J\u001b[?1049h");
		fake.stdout("hidden\r100%\u0007\n");
		fake.stdout("ok\n");
		const cancelling = manager.cancel(started.jobId, "stop\u001b[0m now");
		fake.releaseTerminate();
		const cancelled = await cancelling;
		await flush();
		const result = manager.result(started.jobId);
		const wake = wakes.map((entry) => entry.content).join("\n");
		const rawBytes = Buffer.byteLength(
			"start\u001b[2J\u001b[?1049hhidden\r100%\u0007\nok\n",
			"utf8",
		);
		assert(
			name,
			result.output === "starthidden100%\nok\n" &&
				result.snapshot.outputTail === "starthidden100%\nok\n" &&
				result.snapshot.outputBytes === rawBytes &&
				started.label === "build" &&
				cancelled.cancelReason === "stop now" &&
				!result.output.includes("\u001b") &&
				!wake.includes("\u001b") &&
				sanitizeJobText("a\u001b]8;;http://x\u0007b") === "ab",
			JSON.stringify({
				output: result.output,
				label: started.label,
				reason: cancelled.cancelReason,
				bytes: result.snapshot.outputBytes,
				wake,
			}),
		);
	} finally {
		await manager.dispose();
	}
}

async function testSanitizesSequencesSplitAcrossChunks(): Promise<void> {
	const name = "ANSI sequences split across chunks are stripped on read";
	const { manager, fleet } = harness();
	try {
		const started = manager.start(spec());
		const fake = fleet.last();
		fake.write(Buffer.from("pre\u001b[", "utf8"));
		fake.write(Buffer.from("31mRED\u001b[0mpost\n", "utf8"));
		fake.exit(0);
		const result = manager.result(started.jobId);
		assert(
			name,
			result.output === "preREDpost\n" && !result.output.includes("\u001b"),
			JSON.stringify(result.output),
		);
	} finally {
		await manager.dispose();
	}
}

async function testProcessExitForceKillsRetainedHandles(): Promise<void> {
	const name = "process exit force-kills retained handles and dispose removes the listener";
	const { manager, fleet } = harness({
		behavior: { exitOnTerminate: false, exitOnForceKill: false, reap: false },
	});
	try {
		manager.start(spec({ label: "live" }));
		const live = fleet.last();
		process.emit("exit", 0);
		const afterExit = live.forceKillCalls;
		await manager.dispose();
		const afterDispose = live.forceKillCalls;
		process.emit("exit", 0);
		assert(
			name,
			afterExit === 1 && live.forceKillCalls === afterDispose,
			`afterExit=${afterExit} afterDispose=${afterDispose} forceKill=${live.forceKillCalls}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testUnconfirmedReapRetainedForDisposeCleanup(): Promise<void> {
	const name = "unconfirmed reap retains the handle for dispose cleanup";
	const { manager, fleet } = harness({
		behavior: { exitOnTerminate: false, exitOnForceKill: false, reap: false },
	});
	try {
		const started = manager.start(spec());
		const fake = fleet.last();
		await manager.cancel(started.jobId, "stop now");
		const terminateAfterCancel = fake.terminateCalls;
		await manager.dispose();
		assert(
			name,
			manager.status(started.jobId)[0]!.error === "process cleanup could not be confirmed" &&
				terminateAfterCancel === 1 &&
				fake.terminateCalls >= 2 &&
				fake.forceKillCalls >= 1,
			`terminate=${fake.terminateCalls} forceKill=${fake.forceKillCalls}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testExitRaceStillRetainsUnconfirmedReap(): Promise<void> {
	const name = "exit winning cancellation still retains an unconfirmed process handle";
	const { manager, fleet } = harness({
		behavior: { reap: false, exitOnForceKill: false },
	});
	const started = manager.start(spec());
	const fake = fleet.last();
	const cancelled = await manager.cancel(started.jobId, "cleanup race");
	await manager.dispose();
	assert(
		name,
		cancelled.status === "cancelled" &&
			cancelled.error?.includes("cleanup could not be confirmed") === true &&
			fake.forceKillCalls >= 1,
		JSON.stringify({ cancelled, forceKillCalls: fake.forceKillCalls }),
	);
}

async function testSynchronousTerminateFailureRetainsHandle(): Promise<void> {
	const name = "synchronous terminate failure retains the handle for forced cleanup";
	const { manager, fleet } = harness({
		behavior: { terminateError: "terminate exploded", exitOnForceKill: false },
	});
	const started = manager.start(spec());
	const fake = fleet.last();
	const cancelled = await manager.cancel(started.jobId, "cleanup failure");
	await manager.dispose();
	assert(
		name,
		cancelled.status === "cancelled" &&
			cancelled.error?.includes("terminate exploded") === true &&
			fake.forceKillCalls >= 1,
		JSON.stringify({ cancelled, forceKillCalls: fake.forceKillCalls }),
	);
}

async function testHungTerminateWatchdog(): Promise<void> {
	const name = "stop watchdog force-kills a hung terminate and releases the slot";
	const { manager, fleet } = harness({
		maxActiveJobs: 1,
		behavior: { manualTerminate: true },
	});
	try {
		const stuck = manager.start(spec({ label: "stuck" }));
		const waiting = manager.start(spec({ label: "waiting" }));
		void manager.cancel(stuck.jobId, "stop");
		const finished = await waitFor(
			() => manager.status(stuck.jobId)[0]!.status === "cancelled",
			2_500,
		);
		assert(
			name,
			finished &&
				manager.status(stuck.jobId)[0]!.status === "cancelled" &&
				manager.status(waiting.jobId)[0]!.status === "running" &&
				fleet.byLabel("stuck").forceKillCalls >= 1 &&
				fleet.all.length === 2,
			`finished=${finished} stuck=${manager.status(stuck.jobId)[0]!.status} waiting=${manager.status(waiting.jobId)[0]!.status} forceKill=${fleet.byLabel("stuck").forceKillCalls}`,
		);
	} finally {
		fleet.byLabel("stuck").releaseTerminate(false);
		await manager.dispose();
	}
}

async function testWakeSendRetry(): Promise<void> {
	const name = "a sendWake throw retries autonomously without a parent lifecycle event";
	const wakes: Wake[] = [];
	let attempts = 0;
	const { manager, fleet } = harness({
		sendWake: (content, deliverAs) => {
			attempts++;
			if (attempts === 1) throw new Error("delivery failed");
			wakes.push({ content, deliverAs });
		},
	});
	try {
		const started = manager.start(spec({ label: "retry" }));
		fleet.last().exit(0);
		const delivered = await waitFor(() => wakes.length === 1, 1_000);
		assert(
			name,
			delivered && attempts === 2 && wakes[0]!.content.includes(started.jobId),
			`delivered=${delivered} attempts=${attempts} wakes=${wakes.length}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testStatusListIsCapped(): Promise<void> {
	const name = "status() without an id returns only the most recent receipts";
	const total = STATUS_LIST_LIMIT + 5;
	const { manager, fleet } = harness({ maxActiveJobs: total });
	try {
		const ids: string[] = [];
		for (let i = 0; i < total; i++) {
			ids.push(manager.start(spec({ label: `j${i}` })).jobId);
		}
		for (const fake of fleet.all) fake.exit(0);
		const listed = manager.status();
		const oldest = manager.status(ids[0]!)[0]!;
		assert(
			name,
			listed.length === STATUS_LIST_LIMIT &&
				listed[0]!.jobId === ids[5] &&
				listed[listed.length - 1]!.jobId === ids[ids.length - 1] &&
				oldest.jobId === ids[0] &&
				oldest.status === "completed",
			`listed=${listed.length} first=${listed[0]?.jobId} oldest=${oldest.status}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function testNaNOptionsAreHardened(): Promise<void> {
	const name = "NaN numeric options fall back to safe defaults";
	const { manager, fleet } = harness({
		maxActiveJobs: Number.NaN,
		maxOutputBytes: Number.NaN,
	});
	try {
		const ids = Array.from({ length: 6 }, (_, i) => manager.start(spec({ label: `n${i}` })).jobId);
		const running = ids.filter((id) => manager.status(id)[0]!.status === "running").length;
		const queued = ids.filter((id) => manager.status(id)[0]!.status === "queued").length;
		fleet.byLabel("n0").stdout("x".repeat(100));
		const bytes = manager.result(ids[0]!).snapshot.outputBytes;
		assert(
			name,
			running === 4 && queued === 2 && bytes === 100 && fleet.all.length === 4,
			`running=${running} queued=${queued} bytes=${bytes} processes=${fleet.all.length}`,
		);
	} finally {
		await manager.dispose();
	}
}

async function main(): Promise<void> {
	const tests = [
		testStartIsNonBlocking,
		testZeroExitCompletes,
		testNonZeroExitFails,
		testSignalExitFails,
		testSpawnErrorFailsAndReleasesSlot,
		testProcessErrorAfterStartFails,
		testUtf8SafeAcrossChunks,
		testIncompleteUtf8IsFlushed,
		testOutputIsBounded,
		testQueueOverflow,
		testTimeout,
		testCancelRunningJob,
		testCancelRaceWithExit,
		testCancelIsIdempotentForTerminalJobs,
		testCancelQueuedJob,
		testUnknownIdsAreDeterministic,
		testWakeSteersActiveParent,
		testWakeUsesFollowUpWhenParentSettled,
		testWakeBatching,
		testWakeSuppression,
		testWakeTextIsBoundedAndDescriptive,
		testRestore,
		testMalformedRestoreIsSanitized,
		testInvalidation,
		testInvalidatorUnregisterStopsSubscription,
		testDispose,
		testRestoreReactivatesDisposedManager,
		testPersistsOnlyLifecycleTransitions,
		testInvalidSpecsRejected,
		testUnconfirmedCleanupIsReported,
		testSanitizesOutputAndLabels,
		testSanitizesSequencesSplitAcrossChunks,
		testProcessExitForceKillsRetainedHandles,
		testUnconfirmedReapRetainedForDisposeCleanup,
		testExitRaceStillRetainsUnconfirmedReap,
		testSynchronousTerminateFailureRetainsHandle,
		testHungTerminateWatchdog,
		testWakeSendRetry,
		testStatusListIsCapped,
		testNaNOptionsAreHardened,
	];
	for (const test of tests) await run(test);

	if (failed > 0) {
		console.log(`\n${failed} failure(s)`);
		process.exit(1);
	}
	console.log("\nAll tests passed.");
}

void main();
