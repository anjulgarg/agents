import * as path from "node:path";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	isTerminalJobStatus,
	type JobManagerApi,
	type JobResult,
	type JobSnapshot,
	type JobSpec,
	type PersistedJobRecord,
} from "./contracts.ts";
import {
	ASYNC_ACTIVITY_REFRESH_MS,
	JOB_STATE_ENTRY_TYPE,
	JOB_WAKE_MESSAGE_TYPE,
	latestJobRecords,
	registerJobsExtension,
	default as jobsExtensionDefault,
} from "./index.ts";
import { SHIMMER_TIMING } from "../lib/tui/index.ts";
import {
	DEFAULT_JOB_TIMEOUT_SECONDS,
	JOB_TOOLS,
	JobReceiptLine,
	MAX_JOB_TIMEOUT_SECONDS,
	STATUS_LIST_LIMIT,
	formatBytes,
	jobReceiptSegments,
	registerJobTools,
	resolveJobCwd,
	resolveJobTimeoutMs,
} from "./tools.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

async function rejects(action: () => Promise<unknown>): Promise<string> {
	try {
		await action();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "";
}

const plainTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as any;

const taggedTheme = {
	fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
	bold: (text: string) => text,
} as any;

const directories = new Set(["/repo", "/repo/sub", "/elsewhere"]);

assert(
	"job activity derives its repaint cadence from the shared shimmer contract",
	ASYNC_ACTIVITY_REFRESH_MS === SHIMMER_TIMING.frameIntervalMs && ASYNC_ACTIVITY_REFRESH_MS === 100,
	JSON.stringify({ ASYNC_ACTIVITY_REFRESH_MS, SHIMMER_TIMING }),
);

function makeSnapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
	return {
		jobId: "job-1",
		command: "npm run build",
		label: "",
		cwd: "/repo",
		status: "running",
		pid: 4242,
		startedAt: 1_000,
		durationMs: 4_200,
		timeoutMs: DEFAULT_JOB_TIMEOUT_SECONDS * 1000,
		outputBytes: 0,
		outputLines: 0,
		outputTail: "",
		truncated: false,
		...overrides,
	};
}

class FakeManager implements JobManagerApi {
	jobs = new Map<string, JobSnapshot>();
	started: JobSpec[] = [];
	cancels: Array<{ jobId: string; reason: string }> = [];
	restored: PersistedJobRecord[][] = [];
	settledCalls: boolean[] = [];
	suppressedCalls: boolean[] = [];
	invalidatorCalls: Array<{ jobId: string; invalidate: () => void }> = [];
	unregisterCount = 0;
	disposeCount = 0;
	resultValue: JobResult | undefined;
	private nextId = 1;
	private readonly listeners = new Set<() => void>();

	start(spec: JobSpec): JobSnapshot {
		const job = makeSnapshot({
			jobId: `job-${this.nextId++}`,
			command: spec.command,
			label: spec.label ?? "",
			cwd: spec.cwd,
			timeoutMs: spec.timeoutMs,
		});
		this.started.push(spec);
		this.jobs.set(job.jobId, job);
		this.emit();
		return job;
	}

	status(jobId?: string): JobSnapshot[] {
		if (jobId === undefined) return [...this.jobs.values()];
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown job ${jobId}`);
		return [job];
	}

	result(jobId: string): JobResult {
		const job = this.status(jobId)[0]!;
		return this.resultValue ?? { snapshot: job, output: job.outputTail, truncated: job.truncated };
	}

	async cancel(jobId: string, reason: string): Promise<JobSnapshot> {
		const job = this.status(jobId)[0]!;
		this.cancels.push({ jobId, reason });
		if (isTerminalJobStatus(job.status)) return job;
		const cancelled: JobSnapshot = {
			...job,
			status: "cancelled",
			cancelReason: reason,
			finishedAt: job.startedAt + job.durationMs,
		};
		this.jobs.set(jobId, cancelled);
		return cancelled;
	}

	restore(records: PersistedJobRecord[]): boolean {
		this.restored.push(records);
		for (const record of records) this.jobs.set(record.snapshot.jobId, record.snapshot);
		return records.length > 0;
	}

	setParentSettled(settled: boolean): void {
		this.settledCalls.push(settled);
	}

	setWakeSuppressed(suppressed: boolean): void {
		this.suppressedCalls.push(suppressed);
	}

	registerInvalidator(jobId: string, invalidate: () => void): () => void {
		this.invalidatorCalls.push({ jobId, invalidate });
		return () => {
			this.unregisterCount++;
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		this.disposeCount++;
	}

	setJob(job: JobSnapshot): void {
		this.jobs.set(job.jobId, job);
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

class FakePi {
	tools = new Map<string, any>();
	handlers = new Map<string, (event: any, ctx: any) => any>();
	renderers = new Map<string, any>();
	entries: Array<{ customType: string; data: any }> = [];
	messages: Array<{ message: any; options: any }> = [];

	constructor(private activeTools: string[] = ["bash", "job"]) {}

	registerTool(tool: any): void {
		this.tools.set(tool.name, tool);
	}

	registerMessageRenderer(customType: string, renderer: any): void {
		this.renderers.set(customType, renderer);
	}

	on(event: string, handler: (event: any, ctx: any) => any): void {
		this.handlers.set(event, handler);
	}

	appendEntry(customType: string, data: any): void {
		this.entries.push({ customType, data });
	}

	sendMessage(message: any, options?: any): void {
		this.messages.push({ message, options });
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	setActiveTools(names: string[]): void {
		this.activeTools = [...names];
	}
}

function setup(activeTools?: string[]): {
	pi: FakePi;
	manager: FakeManager;
	tool: (name: string) => any;
} {
	const pi = new FakePi(activeTools);
	const manager = new FakeManager();
	registerJobTools(pi as any, manager, { isDirectory: (candidate) => directories.has(candidate) });
	return { pi, manager, tool: (name: string) => pi.tools.get(name) };
}

function renderContext(overrides: Record<string, any> = {}): any {
	return {
		args: {},
		toolCallId: "call-1",
		invalidate: () => undefined,
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

const execCtx = { cwd: "/repo" } as any;

function renderRow(
	tool: any,
	manager: FakeManager,
	details: any,
	context: any = renderContext(),
	theme: any = plainTheme,
): { lines: string[]; component: any } {
	const component = tool.renderResult(
		{ content: [{ type: "text", text: "started" }], details },
		{ expanded: Boolean(context.expanded), isPartial: false },
		theme,
		context,
	);
	return { lines: component.render(80), component };
}

function testRegistrationAndSchemas(): void {
	const { pi, tool } = setup();
	const names = [...pi.tools.keys()];
	assert(
		"registers exactly the four job tools and never overrides bash",
		names.join(",") === JOB_TOOLS.join(",") && !pi.tools.has("bash"),
		names.join(","),
	);
	assert(
		"every job tool renders its own shell",
		names.every((name) => pi.tools.get(name).renderShell === "self"),
		JSON.stringify(names.map((name) => [name, pi.tools.get(name).renderShell])),
	);

	const job = tool("job");
	const params = job.parameters;
	assert(
		"job requires command and keeps label, cwd, and bounded timeout optional",
		params.required.join(",") === "command" &&
			params.properties.label !== undefined &&
			params.properties.cwd !== undefined &&
			params.properties.timeout.default === DEFAULT_JOB_TIMEOUT_SECONDS &&
			params.properties.timeout.minimum === 1 &&
			params.properties.timeout.maximum === MAX_JOB_TIMEOUT_SECONDS,
		JSON.stringify(params),
	);
	assert(
		"job advertises the wake contract and forbids polling",
		job.description.includes("WOKEN") &&
			job.description.includes("do not poll") &&
			job.promptGuidelines.some((line: string) =>
				line.includes("Never poll job_status in a loop"),
			) &&
			job.promptGuidelines.some((line: string) =>
				line.includes("continue useful work or end the turn"),
			) &&
			job.promptGuidelines.some((line: string) => line.includes("completion wake")),
		`${job.description}\n${JSON.stringify(job.promptGuidelines)}`,
	);

	const status = tool("job_status");
	assert(
		"job_status takes an optional jobId and explicitly forbids polling loops",
		status.parameters.required === undefined &&
			status.parameters.properties.jobId !== undefined &&
			status.description.includes("polling loop") &&
			status.description.includes("wake"),
		`${JSON.stringify(status.parameters)}\n${status.description}`,
	);
	assert(
		"job_result requires a jobId and job_cancel requires a jobId with a reason",
		tool("job_result").parameters.required.join(",") === "jobId" &&
			tool("job_cancel").parameters.required.join(",") === "jobId,reason",
		JSON.stringify([
			tool("job_result").parameters.required,
			tool("job_cancel").parameters.required,
		]),
	);
}

function testCwdAndTimeoutResolution(): void {
	const isDirectory = (candidate: string): boolean => directories.has(candidate);
	assert(
		"relative cwd resolves against the session directory and absolute paths are kept",
		resolveJobCwd("sub", "/repo", isDirectory) === path.resolve("/repo/sub") &&
			resolveJobCwd("/elsewhere", "/repo", isDirectory) === path.resolve("/elsewhere") &&
			resolveJobCwd(undefined, "/repo", isDirectory) === path.resolve("/repo"),
		[
			resolveJobCwd("sub", "/repo", isDirectory),
			resolveJobCwd("/elsewhere", "/repo", isDirectory),
		].join(","),
	);
	let cwdError = "";
	try {
		resolveJobCwd("missing", "/repo", isDirectory);
	} catch (error) {
		cwdError = error instanceof Error ? error.message : String(error);
	}
	assert(
		"missing cwd is rejected before the process starts",
		cwdError.includes("existing directory"),
		cwdError,
	);

	const timeoutErrors = [0, MAX_JOB_TIMEOUT_SECONDS + 1, 1.5].map((value) => {
		try {
			resolveJobTimeoutMs(value);
			return "";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	});
	assert(
		"timeout defaults to 1800s and rejects out-of-range or fractional seconds",
		resolveJobTimeoutMs(undefined) === DEFAULT_JOB_TIMEOUT_SECONDS * 1000 &&
			resolveJobTimeoutMs(1) === 1000 &&
			resolveJobTimeoutMs(MAX_JOB_TIMEOUT_SECONDS) === MAX_JOB_TIMEOUT_SECONDS * 1000 &&
			timeoutErrors.every((message) => message.length > 0) &&
			timeoutErrors[2]!.includes("whole number"),
		JSON.stringify(timeoutErrors),
	);
}

async function testStartActivationAndValidation(): Promise<void> {
	const { pi, manager, tool } = setup(["bash", "job"]);
	assert(
		"management tools stay inactive until the first job starts",
		pi.getActiveTools().join(",") === "bash,job",
		pi.getActiveTools().join(","),
	);

	const started = await tool("job").execute(
		"call-1",
		{ command: "  npm run build  ", label: " build ", cwd: "sub", timeout: 60 },
		undefined,
		undefined,
		execCtx,
	);
	const text = started.content[0].text;
	assert(
		"job starts one process, trims inputs, and resolves the requested cwd",
		manager.started.length === 1 &&
			manager.started[0]!.command === "npm run build" &&
			manager.started[0]!.label === "build" &&
			manager.started[0]!.cwd === path.resolve("/repo/sub") &&
			manager.started[0]!.timeoutMs === 60_000,
		JSON.stringify(manager.started),
	);
	assert(
		"start result promises a wake, forbids polling, and carries the job handle",
		text.includes("WOKEN") &&
			text.includes("do not poll") &&
			text.includes("jobId=job-1") &&
			started.details.jobId === "job-1" &&
			started.details.cwd === path.resolve("/repo/sub"),
		`${text}\n${JSON.stringify(started.details)}`,
	);
	assert(
		"management tools activate after the first start without dropping other tools",
		pi.getActiveTools().join(",") === "bash,job,job_status,job_result,job_cancel",
		pi.getActiveTools().join(","),
	);

	const emptyCommand = await rejects(() =>
		tool("job").execute("call-2", { command: "   " }, undefined, undefined, execCtx),
	);
	const badCwd = await rejects(() =>
		tool("job").execute("call-3", { command: "ls", cwd: "nope" }, undefined, undefined, execCtx),
	);
	const badTimeout = await rejects(() =>
		tool("job").execute("call-4", { command: "ls", timeout: 0 }, undefined, undefined, execCtx),
	);
	assert(
		"job rejects empty commands, unusable directories, and invalid timeouts",
		emptyCommand.includes("non-empty command") &&
			badCwd.includes("existing directory") &&
			badTimeout.includes("between 1 and 86400") &&
			manager.started.length === 1,
		JSON.stringify({ emptyCommand, badCwd, badTimeout }),
	);

	const defaulted = await tool("job").execute(
		"call-5",
		{ command: "sleep 5" },
		undefined,
		undefined,
		execCtx,
	);
	assert(
		"omitted timeout and cwd fall back to 1800s in the session directory",
		manager.started[1]!.timeoutMs === DEFAULT_JOB_TIMEOUT_SECONDS * 1000 &&
			manager.started[1]!.cwd === path.resolve("/repo") &&
			defaulted.details.jobId === "job-2",
		JSON.stringify(manager.started[1]),
	);
}

async function testStatusResultCancel(): Promise<void> {
	const { manager, tool } = setup();
	manager.setJob(
		makeSnapshot({ jobId: "job-1", status: "running", outputLines: 3, outputBytes: 2048 }),
	);
	manager.setJob(
		makeSnapshot({
			jobId: "job-2",
			command: "npm test",
			status: "failed",
			exitCode: 1,
			durationMs: 42_100,
			finishedAt: 43_100,
			outputTail: "1 failing\nassert error",
			outputLines: 2,
			outputBytes: 22,
		}),
	);

	const all = await tool("job_status").execute("s1", {}, undefined, undefined, execCtx);
	const one = await tool("job_status").execute(
		"s2",
		{ jobId: "job-2" },
		undefined,
		undefined,
		execCtx,
	);
	const unknown = await rejects(() =>
		tool("job_status").execute("s3", { jobId: "nope" }, undefined, undefined, execCtx),
	);
	assert(
		"job_status returns bounded snapshots for all jobs or one job and surfaces unknown ids",
		all.content[0].text.includes("jobId=job-1") &&
			all.content[0].text.includes("jobId=job-2") &&
			all.details.length === 2 &&
			one.content[0].text.includes("status=failed") &&
			one.content[0].text.includes("exit=1") &&
			one.content[0].text.includes("tail:") &&
			!one.content[0].text.includes("jobId=job-1") &&
			unknown.includes("Unknown job"),
		`${all.content[0].text}\n---\n${one.content[0].text}\n---\n${unknown}`,
	);

	manager.resultValue = {
		snapshot: manager.status("job-2")[0]!,
		output: "1 failing\nassert error",
		truncated: true,
	};
	const result = await tool("job_result").execute(
		"r1",
		{ jobId: "job-2" },
		undefined,
		undefined,
		execCtx,
	);
	assert(
		"job_result returns bounded output with metadata and a truncation notice",
		result.content[0].text.includes("assert error") &&
			result.content[0].text.includes("jobId=job-2") &&
			result.content[0].text.includes("output truncated") &&
			result.details.truncated === true,
		result.content[0].text,
	);
	const missingId = await rejects(() =>
		tool("job_result").execute("r2", { jobId: "  " }, undefined, undefined, execCtx),
	);
	assert("job_result requires a jobId", missingId.includes("requires a jobId"), missingId);

	const emptyReason = await rejects(() =>
		tool("job_cancel").execute(
			"c0",
			{ jobId: "job-1", reason: "  " },
			undefined,
			undefined,
			execCtx,
		),
	);
	const cancelled = await tool("job_cancel").execute(
		"c1",
		{ jobId: "job-1", reason: "superseded by a newer build" },
		undefined,
		undefined,
		execCtx,
	);
	const again = await tool("job_cancel").execute(
		"c2",
		{ jobId: "job-1", reason: "superseded by a newer build" },
		undefined,
		undefined,
		execCtx,
	);
	assert(
		"job_cancel demands a reason, cancels once, and stays idempotent for terminal jobs",
		emptyReason.includes("non-empty reason") &&
			cancelled.content[0].text.startsWith("Cancelled job job-1") &&
			cancelled.details.status === "cancelled" &&
			cancelled.details.cancelReason === "superseded by a newer build" &&
			again.content[0].text.includes("already finished as cancelled") &&
			again.details.status === "cancelled" &&
			manager.cancels.length === 2,
		`${emptyReason}\n${cancelled.content[0].text}\n${again.content[0].text}`,
	);
}

async function testStatusListCap(): Promise<void> {
	const { manager, tool } = setup();
	const total = STATUS_LIST_LIMIT + 5;
	for (let i = 1; i <= total; i++) {
		manager.setJob(
			makeSnapshot({
				jobId: `job-${i}`,
				command: `echo ${i}`,
				status: "completed",
				durationMs: i * 100,
				finishedAt: 1_000 + i,
			}),
		);
	}
	const all = await tool("job_status").execute("cap-all", {}, undefined, undefined, execCtx);
	const text = all.content[0].text as string;
	assert(
		"status without an id shows the most recent 20 jobs and reports how many were omitted",
		text.startsWith(`[${total - STATUS_LIST_LIMIT} earlier jobs omitted]`) &&
			!text.includes("jobId=job-1 status=") &&
			text.includes("jobId=job-6 status=") &&
			text.includes(`jobId=job-${total} status=`) &&
			all.details.length === STATUS_LIST_LIMIT &&
			all.details[0]!.jobId === "job-6" &&
			all.details.at(-1)!.jobId === `job-${total}`,
		`${text}\n${JSON.stringify(all.details.map((job: JobSnapshot) => job.jobId))}`,
	);

	const one = await tool("job_status").execute(
		"cap-one",
		{ jobId: "job-1" },
		undefined,
		undefined,
		execCtx,
	);
	assert(
		"explicit-id status remains exact and is not capped",
		one.content[0].text.includes("jobId=job-1") &&
			!one.content[0].text.includes("earlier jobs omitted") &&
			one.details.length === 1 &&
			one.details[0]!.jobId === "job-1",
		one.content[0].text,
	);
}

function testReceiptRows(): void {
	const { manager, tool } = setup();
	const details = {
		jobId: "job-1",
		command: "npm run build",
		label: "",
		cwd: "/repo",
		timeoutMs: 1_800_000,
	};
	const rows: Record<string, string> = {};

	manager.setJob(makeSnapshot({ status: "running", durationMs: 4_200 }));
	rows.running = renderRow(tool("job"), manager, details, renderContext({ toolCallId: "row-run" }))
		.lines.join("\n")
		.trim();

	manager.setJob(makeSnapshot({ status: "queued", durationMs: 4_200 }));
	rows.queued = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-queued" }),
	)
		.lines.join("\n")
		.trim();

	manager.setJob(makeSnapshot({ status: "stopping", durationMs: 4_200 }));
	rows.stopping = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-stopping" }),
	)
		.lines.join("\n")
		.trim();

	manager.setJob(makeSnapshot({ status: "running", durationMs: 4_200, label: "build" }));
	rows.labelled = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-label" }),
	)
		.lines.join("\n")
		.trim();

	manager.setJob(
		makeSnapshot({
			status: "completed",
			label: "",
			exitCode: 0,
			durationMs: 42_100,
			finishedAt: 43_100,
		}),
	);
	rows.completed = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-done" }),
	)
		.lines.join("\n")
		.trim();

	manager.setJob(
		makeSnapshot({ status: "failed", exitCode: 1, durationMs: 42_100, finishedAt: 43_100 }),
	);
	rows.failed = renderRow(tool("job"), manager, details, renderContext({ toolCallId: "row-fail" }))
		.lines.join("\n")
		.trim();

	manager.setJob(makeSnapshot({ status: "cancelled", durationMs: 42_100, finishedAt: 43_100 }));
	rows.cancelled = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-cancel" }),
	)
		.lines.join("\n")
		.trim();

	manager.setJob(makeSnapshot({ status: "timed_out", durationMs: 42_100, finishedAt: 43_100 }));
	rows.timedOut = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-timeout" }),
	)
		.lines.join("\n")
		.trim();

	manager.setJob(makeSnapshot({ status: "interrupted", durationMs: 42_100, finishedAt: 43_100 }));
	rows.interrupted = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-int" }),
	)
		.lines.join("\n")
		.trim();

	assert(
		"running jobs stay out of the transcript while final receipts retain their format",
		rows.running === "" &&
			rows.labelled === "" &&
			rows.completed === "& npm run build · 42.1s" &&
			rows.failed === "& npm run build · exit 1 · 42.1s",
		JSON.stringify(rows),
	);
	assert(
		"queued and stopping jobs stay out of the transcript",
		rows.queued === "" && rows.stopping === "",
		JSON.stringify({ queued: rows.queued, stopping: rows.stopping }),
	);
	assert(
		"timeout, cancel, and interrupt render as suffixes on the same receipt",
		rows.cancelled === "& npm run build · cancelled · 42.1s" &&
			rows.timedOut === "& npm run build · timeout · 42.1s" &&
			rows.interrupted === "& npm run build · interrupted · 42.1s",
		JSON.stringify(rows),
	);
	const callRow = tool("job")
		.renderCall({ command: "npm run build" }, plainTheme, renderContext({ toolCallId: "row-call" }))
		.render(80);
	const expandedCallRow = tool("job")
		.renderCall(
			{ command: "npm run build" },
			plainTheme,
			renderContext({ toolCallId: "row-call-x", expanded: true }),
		)
		.render(80);
	assert(
		"the receipt is the only job row: renderCall stays empty in both states",
		callRow.length === 0 && expandedCallRow.length === 0,
		JSON.stringify({ callRow, expandedCallRow }),
	);
	assert(
		"final job receipts never add success checkmarks or a leading failure cross",
		Object.values(rows)
			.filter(Boolean)
			.every(
				(row) =>
					!row.includes("✓") && !row.includes("✗") && !row.includes("×") && row.startsWith("& "),
			),
		JSON.stringify(rows),
	);
	const failedSnapshot = makeSnapshot({
		status: "failed",
		exitCode: 1,
		durationMs: 42_100,
		finishedAt: 43_100,
		command: "a very long command that must remain bounded",
	});
	const narrowRows = [3, 8, 16].flatMap((width) =>
		new JobReceiptLine(plainTheme, jobReceiptSegments(failedSnapshot)).render(width),
	);
	assert(
		"job receipts remain within narrow terminal widths",
		narrowRows.every((line, index) => visibleWidth(line) <= [3, 8, 16][index]!),
		JSON.stringify(narrowRows),
	);
}

function testTranscriptLivenessAndStyling(): void {
	const { manager, tool } = setup();
	const details = {
		jobId: "job-1",
		command: "npm run build",
		label: "",
		cwd: "/repo",
		timeoutMs: 1_800_000,
	};
	let invalidateCalls = 0;
	const invalidate = (): void => {
		invalidateCalls++;
	};
	const context = renderContext({
		toolCallId: "row-live",
		invalidate,
		isPartial: false,
		executionStarted: false,
	});

	manager.setJob(makeSnapshot({ status: "running", durationMs: 4_200 }));
	const live = renderRow(tool("job"), manager, details, context);
	assert(
		"running receipts remain absent from transcript rendering",
		live.lines.length === 0 && context.isPartial === false && context.executionStarted === false,
		JSON.stringify(live.lines),
	);
	assert(
		"running transcript receipts never join the manager animation clock",
		manager.invalidatorCalls.length === 0,
		JSON.stringify(manager.invalidatorCalls.map((call) => call.jobId)),
	);
	manager.setJob(makeSnapshot({ status: "completed", durationMs: 42_100, finishedAt: 43_100 }));
	const settled = renderRow(tool("job"), manager, details, context);
	assert(
		"completion invalidates once to reveal the final transcript receipt",
		manager.unregisterCount === 0 &&
			invalidateCalls === 1 &&
			settled.lines.join("").includes("42.1s"),
		`${manager.unregisterCount} ${invalidateCalls} ${JSON.stringify(settled.lines)}`,
	);

	manager.invalidatorCalls.length = 0;
	manager.unregisterCount = 0;
	const queuedContext = renderContext({ toolCallId: "row-queued-live", invalidate });
	manager.setJob(makeSnapshot({ status: "queued", durationMs: 4_200 }));
	const queued = renderRow(tool("job"), manager, details, queuedContext);
	manager.setJob(makeSnapshot({ status: "stopping", durationMs: 4_200 }));
	const stopping = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-stopping-live", invalidate }),
	);
	assert(
		"queued and stopping jobs stay hidden without animation invalidators",
		queued.lines.length === 0 &&
			stopping.lines.length === 0 &&
			manager.invalidatorCalls.length === 0,
		JSON.stringify({
			queued: queued.lines,
			stopping: stopping.lines,
			invalidators: manager.invalidatorCalls.length,
		}),
	);

	// Settled rows carry no shimmer, so their styling is phase-independent.
	manager.setJob(makeSnapshot({ status: "completed", durationMs: 42_100, finishedAt: 43_100 }));
	const styledCommand = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-style" }),
		taggedTheme,
	).lines.join("\n");
	manager.setJob(
		makeSnapshot({
			status: "completed",
			label: "nightly",
			durationMs: 42_100,
			finishedAt: 43_100,
		}),
	);
	const styledLabel = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-style-label" }),
		taggedTheme,
	).lines.join("\n");
	assert(
		"only the & prefix is a tool title; command, label, and duration stay muted",
		styledCommand.includes("<toolTitle>& </toolTitle>") &&
			styledCommand.includes("<muted>npm run build</muted>") &&
			styledCommand.includes("<muted> · 42.1s</muted>") &&
			styledLabel.includes("<muted>nightly</muted>") &&
			styledLabel.includes("<muted> · 42.1s</muted>") &&
			!styledCommand.includes("<accent>") &&
			!styledCommand.includes("environment"),
		`${styledCommand}\n${styledLabel}`,
	);

	manager.setJob(
		makeSnapshot({ status: "failed", exitCode: 1, durationMs: 42_100, finishedAt: 43_100 }),
	);
	const styledFailed = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-style-fail" }),
		taggedTheme,
	).lines.join("\n");
	manager.setJob(makeSnapshot({ status: "timed_out", durationMs: 42_100, finishedAt: 43_100 }));
	const styledTimeout = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-style-timeout" }),
		taggedTheme,
	).lines.join("\n");
	manager.setJob(makeSnapshot({ status: "cancelled", durationMs: 42_100, finishedAt: 43_100 }));
	const styledCancelled = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-style-cancel" }),
		taggedTheme,
	).lines.join("\n");
	manager.setJob(makeSnapshot({ status: "interrupted", durationMs: 42_100, finishedAt: 43_100 }));
	const styledInterrupted = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-style-int" }),
		taggedTheme,
	).lines.join("\n");
	assert(
		"terminal failure and timeout suffixes use error; cancel and interrupt use warning",
		styledFailed.includes("<error> · exit 1</error>") &&
			styledFailed.includes("<muted> · 42.1s</muted>") &&
			styledTimeout.includes("<error> · timeout</error>") &&
			styledCancelled.includes("<warning> · cancelled</warning>") &&
			styledInterrupted.includes("<warning> · interrupted</warning>") &&
			styledFailed.includes("<toolTitle>& </toolTitle>") &&
			!styledFailed.includes("✓") &&
			!styledFailed.includes("×"),
		JSON.stringify({ styledFailed, styledTimeout, styledCancelled, styledInterrupted }),
	);
}

function testExpandedLiveDetailsStayStatic(): void {
	const { manager, tool } = setup();
	const details = {
		jobId: "job-1",
		command: "npm run build",
		label: "",
		cwd: "/repo",
		timeoutMs: 1_800_000,
	};
	const invalidate = (): void => undefined;
	manager.setJob(makeSnapshot({ status: "running", durationMs: 4_200 }));

	const collapsed = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-live", invalidate }),
	);
	assert(
		"collapsed running receipts remain absent and static",
		collapsed.lines.length === 0 && manager.invalidatorCalls.length === 0,
		JSON.stringify(collapsed.lines),
	);

	const expanded = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-live", invalidate, expanded: true }),
	);
	assert(
		"expanded running details remain available without joining the animation clock",
		expanded.lines.join("\n").includes("status running") && manager.invalidatorCalls.length === 0,
		JSON.stringify(expanded.lines),
	);
}

function testExpandedDetailsAndErrors(): void {
	const { manager, tool } = setup();
	const details = {
		jobId: "job-1",
		command: "npm run build",
		label: "nightly",
		cwd: "/repo",
		timeoutMs: 1_800_000,
	};
	const outputTail = "build failed\nmissing module";
	manager.setJob(
		makeSnapshot({
			label: "nightly",
			status: "failed",
			exitCode: 1,
			pid: 4242,
			durationMs: 42_100,
			finishedAt: 43_100,
			outputTail,
			outputLines: 2,
			outputBytes: 5_000,
			truncated: true,
		}),
	);
	const expanded = renderRow(
		tool("job"),
		manager,
		details,
		renderContext({ toolCallId: "row-expanded", expanded: true }),
	).lines.join("\n");
	const displayedTailBytes = Buffer.byteLength(outputTail, "utf8");
	assert(
		"Ctrl+O reveals command, jobId, cwd, pid, timeout, bounded output, and truncation",
		expanded.includes("npm run build") &&
			expanded.includes("jobId job-1") &&
			expanded.includes("cwd /repo") &&
			expanded.includes("pid 4242") &&
			expanded.includes("timeout 1800s") &&
			expanded.includes("missing module") &&
			expanded.includes("output truncated"),
		expanded,
	);
	assert(
		"expanded truncation note reports the displayed tail size, not total output bytes",
		expanded.includes(`showing the last ${formatBytes(displayedTailBytes)} of captured output`) &&
			!expanded.includes(`showing the last ${formatBytes(5_000)} of captured output`),
		expanded,
	);

	const styledDetails = tool("job")
		.renderResult(
			{ content: [{ type: "text", text: "started" }], details },
			{ expanded: true, isPartial: false },
			taggedTheme,
			renderContext({ toolCallId: "row-expanded-style", expanded: true }),
		)
		.render(200)
		.join("\n");
	assert(
		"expanded job details keep command, cwd, timeout, and duration muted",
		styledDetails.includes("<toolTitle>& </toolTitle>") &&
			styledDetails.includes("<muted>npm run build</muted>") &&
			styledDetails.includes("<muted>  cwd /repo</muted>") &&
			styledDetails.includes("<muted>  timeout 1800s</muted>") &&
			styledDetails.includes("<muted>  duration 42.1s</muted>"),
		styledDetails,
	);

	const failedStart = tool("job")
		.renderResult(
			{
				content: [{ type: "text", text: "job cwd is not an existing directory: /nope" }],
				details: undefined,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			renderContext({ toolCallId: "row-error", isError: true }),
		)
		.render(80)
		.join("\n")
		.trim();
	assert(
		"a failed start stays visible as one receipt without a leading cross",
		failedStart.startsWith("& ") &&
			failedStart.includes("not an existing directory") &&
			!failedStart.includes("×") &&
			!failedStart.includes("✗"),
		failedStart,
	);
}

function testManagementRowVisibility(): void {
	const { tool } = setup();
	const collapsed = renderContext({ toolCallId: "mgmt-1" });
	const expanded = renderContext({ toolCallId: "mgmt-2", expanded: true });
	const errored = renderContext({ toolCallId: "mgmt-3", isError: true });
	const success = { content: [{ type: "text", text: "jobId=job-1 status=running" }] };
	const failure = { content: [{ type: "text", text: "Unknown job nope" }] };

	const render = (name: string, result: any, context: any): string =>
		tool(name)
			.renderResult(
				result,
				{ expanded: Boolean(context.expanded), isPartial: false },
				plainTheme,
				context,
			)
			.render(80)
			.join("\n")
			.trim();
	const call = (name: string, context: any): string =>
		tool(name).renderCall({ jobId: "job-1" }, plainTheme, context).render(80).join("\n").trim();

	assert(
		"successful status, result, and cancel rows stay collapsed and silent",
		["job_status", "job_result", "job_cancel"].every(
			(name) => render(name, success, collapsed) === "" && call(name, collapsed) === "",
		),
		JSON.stringify(
			["job_status", "job_result", "job_cancel"].map((name) => render(name, success, collapsed)),
		),
	);
	assert(
		"expanded management rows show their bounded details and errors stay visible collapsed",
		render("job_status", success, expanded).includes("jobId=job-1") &&
			call("job_status", expanded).includes("job status") &&
			render("job_status", failure, errored).includes("Unknown job nope") &&
			render("job_result", failure, errored).includes("Unknown job nope") &&
			render("job_cancel", failure, errored).includes("Unknown job nope"),
		`${render("job_status", success, expanded)} | ${render("job_status", failure, errored)}`,
	);
}

async function testFixedActivityPanel(): Promise<void> {
	const pi = new FakePi(["bash"]);
	const manager = new FakeManager();
	registerJobsExtension(pi as any, { createManager: () => manager, isDirectory: () => true });
	let widget: any;
	let renderRequests = 0;
	const tui = { requestRender: () => renderRequests++ } as any;
	const ui = {
		theme: plainTheme,
		setWidget: (_key: string, content: any) => {
			widget?.dispose?.();
			widget = typeof content === "function" ? content(tui, plainTheme) : undefined;
		},
	} as any;
	const ctx = {
		mode: "tui",
		cwd: "/repo",
		ui,
		sessionManager: { getBranch: () => [] },
	} as any;
	await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	const jobTool = pi.tools.get("job")!;
	for (let index = 1; index <= 5; index++) {
		await jobTool.execute(
			`call-${index}`,
			{ command: `command-${index}`, label: `label-${index}` },
			undefined,
			undefined,
			ctx,
		);
	}
	const running = widget.render(80).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert(
		"running async commands occupy the fixed panel with command text and overflow",
		running.length === 3 &&
			running[0]!.includes("& command-1 · 4.2s") &&
			!running[0]!.includes("running") &&
			!running[0]!.includes("label-1") &&
			running[2]!.includes("+ 3 more async commands"),
		JSON.stringify(running),
	);

	for (const job of manager.status()) {
		manager.setJob({
			...job,
			status: "completed",
			finishedAt: job.startedAt + job.durationMs,
		});
	}
	assert(
		"completed async commands leave the panel and stop its animation host",
		widget === undefined && renderRequests > 0,
		JSON.stringify({ widget: Boolean(widget), renderRequests }),
	);
	await pi.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
}

async function testLifecycleAndPersistence(): Promise<void> {
	const pi = new FakePi(["bash"]);
	const manager = new FakeManager();
	let managerOptions: any;
	registerJobsExtension(pi as any, {
		createManager: (options: any) => {
			managerOptions = options;
			return manager;
		},
		isDirectory: () => true,
	});

	const record = (jobId: string, status: JobSnapshot["status"]): any => ({
		type: "custom",
		customType: JOB_STATE_ENTRY_TYPE,
		data: { snapshot: makeSnapshot({ jobId, status }) },
	});
	const ctxWith = (options: { branch?: any[]; entries?: any[] }): any => ({
		cwd: "/repo",
		sessionManager: {
			...(options.branch ? { getBranch: () => options.branch } : {}),
			...(options.entries ? { getEntries: () => options.entries } : {}),
		},
	});

	const branchOnly = [
		record("job-1", "running"),
		record("job-2", "running"),
		record("job-1", "completed"),
		{ type: "custom", customType: "other", data: {} },
	];
	const leakedFork = [...branchOnly, record("job-fork", "running")];
	await pi.handlers.get("session_start")!(
		{ type: "session_start", reason: "resume" },
		ctxWith({
			branch: branchOnly,
			entries: leakedFork,
		}),
	);
	assert(
		"session_start restores the latest record per job and activates the management tools",
		manager.restored[0]!.length === 2 &&
			manager.restored[0]!.find((item) => item.snapshot.jobId === "job-1")!.snapshot.status ===
				"completed" &&
			!manager.restored[0]!.some((item) => item.snapshot.jobId === "job-fork") &&
			pi.getActiveTools().join(",") === "bash,job,job_status,job_result,job_cancel",
		`${JSON.stringify(manager.restored[0])}\n${pi.getActiveTools().join(",")}`,
	);

	const branchScoped = latestJobRecords(
		ctxWith({
			branch: [record("job-branch", "completed")],
			entries: [record("job-branch", "completed"), record("job-other", "running")],
		}),
	);
	const entriesFallback = latestJobRecords(
		ctxWith({
			entries: [record("job-entries", "completed")],
		}),
	);
	assert(
		"latestJobRecords prefers getBranch and only falls back to getEntries",
		branchScoped.length === 1 &&
			branchScoped[0]!.snapshot.jobId === "job-branch" &&
			entriesFallback.length === 1 &&
			entriesFallback[0]!.snapshot.jobId === "job-entries",
		JSON.stringify({ branchScoped, entriesFallback }),
	);

	const fresh = new FakePi(["bash", "job_status"]);
	const freshManager = new FakeManager();
	registerJobsExtension(fresh as any, { createManager: () => freshManager });
	await fresh.handlers.get("session_start")!(
		{ type: "session_start", reason: "startup" },
		ctxWith({
			entries: [],
		}),
	);
	assert(
		"a session without job history keeps job active and drops the management tools",
		fresh.getActiveTools().join(",") === "bash,job",
		fresh.getActiveTools().join(","),
	);

	await pi.handlers.get("before_agent_start")!(
		{ type: "before_agent_start", systemPrompt: "" },
		{},
	);
	await pi.handlers.get("agent_settled")!({ type: "agent_settled" }, {});
	assert(
		"turn boundaries mark the parent active then settled and unsuppress wakes",
		manager.settledCalls.join(",") === "false,true" &&
			manager.suppressedCalls.join(",") === "false,false",
		`${manager.settledCalls.join(",")} | ${manager.suppressedCalls.join(",")}`,
	);

	// Each compaction carries its own signal, so use one controller per attempt.
	const completed = new AbortController();
	const aborted = new AbortController();
	await pi.handlers.get("session_before_compact")!(
		{ type: "session_before_compact", signal: completed.signal },
		{},
	);
	await pi.handlers.get("session_compact")!({ type: "session_compact" }, {});
	await pi.handlers.get("session_before_compact")!(
		{ type: "session_before_compact", signal: aborted.signal },
		{},
	);
	aborted.abort();
	assert(
		"compaction suppresses wakes and resumes them after completion or abort",
		manager.suppressedCalls.join(",") === "false,false,true,false,true,false",
		manager.suppressedCalls.join(","),
	);

	manager.suppressedCalls.length = 0;
	const failedCompact = new AbortController();
	await pi.handlers.get("session_before_compact")!(
		{ type: "session_before_compact", signal: failedCompact.signal },
		{},
	);
	await pi.handlers.get("agent_settled")!({ type: "agent_settled" }, {});
	assert(
		"agent_settled clears wake suppression after a failed compaction without session_compact",
		manager.suppressedCalls.join(",") === "true,false" &&
			!failedCompact.signal.aborted &&
			manager.settledCalls.at(-1) === true,
		manager.suppressedCalls.join(","),
	);

	managerOptions.persist({ snapshot: makeSnapshot({ jobId: "job-9", status: "completed" }) });
	assert(
		"manager transitions persist as job-state session entries",
		pi.entries.length === 1 &&
			pi.entries[0]!.customType === JOB_STATE_ENTRY_TYPE &&
			pi.entries[0]!.data.snapshot.jobId === "job-9",
		JSON.stringify(pi.entries),
	);

	managerOptions.sendWake("Job job-1 completed with exit 0");
	managerOptions.sendWake("Job job-2 failed with exit 1", "steer");
	const [plainWake, steerWake] = pi.messages;
	assert(
		"completion wakes are hidden orchestration messages that trigger a turn",
		plainWake!.message.customType === JOB_WAKE_MESSAGE_TYPE &&
			plainWake!.message.display === false &&
			plainWake!.options.triggerTurn === true &&
			plainWake!.options.deliverAs === undefined &&
			plainWake!.message.content.includes("not user input") &&
			plainWake!.message.content.includes("Do not narrate") &&
			plainWake!.message.content.includes("Do not poll") &&
			plainWake!.message.content.includes("Job job-1 completed with exit 0"),
		JSON.stringify(plainWake),
	);
	assert(
		"steer delivery is applied only when the manager supplies it",
		steerWake!.options.deliverAs === "steer" && steerWake!.options.triggerTurn === true,
		JSON.stringify(steerWake!.options),
	);

	await pi.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, {});
	assert(
		"session shutdown awaits manager disposal",
		manager.disposeCount === 1,
		String(manager.disposeCount),
	);

	const child = new FakePi(["bash"]);
	const previous = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	try {
		jobsExtensionDefault(child as any);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
	assert(
		"subagent children never own external jobs",
		child.tools.size === 0 && child.handlers.size === 0,
		`${child.tools.size}/${child.handlers.size}`,
	);
}

testRegistrationAndSchemas();
testCwdAndTimeoutResolution();
await testStartActivationAndValidation();
await testStatusResultCancel();
await testStatusListCap();
testReceiptRows();
testTranscriptLivenessAndStyling();
testExpandedLiveDetailsStayStatic();
testExpandedDetailsAndErrors();
testManagementRowVisibility();
await testFixedActivityPanel();
await testLifecycleAndPersistence();
