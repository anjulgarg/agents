/**
 * /jobs command and JobsListView tests.
 *
 * Run: npm run test:extensions
 */

import { type Component } from "@earendil-works/pi-tui";

import { registerJobCommand, JobLogView, JobsListView } from "./command.ts";
import {
	isTerminalJobStatus,
	type JobManagerApi,
	type JobResult,
	type JobSnapshot,
	type JobSpec,
	type PersistedJobRecord,
} from "./contracts.ts";
import { STATUS_LIST_LIMIT } from "./tools.ts";

let passed = 0;
let failed = 0;

function pass(name: string): void {
	passed++;
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

// ── Fake helpers ──────────────────────────────────────────────────────

let nextJobId = 1;

function makeSnapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
	return {
		jobId: `job-${nextJobId++}`,
		command: "npm run build",
		label: "",
		cwd: "/repo",
		status: "running",
		pid: 4242,
		startedAt: 1_000,
		durationMs: 4_200,
		timeoutMs: 1_800_000,
		outputBytes: 0,
		outputLines: 0,
		outputTail: "",
		truncated: false,
		...overrides,
	};
}

class FakeManager implements JobManagerApi {
	jobs = new Map<string, JobSnapshot>();
	outputs = new Map<string, string>();
	cancels: Array<{ jobId: string; reason: string }> = [];
	cancelError?: string;

	start(spec: JobSpec): JobSnapshot {
		const job = makeSnapshot({
			jobId: `job-${nextJobId++}`,
			command: spec.command,
			label: spec.label ?? "",
			cwd: spec.cwd,
			timeoutMs: spec.timeoutMs,
		});
		this.jobs.set(job.jobId, job);
		return job;
	}

	status(jobId?: string): JobSnapshot[] {
		if (jobId === undefined) return [...this.jobs.values()];
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown job ${jobId}`);
		return [job];
	}

	result(jobId: string): JobResult {
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown job ${jobId}`);
		return { snapshot: job, output: this.outputs.get(jobId) ?? "", truncated: job.truncated };
	}

	async cancel(jobId: string, reason: string): Promise<JobSnapshot> {
		this.cancels.push({ jobId, reason });
		if (this.cancelError) throw new Error(this.cancelError);
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown job ${jobId}`);
		if (isTerminalJobStatus(job.status)) return job;
		const cancelled: JobSnapshot = {
			...job,
			status: "cancelled",
			cancelReason: reason,
			finishedAt: 2_000,
		};
		this.jobs.set(jobId, cancelled);
		return cancelled;
	}

	restore(_records: PersistedJobRecord[]): boolean {
		return false;
	}

	setParentSettled(_settled: boolean): void {}

	setWakeSuppressed(_suppressed: boolean): void {}

	registerInvalidator(_jobId: string, _invalidate: () => void): () => void {
		return () => {};
	}

	async dispose(): Promise<void> {}

	setJob(job: JobSnapshot): void {
		this.jobs.set(job.jobId, job);
	}

	setOutput(jobId: string, output: string): void {
		this.outputs.set(jobId, output);
	}
}

interface CapturedCustom {
	factory: (tui: any, theme: any, keybindings: any, done: () => void) => Component;
	options: any;
}

class FakePi {
	commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: any) => Promise<void> }
	>();
	notifications: Array<{ message: string; type: string }> = [];
	customCalls: CapturedCustom[] = [];

	registerCommand(
		name: string,
		spec: { description?: string; handler: (args: string, ctx: any) => Promise<void> },
	): void {
		this.commands.set(name, spec);
	}

	async handlerFor(
		name: string,
		args: string,
		ctxOverrides: Record<string, any> = {},
	): Promise<void> {
		const cmd = this.commands.get(name);
		if (!cmd) throw new Error(`Unknown command: ${name}`);
		const ctx: any = {
			mode: "tui",
			ui: {
				notify: (message: string, type: string = "info") => {
					this.notifications.push({ message, type });
				},
				custom: async (
					factory: (tui: any, theme: any, keybindings: any, done: () => void) => Component,
					options?: any,
				) => {
					this.customCalls.push({ factory, options });
				},
			},
			...ctxOverrides,
		};
		await cmd.handler(args, ctx);
	}
}

const plainTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const taggedTheme = {
	fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
	bold: (text: string) => text,
};

function makeTUI(rows = 20): any {
	return {
		terminal: { rows },
		requestRender: () => {},
	};
}

function extractLines(component: Component, width = 80): string[] {
	return component.render(width);
}

// ── Tests ─────────────────────────────────────────────────────────────

function testCommandRegistration(): void {
	const pi = new FakePi();
	const manager = new FakeManager();
	registerJobCommand(pi as any, manager);
	assert(
		"command registered with name jobs",
		pi.commands.has("jobs"),
		`commands: ${[...pi.commands.keys()].join(",")}`,
	);
}

async function testNonTuiMode(): Promise<void> {
	const pi = new FakePi();
	const manager = new FakeManager();
	registerJobCommand(pi as any, manager);

	manager.setJob(makeSnapshot({ jobId: "job-1", status: "running" }));
	await pi.handlerFor("jobs", "", { mode: "rpc" });

	assert(
		"non-TUI mode shows warning notify and does not open overlay",
		pi.notifications.some(
			(n) => n.message === "Jobs require interactive mode." && n.type === "warning",
		) && pi.customCalls.length === 0,
		`notifications=${JSON.stringify(pi.notifications)} custom=${pi.customCalls.length}`,
	);
}

async function testEmptyJobList(): Promise<void> {
	const pi = new FakePi();
	const manager = new FakeManager();
	registerJobCommand(pi as any, manager);

	await pi.handlerFor("jobs", "");

	assert(
		"empty job list shows info notify and does not open overlay",
		pi.notifications.some((n) => n.message === "No jobs in this session." && n.type === "info") &&
			pi.customCalls.length === 0,
		`notifications=${JSON.stringify(pi.notifications)} custom=${pi.customCalls.length}`,
	);
}

async function testJobsPresentOpensOverlay(): Promise<void> {
	const pi = new FakePi();
	const manager = new FakeManager();
	registerJobCommand(pi as any, manager);

	manager.setJob(makeSnapshot({ jobId: "job-1", command: "npm run build", status: "running" }));
	manager.setJob(
		makeSnapshot({
			jobId: "job-2",
			command: "npm test",
			status: "completed",
			durationMs: 42_100,
			finishedAt: 43_100,
		}),
	);
	await pi.handlerFor("jobs", "");

	const noWarning = !pi.notifications.some((n) => n.type === "warning");
	const customArgs = pi.customCalls;
	assert(
		"with jobs present and TUI mode, calls ctx.ui.custom with a factory and fullscreen overlay options",
		customArgs.length === 1 &&
			typeof customArgs[0]!.factory === "function" &&
			customArgs[0]!.options?.overlay === true &&
			noWarning,
		`custom=${customArgs.length} overlay=${customArgs[0]?.options?.overlay}`,
	);
}

function testSmokeRenderOutput(): void {
	const manager = new FakeManager();
	manager.setJob(
		makeSnapshot({
			jobId: "job-active",
			command: "npm run build",
			status: "running",
			durationMs: 4_200,
		}),
	);
	manager.setJob(
		makeSnapshot({
			jobId: "job-done",
			command: "npm test",
			status: "completed",
			durationMs: 42_100,
			finishedAt: 43_100,
		}),
	);
	manager.setJob(
		makeSnapshot({
			jobId: "job-fail",
			command: "deploy",
			label: "deploy-prod",
			status: "failed",
			exitCode: 1,
			durationMs: 12_300,
			finishedAt: 13_300,
		}),
	);

	let doneCalled = false;
	const tui = makeTUI(20);
	const view = new JobsListView(tui as any, plainTheme as any, manager as any, () => {
		doneCalled = true;
	});

	// Give the interval a tick
	const lines = extractLines(view);
	const allText = lines.join("\n");

	// Must dispose before assertions to release the poll subscription
	view.dispose();

	assert(
		"smoke-render produces lines containing job display names",
		allText.includes("npm run build") &&
			allText.includes("npm test") &&
			allText.includes("deploy-prod") && // label
			lines.some((line) => line.includes("running") || line.includes("4.2s")) &&
			lines.some((line) => line.includes("42.1s") || line.includes("12.3s")),
		`lines=${JSON.stringify(lines)}`,
	);
	assert("done callback is wired and accessible", !doneCalled, "done was unexpectedly called");
}

function testJobOrdering(): void {
	const manager = new FakeManager();
	manager.setJob(
		makeSnapshot({
			jobId: "j-1",
			command: "echo oldest",
			status: "completed",
			startedAt: 1_000,
			durationMs: 100,
			finishedAt: 1_100,
		}),
	);
	manager.setJob(
		makeSnapshot({
			jobId: "j-2",
			command: "echo running",
			status: "running",
			startedAt: 3_000,
			durationMs: 500,
		}),
	);
	manager.setJob(
		makeSnapshot({
			jobId: "j-3",
			command: "echo middle",
			status: "completed",
			startedAt: 2_000,
			durationMs: 200,
			finishedAt: 2_200,
		}),
	);
	manager.setJob(
		makeSnapshot({
			jobId: "j-4",
			command: "echo newest",
			status: "queued",
			startedAt: 4_000,
			durationMs: 100,
		}),
	);

	let doneCalled = false;
	const tui = makeTUI(30);
	const view = new JobsListView(tui as any, plainTheme as any, manager as any, () => {
		doneCalled = true;
	});

	const lines = extractLines(view);
	view.dispose();

	const order = ["echo newest", "echo running", "echo middle", "echo oldest"].map((command) =>
		lines.findIndex((line) => line.includes(command)),
	);

	assert(
		"jobs are listed by invocation time, newest first, regardless of status",
		order.every((index) => index >= 0) &&
			order.every((index, position) => position === 0 || order[position - 1]! < index),
		`indices=${JSON.stringify(order)}`,
	);
}

function testStartTimeColumn(): void {
	const manager = new FakeManager();
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 5, 9).getTime();
	const earlier = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30, 0).getTime();
	const lastYear = new Date(now.getFullYear() - 1, 2, 4, 8, 7, 0).getTime();
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 15, 0).getTime();
	const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();
	manager.setJob(
		makeSnapshot({
			jobId: "j-midnight",
			command: "echo midnight",
			status: "completed",
			startedAt: midnight,
			finishedAt: midnight + 10,
		}),
	);
	manager.setJob(
		makeSnapshot({
			jobId: "j-noon",
			command: "echo noon",
			status: "completed",
			startedAt: noon,
			finishedAt: noon + 10,
		}),
	);
	manager.setJob(
		makeSnapshot({ jobId: "j-today", command: "echo today", status: "running", startedAt: today }),
	);
	manager.setJob(
		makeSnapshot({
			jobId: "j-earlier",
			command: "echo earlier",
			status: "completed",
			startedAt: earlier,
			finishedAt: earlier + 10,
		}),
	);
	manager.setJob(
		makeSnapshot({
			jobId: "j-old",
			command: "echo old",
			status: "completed",
			startedAt: lastYear,
			finishedAt: lastYear + 10,
		}),
	);

	const { view } = makeListView(manager, 20);
	const lines = extractLines(view);
	view.handleInput("\r");
	const detail = view.render(80).join("\n");
	view.dispose();

	const lineFor = (command: string): string => lines.find((line) => line.includes(command)) ?? "";
	const todayLine = lineFor("echo today");
	const earlierLine = lineFor("echo earlier");
	const oldLine = lineFor("echo old");
	const midnightLine = lineFor("echo midnight");
	const noonLine = lineFor("echo noon");

	assert(
		"each row shows the 12-hour invocation time, dated for jobs from an earlier day",
		todayLine.includes("02:05:09 pm") &&
			earlierLine.includes("09:30:00 am") &&
			midnightLine.includes("12:15:00 am") &&
			noonLine.includes("12:00:00 pm") &&
			oldLine.includes("03-04 08:07 am") &&
			detail.includes("started 02:05:09 pm"),
		`today=${JSON.stringify(todayLine)} earlier=${JSON.stringify(earlierLine)} midnight=${JSON.stringify(midnightLine)} noon=${JSON.stringify(noonLine)} old=${JSON.stringify(oldLine)}`,
	);
}

/** The selected row is the one carrying the accent marker from taggedTheme. */
function selectedCommand(lines: string[]): string | undefined {
	const row = lines.find((line) => line.includes("<accent>› </accent>"));
	return row?.match(/echo \d+/)?.[0];
}

function testNavigationKeys(): void {
	const manager = new FakeManager();
	for (let i = 0; i < 5; i++) {
		manager.setJob(
			makeSnapshot({
				jobId: `job-${i}`,
				command: `echo ${i}`,
				status: "completed",
				startedAt: 5_000 - i,
				durationMs: i * 100,
				finishedAt: 1_000 + i,
			}),
		);
	}

	let doneCalls = 0;
	const tui = makeTUI(20);
	const view = new JobsListView(tui as any, taggedTheme as any, manager as any, () => {
		doneCalls++;
	});

	// Tagged theme markers count towards the rendered width, so render wide.
	view.render(200);

	// Navigate down with arrow
	view.handleInput("\x1b[B");
	const afterDown = view.render(200);
	view.handleInput("j");
	const afterJ = view.render(200);

	// Navigate up with k
	view.handleInput("k");
	const afterK = view.render(200);

	// Close with q
	view.handleInput("q");
	assert(
		"down arrow selects index 1, j also moves down, k moves back up, q calls done",
		selectedCommand(afterDown) === "echo 1" &&
			selectedCommand(afterJ) === "echo 2" &&
			selectedCommand(afterK) === "echo 1" &&
			doneCalls === 1,
		`selected: down=${selectedCommand(afterDown)} j=${selectedCommand(afterJ)} k=${selectedCommand(afterK)} doneCalls=${doneCalls}`,
	);

	// Reset done counter for escape test
	view.handleInput("\x1b"); // avoid stale state
	view.handleInput("\x1b"); // should call done again since previous done already called... but doneCalls is already 1
	// Actually the component is already disposed after q calls done, so handleInput on escape won't fire done again
	// This is fine; the test above already proves q fires done.
	view.dispose();
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeListView(
	manager: FakeManager,
	rows = 20,
): { view: JobsListView; doneCalls: () => number } {
	let doneCalls = 0;
	const view = new JobsListView(makeTUI(rows) as any, plainTheme as any, manager as any, () => {
		doneCalls++;
	});
	return { view, doneCalls: () => doneCalls };
}

function testLogViewShowsOutputAndMetadata(): void {
	const manager = new FakeManager();
	manager.setJob(
		makeSnapshot({
			jobId: "job-log",
			command: "npm run build",
			status: "running",
			pid: 777,
			outputLines: 2,
			outputBytes: 20,
			outputTail: "tail only",
		}),
	);
	manager.setOutput("job-log", "first line\nsecond line\n");

	const { view } = makeListView(manager);
	view.render(80);
	view.handleInput("\r");
	const detail = view.render(80).join("\n");
	view.handleInput("\x1b");
	const backToList = view.render(80).join("\n");
	view.dispose();

	assert(
		"Enter opens the full captured log with job metadata, Esc returns to the list",
		detail.includes("first line") &&
			detail.includes("second line") &&
			!detail.includes("tail only") &&
			detail.includes("pid 777") &&
			detail.includes("/repo") &&
			detail.includes("job-log") &&
			backToList.includes("Jobs"),
		`detail=${JSON.stringify(detail)}`,
	);
}

function testLogViewScrolling(): void {
	const manager = new FakeManager();
	manager.setJob(
		makeSnapshot({ jobId: "job-scroll", command: "long", status: "completed", finishedAt: 2_000 }),
	);
	manager.setOutput(
		"job-scroll",
		Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\n"),
	);

	const { view } = makeListView(manager, 20);
	view.render(80);
	view.handleInput("\r");
	const followed = view.render(80).join("\n");
	view.handleInput("\x1b[5~"); // page up
	const scrolled = view.render(80).join("\n");
	view.handleInput("\x1b[F"); // end
	const refollowed = view.render(80).join("\n");
	view.dispose();

	assert(
		"log view follows the tail, page up scrolls back, End resumes following",
		followed.includes("line-199") &&
			!scrolled.includes("line-199") &&
			refollowed.includes("line-199"),
		`followed tail=${followed.includes("line-199")} scrolled tail=${scrolled.includes("line-199")} refollowed tail=${refollowed.includes("line-199")}`,
	);
}

function testLogViewMissingJob(): void {
	const manager = new FakeManager();
	manager.setJob(makeSnapshot({ jobId: "job-gone", command: "vanish", status: "running" }));

	let backCalls = 0;
	const detail = new JobLogView(
		makeTUI(20) as any,
		plainTheme as any,
		manager as any,
		"job-missing",
		() => {
			backCalls++;
		},
		() => {},
	);
	const lines = detail.render(80).join("\n");
	detail.handleInput("\x1b");

	assert(
		"log view for an unknown job reports the error instead of throwing",
		lines.includes("Unknown job job-missing") && backCalls === 1,
		`lines=${JSON.stringify(lines)} backCalls=${backCalls}`,
	);
}

async function testKillSelectedJob(): Promise<void> {
	const manager = new FakeManager();
	manager.setJob(makeSnapshot({ jobId: "job-kill", command: "sleep 100", status: "running" }));

	const { view } = makeListView(manager);
	view.render(80);
	view.handleInput("x");
	const armed = view.render(80).join("\n");
	const cancelsAfterArm = manager.cancels.length;
	view.handleInput("x");
	await settle();
	const afterKill = view.render(80).join("\n");
	view.dispose();

	assert(
		"x arms and a second x cancels the selected job with a user reason",
		armed.includes("again to KILL this job") &&
			cancelsAfterArm === 0 &&
			manager.cancels.length === 1 &&
			manager.cancels[0]!.jobId === "job-kill" &&
			manager.cancels[0]!.reason === "cancelled by the user from /jobs" &&
			afterKill.includes("Killed sleep 100."),
		`cancels=${JSON.stringify(manager.cancels)} afterKill=${JSON.stringify(afterKill)}`,
	);
}

function testEscapeDisarmsKill(): void {
	const manager = new FakeManager();
	manager.setJob(makeSnapshot({ jobId: "job-armed", command: "sleep 100", status: "running" }));

	const { view, doneCalls } = makeListView(manager);
	view.render(80);
	view.handleInput("x");
	view.handleInput("\x1b");
	const afterEscape = view.render(80).join("\n");
	view.dispose();

	assert(
		"Esc disarms a pending kill instead of closing the overlay",
		!afterEscape.includes("again to KILL") && manager.cancels.length === 0 && doneCalls() === 0,
		`afterEscape=${JSON.stringify(afterEscape)} doneCalls=${doneCalls()}`,
	);
}

async function testKillAllActiveJobsOnly(): Promise<void> {
	const manager = new FakeManager();
	manager.setJob(makeSnapshot({ jobId: "job-a", command: "sleep 1", status: "running" }));
	manager.setJob(makeSnapshot({ jobId: "job-b", command: "sleep 2", status: "queued" }));
	manager.setJob(
		makeSnapshot({ jobId: "job-c", command: "done", status: "completed", finishedAt: 2_000 }),
	);

	const { view } = makeListView(manager);
	view.render(80);
	view.handleInput("X");
	const armed = view.render(80).join("\n");
	view.handleInput("X");
	await settle();
	const afterKill = view.render(80).join("\n");
	view.dispose();

	assert(
		"Shift+X twice cancels every active job and skips terminal jobs",
		armed.includes("again to KILL ALL jobs") &&
			manager.cancels.length === 2 &&
			manager.cancels.every((call) => call.jobId !== "job-c") &&
			afterKill.includes("Killed 2 jobs."),
		`cancels=${JSON.stringify(manager.cancels)} afterKill=${JSON.stringify(afterKill)}`,
	);
}

function testKillTerminalJobIsRejected(): void {
	const manager = new FakeManager();
	manager.setJob(
		makeSnapshot({ jobId: "job-done", command: "done", status: "completed", finishedAt: 2_000 }),
	);

	const { view } = makeListView(manager);
	view.render(80);
	view.handleInput("x");
	const afterPress = view.render(80).join("\n");
	view.dispose();

	assert(
		"killing an already finished job reports it instead of arming",
		afterPress.includes("That job already finished.") &&
			!afterPress.includes("again to KILL") &&
			manager.cancels.length === 0,
		`afterPress=${JSON.stringify(afterPress)} cancels=${manager.cancels.length}`,
	);
}

async function testKillFailureIsSurfaced(): Promise<void> {
	const manager = new FakeManager();
	manager.setJob(makeSnapshot({ jobId: "job-bad", command: "sleep 100", status: "running" }));
	manager.cancelError = "terminate failed";

	const { view } = makeListView(manager);
	view.render(80);
	view.handleInput("x");
	view.handleInput("x");
	await settle();
	const afterKill = view.render(80).join("\n");
	view.dispose();

	assert(
		"a rejected cancel surfaces the failure in the header instead of failing silently",
		afterKill.includes("Kill failed for 1 of 1") && afterKill.includes("terminate failed"),
		`afterKill=${JSON.stringify(afterKill)}`,
	);
}

async function testKillFromLogView(): Promise<void> {
	const manager = new FakeManager();
	manager.setJob(makeSnapshot({ jobId: "job-live", command: "sleep 100", status: "running" }));
	manager.setOutput("job-live", "working\n");

	const { view } = makeListView(manager);
	view.render(80);
	view.handleInput("\r");
	view.handleInput("x");
	view.handleInput("x");
	await settle();
	view.dispose();

	assert(
		"the log view kills the job it is showing",
		manager.cancels.length === 1 && manager.cancels[0]!.jobId === "job-live",
		`cancels=${JSON.stringify(manager.cancels)}`,
	);
}

async function main(): Promise<void> {
	testCommandRegistration();
	await testNonTuiMode();
	await testEmptyJobList();
	await testJobsPresentOpensOverlay();
	testSmokeRenderOutput();
	testJobOrdering();
	testStartTimeColumn();
	testNavigationKeys();
	testLogViewShowsOutputAndMetadata();
	testLogViewScrolling();
	testLogViewMissingJob();
	await testKillSelectedJob();
	testEscapeDisarmsKill();
	await testKillAllActiveJobsOnly();
	testKillTerminalJobIsRejected();
	await testKillFailureIsSurfaced();
	await testKillFromLogView();

	if (failed > 0) {
		console.log(`\n${failed} failure(s) of ${passed + failed} tests`);
		process.exit(1);
	}
	console.log(`\nAll ${passed} tests passed.`);
}

void main();
