import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	ExpandableToolRender,
	TOOL_CHAT_PADDING,
	emptyCollapsedToolRender,
	formatToolDuration,
} from "../lib/tui/index.ts";
import {
	JOB_MANAGEMENT_TOOLS,
	isTerminalJobStatus,
	type JobManagerApi,
	type JobResult,
	type JobSnapshot,
} from "./contracts.ts";

export { JOB_MANAGEMENT_TOOLS } from "./contracts.ts";

export const JOB_TOOLS = ["job", ...JOB_MANAGEMENT_TOOLS] as const;
/** Receipt prefix. Mirrors the `$ ` bash prefix without joining its group. */
export const JOB_PREFIX = "& ";
export const CHAT_PADDING = TOOL_CHAT_PADDING;
export const DEFAULT_JOB_TIMEOUT_SECONDS = 1800;
export const MIN_JOB_TIMEOUT_SECONDS = 1;
export const MAX_JOB_TIMEOUT_SECONDS = 86400;
export const MAX_JOB_LABEL_LENGTH = 48;
/** Status tail lines kept in the bounded `job_status` report. */
const STATUS_TAIL_LINES = 10;
/** Most recent jobs shown when `job_status` is called without a jobId. */
export const STATUS_LIST_LIMIT = 20;

export const JOB_ASYNC_GUIDANCE =
	"Starts the command and returns immediately. You will be WOKEN when it completes; do not poll.";

export type JobStartDetails = {
	jobId: string;
	command: string;
	label: string;
	cwd: string;
	timeoutMs: number;
};

export type JobToolOptions = {
	/** Directory check seam for tests; defaults to a real filesystem stat. */
	isDirectory?: (candidate: string) => boolean;
	/** Called after a job is registered so UI projections can claim its lifecycle. */
	onJobStarted?: (job: JobSnapshot) => void;
};

function defaultIsDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function textResult<T>(text: string, details?: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details };
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((part) => part.type === "text")?.text ?? "";
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
	if (bytes < 1024) return `${Math.round(bytes)}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function jobDisplayName(job: Pick<JobSnapshot, "command" | "label">): string {
	return oneLine(job.label || "") || oneLine(job.command) || "(empty command)";
}

export function resolveJobCwd(
	raw: string | undefined,
	baseCwd: string,
	isDirectory: (candidate: string) => boolean = defaultIsDirectory,
): string {
	const base = path.resolve(baseCwd || process.cwd());
	const requested = typeof raw === "string" ? raw.trim() : "";
	if (!requested) return base;
	const resolved = path.isAbsolute(requested)
		? path.resolve(requested)
		: path.resolve(base, requested);
	if (!isDirectory(resolved)) {
		throw new Error(`job cwd is not an existing directory: ${resolved}`);
	}
	return resolved;
}

export function resolveJobTimeoutMs(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_JOB_TIMEOUT_SECONDS * 1000;
	if (!Number.isInteger(raw)) {
		throw new Error("job timeout must be a whole number of seconds");
	}
	if (raw < MIN_JOB_TIMEOUT_SECONDS || raw > MAX_JOB_TIMEOUT_SECONDS) {
		throw new Error(
			`job timeout must be between ${MIN_JOB_TIMEOUT_SECONDS} and ${MAX_JOB_TIMEOUT_SECONDS} seconds`,
		);
	}
	return raw * 1000;
}

export function jobOutcomeLabel(job: JobSnapshot): string | undefined {
	switch (job.status) {
		case "completed":
			return undefined;
		case "failed":
			if (job.exitCode !== undefined) return `exit ${job.exitCode}`;
			if (job.signal) return `signal ${job.signal}`;
			return "failed";
		case "timed_out":
			return "timeout";
		case "cancelled":
			return "cancelled";
		case "interrupted":
			return "interrupted";
		default:
			return undefined;
	}
}

/** Theme color for terminal failure/timeout/cancel/interrupted suffixes. */
export function jobOutcomeEmphasis(job: JobSnapshot): "error" | "warning" | undefined {
	switch (job.status) {
		case "failed":
		case "timed_out":
			return "error";
		case "cancelled":
		case "interrupted":
			return "warning";
		default:
			return undefined;
	}
}

/** ` · running 4.2s`, ` · queued 4.2s`, ` · 42.1s`, ` · exit 1 · 42.1s`. */
export function jobStatusSuffix(job: JobSnapshot): string {
	const duration = formatToolDuration(job.durationMs) ?? "0.0s";
	if (job.status === "queued" || job.status === "running" || job.status === "stopping") {
		return ` · ${job.status} ${duration}`;
	}
	const outcome = jobOutcomeLabel(job);
	return outcome ? ` · ${outcome} · ${duration}` : ` · ${duration}`;
}

export function jobReceiptText(job: JobSnapshot): string {
	return `${jobDisplayName(job)}${jobStatusSuffix(job)}`;
}

export type JobReceiptSegments = {
	name: string;
	/** Emphasized outcome such as `exit 1` / `timeout` / `cancelled`. */
	emphasis?: { text: string; color: "error" | "warning" };
	/** Trailing muted status+duration or bare duration. */
	trailing: string;
};

export function jobReceiptSegments(
	job: JobSnapshot,
	options: { includeStatus?: boolean } = {},
): JobReceiptSegments {
	const name = jobDisplayName(job);
	const duration = formatToolDuration(job.durationMs) ?? "0.0s";
	if (
		options.includeStatus !== false &&
		(job.status === "queued" || job.status === "running" || job.status === "stopping")
	) {
		return { name, trailing: `${job.status} ${duration}` };
	}
	const outcome = jobOutcomeLabel(job);
	const emphasisColor = jobOutcomeEmphasis(job);
	if (outcome && emphasisColor) {
		return { name, emphasis: { text: outcome, color: emphasisColor }, trailing: duration };
	}
	return { name, trailing: duration };
}

function plainReceiptBody(segments: JobReceiptSegments): string {
	const parts = [segments.name];
	if (segments.emphasis) parts.push(segments.emphasis.text);
	parts.push(segments.trailing);
	return parts.join(" · ");
}

/** Single-line `& ` receipt. Never soft-grouped, so it stays individually visible. */
export class JobReceiptLine implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly segments: JobReceiptSegments | string,
		private readonly bodyColor: string = "muted",
	) {}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width - CHAT_PADDING);
		const prefixWidth = visibleWidth(JOB_PREFIX);
		const padding = " ".repeat(CHAT_PADDING);
		const prefix = this.theme.fg("toolTitle", this.theme.bold(JOB_PREFIX));
		if (typeof this.segments === "string") {
			const bodyText = oneLine(this.segments);
			if (renderWidth <= prefixWidth) {
				return [`${padding}${truncateToWidth(`${JOB_PREFIX}${bodyText}`, renderWidth, "")}`];
			}
			const body = truncateToWidth(bodyText, renderWidth - prefixWidth, "…");
			return [`${padding}${prefix}${this.theme.fg(this.bodyColor, body)}`];
		}

		const plain = plainReceiptBody(this.segments);
		if (renderWidth <= prefixWidth) {
			return [`${padding}${truncateToWidth(`${JOB_PREFIX}${plain}`, renderWidth, "")}`];
		}

		const bodyWidth = renderWidth - prefixWidth;
		const suffixParts = [
			this.segments.emphasis ? ` · ${this.segments.emphasis.text}` : "",
			` · ${this.segments.trailing}`,
		].join("");
		const suffixWidth = visibleWidth(suffixParts);
		const nameRoom = Math.max(1, bodyWidth - suffixWidth);
		const name = truncateToWidth(oneLine(this.segments.name), nameRoom, "…");
		const muted = (text: string): string => this.theme.fg("muted", text);
		const styled = [
			muted(name),
			this.segments.emphasis
				? this.theme.fg(this.segments.emphasis.color, ` · ${this.segments.emphasis.text}`)
				: "",
			muted(` · ${this.segments.trailing}`),
		].join("");
		return [`${padding}${prefix}${truncateToWidth(styled, bodyWidth, "…")}`];
	}

	invalidate(): void {}
}

export function renderJobDetails(job: JobSnapshot, theme: Theme): Component {
	const muted = (text: string): string => theme.fg("muted", text);
	const lines = [
		`${theme.fg("toolTitle", theme.bold(JOB_PREFIX))}${muted(oneLine(job.command))}`,
		muted(`  jobId ${job.jobId}`),
		job.label ? muted(`  label ${job.label}`) : undefined,
		muted(`  cwd ${job.cwd}`),
		muted(`  pid ${job.pid ?? "none"}`),
		muted(`  timeout ${Math.round(job.timeoutMs / 1000)}s`),
		muted(`  status ${job.status}${jobOutcomeLabel(job) ? ` · ${jobOutcomeLabel(job)}` : ""}`),
		muted(`  duration ${formatToolDuration(job.durationMs) ?? "0.0s"}`),
		muted(`  output ${job.outputLines} lines · ${formatBytes(job.outputBytes)}`),
		job.cancelReason ? muted(`  cancel reason ${oneLine(job.cancelReason)}`) : undefined,
		job.error ? theme.fg("error", `  error ${oneLine(job.error)}`) : undefined,
		"",
		job.outputTail
			? job.outputTail
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n")
			: muted("(no output captured)"),
		job.truncated
			? muted(
					`[output truncated · showing the last ${formatBytes(Buffer.byteLength(job.outputTail, "utf8"))} of captured output]`,
				)
			: undefined,
	].filter((line) => line !== undefined) as string[];
	return new Text(lines.join("\n"), CHAT_PADDING, 0);
}

export function formatJobStatusLine(job: JobSnapshot): string {
	return [
		`jobId=${job.jobId}`,
		`status=${job.status}`,
		job.label ? `label=${job.label}` : undefined,
		`command=${oneLine(job.command)}`,
		`cwd=${job.cwd}`,
		job.pid !== undefined ? `pid=${job.pid}` : undefined,
		`duration=${formatToolDuration(job.durationMs) ?? "0.0s"}`,
		`timeout=${Math.round(job.timeoutMs / 1000)}s`,
		job.exitCode !== undefined ? `exit=${job.exitCode}` : undefined,
		job.signal ? `signal=${job.signal}` : undefined,
		`output=${job.outputLines} lines/${formatBytes(job.outputBytes)}${job.truncated ? " (truncated)" : ""}`,
		job.cancelReason ? `cancelReason=${oneLine(job.cancelReason)}` : undefined,
		job.error ? `error=${oneLine(job.error)}` : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

export function formatJobStatusReport(jobs: JobSnapshot[]): string {
	if (jobs.length === 0) return "No jobs in this session.";
	return jobs
		.map((job) => {
			const tail = job.outputTail
				? job.outputTail.split("\n").slice(-STATUS_TAIL_LINES).join("\n")
				: "";
			return tail ? `${formatJobStatusLine(job)}\ntail:\n${tail}` : formatJobStatusLine(job);
		})
		.join("\n\n");
}

/** Cap unbound session-wide status to the most recent jobs. Explicit-id lists stay exact. */
export function boundStatusJobs(
	jobs: JobSnapshot[],
	explicitId: boolean,
	limit: number = STATUS_LIST_LIMIT,
): { jobs: JobSnapshot[]; omitted: number } {
	if (explicitId || jobs.length <= limit) return { jobs, omitted: 0 };
	return { jobs: jobs.slice(-limit), omitted: jobs.length - limit };
}

export function formatJobResultReport(result: JobResult): string {
	const job = result.snapshot;
	return [
		formatJobStatusLine(job),
		"",
		result.output || "(no output captured)",
		result.truncated ? "\n[output truncated: only the bounded captured tail is available]" : "",
	]
		.filter((part) => part !== "")
		.join("\n");
}

function activateManagementTools(pi: ExtensionAPI): void {
	pi.setActiveTools([...new Set([...pi.getActiveTools(), ...JOB_MANAGEMENT_TOOLS])]);
}

const JobParams = Type.Object({
	command: Type.String({
		description: "Shell command to run asynchronously in the background",
	}),
	label: Type.Optional(
		Type.String({
			description: `Short label shown on the job row (max ${MAX_JOB_LABEL_LENGTH} characters)`,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory; relative paths resolve against the session directory",
		}),
	),
	timeout: Type.Optional(
		Type.Integer({
			description: `Timeout in seconds before the job is killed (default ${DEFAULT_JOB_TIMEOUT_SECONDS})`,
			minimum: MIN_JOB_TIMEOUT_SECONDS,
			maximum: MAX_JOB_TIMEOUT_SECONDS,
			default: DEFAULT_JOB_TIMEOUT_SECONDS,
		}),
	),
});

const JobStatusParams = Type.Object({
	jobId: Type.Optional(Type.String({ description: "Job ID; omit for every job in this session" })),
});

const JobResultParams = Type.Object({
	jobId: Type.String({ description: "Job ID from the start receipt or the completion wake" }),
});

const JobCancelParams = Type.Object({
	jobId: Type.String({ description: "Job ID to cancel" }),
	reason: Type.String({ description: "Concrete reason for cancelling this job" }),
});

export function registerJobTools(
	pi: ExtensionAPI,
	manager: JobManagerApi,
	options: JobToolOptions = {},
): () => void {
	const isDirectory = options.isDirectory ?? defaultIsDirectory;
	/** Transcript callbacks are used once, only to reveal the final receipt. */
	const receiptInvalidators = new Map<string, Set<() => void>>();

	const lookup = (jobId: string): JobSnapshot | undefined => {
		try {
			return manager.status(jobId).find((job) => job.jobId === jobId);
		} catch {
			return undefined;
		}
	};

	const watchFinalReceipt = (jobId: string, invalidate: (() => void) | undefined): void => {
		if (!invalidate) return;
		const callbacks = receiptInvalidators.get(jobId) ?? new Set<() => void>();
		callbacks.add(invalidate);
		receiptInvalidators.set(jobId, callbacks);
	};

	const unsubscribe = manager.subscribe?.(() => {
		for (const [jobId, callbacks] of receiptInvalidators) {
			const job = lookup(jobId);
			if (!job || !isTerminalJobStatus(job.status)) continue;
			receiptInvalidators.delete(jobId);
			for (const invalidate of callbacks) {
				try {
					invalidate();
				} catch {
					// A stale transcript row must not block other job receipts.
				}
			}
		}
	});

	pi.registerTool({
		name: "job",
		label: "Job",
		renderShell: "self",
		description: [
			"Start one long-running external command as an asynchronous background job.",
			JOB_ASYNC_GUIDANCE,
			"Continue useful work or end the turn after starting a job.",
			"Use it for builds, installs, full test suites, and other long or parallel external work;",
			"short foreground commands stay on bash.",
		].join(" "),
		promptSnippet: "Run one long external command asynchronously with a completion wake",
		promptGuidelines: [
			"Use job for long-running or parallel external commands such as builds, installs, and full test suites; keep short foreground commands on bash.",
			"After starting a job, continue useful work or end the turn instead of waiting for it.",
			"Never poll job_status in a loop. Take one bounded snapshot only when a decision depends on it.",
			"Wait for the completion wake before claiming job work finished, and read output with job_result after that wake.",
		],
		parameters: JobParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const command = typeof params.command === "string" ? params.command.trim() : "";
			if (!command) throw new Error("job requires a non-empty command");
			const label = oneLine(typeof params.label === "string" ? params.label : "");
			if (label.length > MAX_JOB_LABEL_LENGTH) {
				throw new Error(`job label must be at most ${MAX_JOB_LABEL_LENGTH} characters`);
			}
			const cwd = resolveJobCwd(params.cwd, ctx.cwd, isDirectory);
			const timeoutMs = resolveJobTimeoutMs(params.timeout);

			const job = manager.start({ command, cwd, label: label || undefined, timeoutMs });
			activateManagementTools(pi);
			options.onJobStarted?.(job);

			const details: JobStartDetails = {
				jobId: job.jobId,
				command: job.command,
				label: job.label,
				cwd: job.cwd,
				timeoutMs: job.timeoutMs,
			};
			const text = [
				`Started background job jobId=${job.jobId}${label ? ` label=${label}` : ""}.`,
				`command: ${oneLine(job.command)}`,
				`cwd: ${job.cwd} · timeout: ${Math.round(job.timeoutMs / 1000)}s`,
				"The job runs in the background. You will be WOKEN when it completes; do not poll.",
				"Continue useful work or end the turn.",
			].join("\n");
			return textResult(text, details);
		},

		renderCall() {
			// The persistent `& ` receipt comes from renderResult alone, so the row
			// stays single even while arguments stream in.
			return emptyCollapsedToolRender();
		},

		renderResult(result, _options, theme, context) {
			const details = result.details as JobStartDetails | undefined;
			if (!details?.jobId) {
				const message = oneLine(firstText(result)) || "job failed to start";
				return new JobReceiptLine(theme, message, "error");
			}
			const job =
				lookup(details.jobId) ??
				({
					jobId: details.jobId,
					command: details.command,
					label: details.label,
					cwd: details.cwd,
					status: "interrupted",
					startedAt: 0,
					durationMs: 0,
					timeoutMs: details.timeoutMs,
					outputBytes: 0,
					outputLines: 0,
					outputTail: "",
					truncated: false,
				} satisfies JobSnapshot);
			if (!isTerminalJobStatus(job.status)) watchFinalReceipt(job.jobId, context.invalidate);
			if (context.expanded) return renderJobDetails(job, theme);
			if (!isTerminalJobStatus(job.status)) return emptyCollapsedToolRender();
			receiptInvalidators.delete(job.jobId);
			return new JobReceiptLine(theme, jobReceiptSegments(job));
		},
	});

	pi.registerTool({
		name: "job_status",
		label: "Job Status",
		renderShell: "self",
		description: [
			"Bounded status snapshot for one job or every job in this session:",
			"status, exit code, pid, duration, output size, and a bounded output tail. No streaming.",
			"Never call this in a polling loop and never call it repeatedly to wait for completion;",
			"completion always arrives as a wake. Take a single snapshot only when a decision depends on it.",
		].join(" "),
		promptSnippet: "Take one bounded background job snapshot when a decision needs it",
		parameters: JobStatusParams,

		async execute(_toolCallId, params) {
			const explicitId = typeof params.jobId === "string" && params.jobId.length > 0;
			const bounded = boundStatusJobs(manager.status(params.jobId), explicitId);
			const report = formatJobStatusReport(bounded.jobs);
			const text =
				bounded.omitted > 0 ? `[${bounded.omitted} earlier jobs omitted]\n\n${report}` : report;
			return textResult(text, bounded.jobs);
		},

		renderCall(args, theme, context) {
			const target = args.jobId ? ` · ${args.jobId}` : " · all jobs";
			return new ExpandableToolRender(
				context,
				new Text(
					theme.fg("toolTitle", theme.bold("job status")) + theme.fg("muted", target),
					CHAT_PADDING,
					0,
				),
				{ errors: "hide" },
			);
		},

		renderResult(result, _options, theme, context) {
			const text = firstText(result) || "No job status";
			return new ExpandableToolRender(
				context,
				new Text(theme.fg(context.isError ? "error" : "muted", text), CHAT_PADDING, 0),
			);
		},
	});

	pi.registerTool({
		name: "job_result",
		label: "Job Result",
		renderShell: "self",
		description: [
			"Bounded captured output and metadata for one job.",
			"Use it after a completion wake when the parent must inspect what the job produced.",
		].join(" "),
		promptSnippet: "Read bounded captured output for one background job",
		parameters: JobResultParams,

		async execute(_toolCallId, params) {
			const jobId = typeof params.jobId === "string" ? params.jobId.trim() : "";
			if (!jobId) throw new Error("job_result requires a jobId");
			const result = manager.result(jobId);
			return textResult(formatJobResultReport(result), result);
		},

		renderCall(args, theme, context) {
			return new ExpandableToolRender(
				context,
				new Text(
					theme.fg("toolTitle", theme.bold("job result")) +
						theme.fg("muted", ` · ${args.jobId ?? "..."}`),
					CHAT_PADDING,
					0,
				),
				{ errors: "hide" },
			);
		},

		renderResult(result, _options, theme, context) {
			const text = firstText(result) || "No job output";
			return new ExpandableToolRender(
				context,
				new Text(theme.fg(context.isError ? "error" : "muted", text), CHAT_PADDING, 0),
			);
		},
	});

	pi.registerTool({
		name: "job_cancel",
		label: "Job Cancel",
		renderShell: "self",
		description: [
			"Cancel one running job with a concrete reason.",
			"Already finished jobs are reported unchanged, so cancelling twice is safe.",
		].join(" "),
		promptSnippet: "Cancel a background job with a concrete reason",
		parameters: JobCancelParams,

		async execute(_toolCallId, params) {
			const jobId = typeof params.jobId === "string" ? params.jobId.trim() : "";
			if (!jobId) throw new Error("job_cancel requires a jobId");
			const reason = oneLine(typeof params.reason === "string" ? params.reason : "");
			if (!reason) throw new Error("job_cancel requires a non-empty reason");
			const before = lookup(jobId);
			const wasTerminal = before ? isTerminalJobStatus(before.status) : false;
			const job = await manager.cancel(jobId, reason);
			const text = wasTerminal
				? `Job ${job.jobId} already finished as ${job.status}; nothing to cancel.\n${formatJobStatusLine(job)}`
				: `Cancelled job ${job.jobId}: ${reason}\n${formatJobStatusLine(job)}`;
			return textResult(text, job);
		},

		renderCall(args, theme, context) {
			return new ExpandableToolRender(
				context,
				new Text(
					theme.fg("toolTitle", theme.bold("job cancel")) +
						theme.fg("muted", ` · ${args.jobId ?? "..."}`),
					CHAT_PADDING,
					0,
				),
				{ errors: "hide" },
			);
		},

		renderResult(result, _options, theme, context) {
			const text = firstText(result) || "No cancellation result";
			return new ExpandableToolRender(
				context,
				new Text(theme.fg(context.isError ? "error" : "muted", text), CHAT_PADDING, 0),
			);
		},
	});

	return () => {
		unsubscribe?.();
		receiptInvalidators.clear();
	};
}
