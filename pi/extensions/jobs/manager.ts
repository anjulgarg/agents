/**
 * Asynchronous job runtime.
 *
 * `start()` returns a durable job id immediately; the parent agent keeps working and
 * is woken once per batch of completions. The manager owns queueing, bounded output
 * capture, timeouts, cancellation, persistence of lifecycle transitions, and the
 * animation timer used by persistent transcript components. It never touches the
 * TUI, the tool layer, or the process implementation directly: processes arrive
 * through `options.createProcess`, which tests replace with a deterministic fake.
 */
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import {
	isTerminalJobStatus,
	type JobManagerApi,
	type JobManagerOptions,
	type JobProcessFactory,
	type JobProcessHandle,
	type JobResult,
	type JobSnapshot,
	type JobSpec,
	type JobStatus,
	type JobWakeDelivery,
	type PersistedJobRecord,
} from "./contracts.ts";

/** Concurrently running processes. Extra jobs wait in FIFO order. */
export const DEFAULT_MAX_ACTIVE_JOBS = 4;
/** Captured output retained per job. `result()` returns exactly this much. */
export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
/** Output carried on every snapshot; keeps `status()` cheap for many jobs. */
export const SNAPSHOT_TAIL_BYTES = 2 * 1024;
/**
 * Match the shared tool shimmer at approximately 30 frames per second so
 * long-lived job receipts move smoothly despite transcript reflow.
 */
export const INVALIDATE_INTERVAL_MS = 33;
/** Cap for `status()` with no jobId; explicit-id lookup still reaches older receipts. */
export const STATUS_LIST_LIMIT = 20;

/** Time dispose() waits for a graceful terminate before forcing a kill. */
const DISPOSE_TERMINATE_TIMEOUT_MS = 2_000;
/** Defensive bound for stop() when handle.terminate never resolves. */
const STOP_TERMINATE_TIMEOUT_MS = 1_000;
const LABEL_MAX = 80;
const CANCEL_REASON_MAX = 120;
const WAKE_LINE_MAX = 200;
const WAKE_MAX_LINES = 20;
const WAKE_RETRY_DELAY_MS = 250;

/** OSC + CSI/ANSI sequences (aligned with pi's stripAnsi). */
const TERMINAL_SEQUENCE_RE = (() => {
	const st = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
	const osc = `(?:\\u001B\\][\\s\\S]*?${st}|\\u009D[\\s\\S]*?${st})`;
	const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
	return new RegExp(`${osc}|${csi}`, "g");
})();

type StopIntent = Extract<JobStatus, "cancelled" | "timed_out" | "interrupted">;

interface FinalizeDetails {
	exitCode?: number;
	signal?: string;
	error?: string;
	/** Keep the process handle for dispose/exit sweeps after an unconfirmed reap. */
	retainHandle?: boolean;
}

interface JobState {
	jobId: string;
	command: string;
	label: string;
	cwd: string;
	timeoutMs: number;
	status: JobStatus;
	pid?: number;
	/** Enqueue time until the process starts, then the spawn time. */
	startedAt: number;
	finishedAt?: number;
	exitCode?: number;
	signal?: string;
	error?: string;
	cancelReason?: string;
	output: OutputTail;
	handle?: JobProcessHandle;
	timeoutTimer?: NodeJS.Timeout;
	/** True while this job holds one of the active-job slots. */
	slotHeld: boolean;
	/** Terminal status this job will take once its process stops. */
	stopIntent?: StopIntent;
	/** In-flight stop, shared by concurrent cancel/timeout callers. */
	stopping?: Promise<JobSnapshot>;
	/** Finished but not yet announced to the parent. */
	pendingWake: boolean;
	invalidators: Set<() => void>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function finiteOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Strip terminal sequences and unsafe controls before text reaches snapshots,
 * persistence, wakes, TUI, or model context. Keeps newline and tab.
 */
export function sanitizeJobText(text: string): string {
	const stripped = text.replace(TERMINAL_SEQUENCE_RE, "").replace(/\r/g, "");
	return Array.from(stripped)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a) return true;
			if (code <= 0x1f || code === 0x7f) return false;
			if (code >= 0x80 && code <= 0x9f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

function clip(text: string, maxChars: number): string {
	const flat = sanitizeJobText(text).replace(/\s+/g, " ").trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars - 3)}...` : flat;
}

/** Keep the last `maxBytes` UTF-8 bytes without splitting a character. */
function tailBytesOf(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let start = buffer.length - maxBytes;
	while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
	return buffer.toString("utf8", start);
}

/**
 * Merged stdout/stderr capture with a hard memory ceiling.
 *
 * Each stream gets its own decoder so a multi-byte character split across two
 * chunks is never mangled, while append order preserves the interleaving the
 * process produced. Totals keep counting after the tail starts dropping bytes.
 * Display paths sanitize the assembled retained text so sequences split across
 * chunks cannot leak into snapshots or results.
 */
class OutputTail {
	bytes = 0;
	truncated = false;
	lastOutputAt?: number;

	private readonly decoders: Record<"stdout" | "stderr", StringDecoder> = {
		stdout: new StringDecoder("utf8"),
		stderr: new StringDecoder("utf8"),
	};
	private text = "";
	private textBytes = 0;
	private newlines = 0;
	private endsWithNewline = true;

	constructor(private readonly maxBytes: number) {}

	get lines(): number {
		return this.newlines + (this.bytes > 0 && !this.endsWithNewline ? 1 : 0);
	}

	append(chunk: Buffer, stream: "stdout" | "stderr", at: number): void {
		if (chunk.length === 0) return;
		this.bytes += chunk.length;
		this.lastOutputAt = at;
		this.appendDecoded(this.decoders[stream].write(chunk));
	}

	/** Flush incomplete final UTF-8 sequences exactly once when the process settles. */
	finish(): void {
		this.appendDecoded(this.decoders.stdout.end());
		this.appendDecoded(this.decoders.stderr.end());
	}

	/** Rebuild counters from a persisted snapshot; no process is involved. */
	seed(snapshot: JobSnapshot): void {
		this.text = tailBytesOf(sanitizeJobText(String(snapshot.outputTail ?? "")), this.maxBytes);
		this.textBytes = Buffer.byteLength(this.text, "utf8");
		this.bytes = Math.max(0, finiteOr(snapshot.outputBytes, this.textBytes));
		this.newlines = 0;
		for (const char of this.text) if (char === "\n") this.newlines++;
		this.endsWithNewline = this.text.endsWith("\n");
		if (typeof snapshot.outputLines === "number" && snapshot.outputLines > this.lines) {
			this.newlines = snapshot.outputLines - (this.bytes > 0 && !this.endsWithNewline ? 1 : 0);
		}
		this.truncated = Boolean(snapshot.truncated) || this.bytes > this.textBytes;
		this.lastOutputAt =
			typeof snapshot.lastOutputAt === "number" && Number.isFinite(snapshot.lastOutputAt)
				? snapshot.lastOutputAt
				: undefined;
	}

	full(): string {
		return sanitizeJobText(this.text);
	}

	display(maxBytes: number): string {
		return tailBytesOf(sanitizeJobText(this.text), maxBytes);
	}

	private appendDecoded(decoded: string): void {
		if (!decoded) return;
		for (const char of decoded) if (char === "\n") this.newlines++;
		this.endsWithNewline = decoded.endsWith("\n");
		this.text += decoded;
		this.textBytes += Buffer.byteLength(decoded, "utf8");
		if (this.textBytes <= this.maxBytes) return;
		this.text = tailBytesOf(this.text, this.maxBytes);
		this.textBytes = Buffer.byteLength(this.text, "utf8");
		this.truncated = true;
	}
}

function formatDuration(ms: number): string {
	const safe = Math.max(0, Math.round(ms));
	if (safe < 1000) return `${safe}ms`;
	if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
	const minutes = Math.floor(safe / 60_000);
	const seconds = Math.round((safe % 60_000) / 1000);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function wakeState(snapshot: JobSnapshot): string {
	switch (snapshot.status) {
		case "completed":
			return `completed (exit ${snapshot.exitCode ?? 0})`;
		case "failed":
			if (snapshot.signal) return `failed (signal ${snapshot.signal})`;
			if (snapshot.exitCode !== undefined) return `failed (exit ${snapshot.exitCode})`;
			return `failed (${clip(snapshot.error ?? "unknown error", 60)})`;
		case "timed_out":
			return `timed out (limit ${snapshot.timeoutMs}ms)`;
		case "cancelled":
			return snapshot.cancelReason ? `cancelled (${snapshot.cancelReason})` : "cancelled";
		case "interrupted":
			return "interrupted";
		default:
			return snapshot.status;
	}
}

/** One bounded line per finished job. Output is never inlined. */
function wakeLine(snapshot: JobSnapshot): string {
	return clip(
		`Job ${snapshot.jobId} [${snapshot.label}] ${wakeState(snapshot)} after ${formatDuration(snapshot.durationMs)}`,
		WAKE_LINE_MAX,
	);
}

export class JobManager implements JobManagerApi {
	private readonly jobs = new Map<string, JobState>();
	private readonly createProcess: JobProcessFactory;
	private readonly sendWake: (content: string, deliverAs?: JobWakeDelivery) => void;
	private readonly persist?: (record: PersistedJobRecord) => void;
	private readonly now: () => number;
	private readonly maxActiveJobs: number;
	private readonly maxOutputBytes: number;
	private readonly onProcessExit: () => void;

	private active = 0;
	private pumping = false;
	private pumpRequested = false;
	private parentSettled = false;
	private wakeSuppressed = false;
	private disposed = false;
	private wakeFlushTimer?: NodeJS.Timeout;
	private animationTimer?: NodeJS.Timeout;

	constructor(options: JobManagerOptions) {
		this.createProcess = options.createProcess;
		this.sendWake = options.sendWake;
		this.persist = options.persist;
		this.now = options.now ?? (() => Date.now());
		this.maxActiveJobs = Math.max(1, finiteOr(options.maxActiveJobs, DEFAULT_MAX_ACTIVE_JOBS));
		this.maxOutputBytes = Math.max(1, finiteOr(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES));
		// Synchronous exit hook: abnormal Pi death skips session_shutdown/dispose.
		this.onProcessExit = () => {
			for (const job of this.jobs.values()) {
				const handle = job.handle;
				if (!handle) continue;
				try {
					handle.forceKill();
				} catch {
					// Best effort during process teardown.
				}
			}
		};
		process.on("exit", this.onProcessExit);
	}

	/** Register a job and start it when a slot is free. Never blocks on the process. */
	start(spec: JobSpec): JobSnapshot {
		if (this.disposed) throw new Error("job manager is disposed");
		const rawCommand = spec.command?.trim() ?? "";
		const command = sanitizeJobText(rawCommand);
		if (!command) throw new Error("job command must not be empty");
		if (command !== rawCommand) throw new Error("job command contains unsafe control characters");
		const cwd = spec.cwd?.trim() ?? "";
		if (!cwd) throw new Error("job cwd must not be empty");
		if (sanitizeJobText(cwd) !== cwd) throw new Error("job cwd contains unsafe control characters");
		if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
			throw new Error(`job timeoutMs must be a positive number, received ${spec.timeoutMs}`);
		}
		const startedAt = this.now();
		const job: JobState = {
			jobId: `job-${randomUUID()}`,
			command,
			label: clip(spec.label?.trim() || command, LABEL_MAX),
			cwd,
			timeoutMs: spec.timeoutMs,
			status: "queued",
			startedAt,
			output: new OutputTail(this.maxOutputBytes),
			slotHeld: false,
			pendingWake: false,
			invalidators: new Set(),
		};
		this.jobs.set(job.jobId, job);
		this.persistJob(job);
		this.pump();
		return this.snapshot(job);
	}

	status(jobId?: string): JobSnapshot[] {
		if (jobId === undefined) {
			const all = [...this.jobs.values()];
			const recent = all.length <= STATUS_LIST_LIMIT ? all : all.slice(-STATUS_LIST_LIMIT);
			return recent.map((job) => this.snapshot(job));
		}
		return [this.snapshot(this.requireJob(jobId))];
	}

	result(jobId: string): JobResult {
		const job = this.requireJob(jobId);
		return {
			snapshot: this.snapshot(job),
			output: job.output.full(),
			truncated: job.output.truncated,
		};
	}

	/** Stop a queued or running job. Terminal jobs are returned unchanged. */
	async cancel(jobId: string, reason: string): Promise<JobSnapshot> {
		const job = this.requireJob(jobId);
		if (isTerminalJobStatus(job.status)) return this.snapshot(job);
		return this.stop(job, "cancelled", reason?.trim() || "cancelled by the agent");
	}

	/**
	 * Rebuild history from persisted records. Jobs that were still live when the
	 * session ended become `interrupted`: their processes belong to a dead parent,
	 * so no pid is ever signalled from here.
	 */
	restore(records: PersistedJobRecord[]): boolean {
		if (!Array.isArray(records)) return false;
		if (this.disposed) {
			this.jobs.clear();
			this.active = 0;
			this.pumping = false;
			this.pumpRequested = false;
			this.parentSettled = false;
			this.wakeSuppressed = false;
			this.disposed = false;
			process.on("exit", this.onProcessExit);
		}
		let restored = false;
		for (const record of records) {
			const snapshot = record?.snapshot;
			if (!snapshot || typeof snapshot.jobId !== "string" || !snapshot.jobId) continue;
			if (this.jobs.has(snapshot.jobId)) continue;
			const wasLive = !isTerminalJobStatus(snapshot.status);
			const now = this.now();
			const startedAt = finiteOr(snapshot.startedAt, now);
			const finishedAt =
				snapshot.finishedAt === undefined ? undefined : finiteOr(snapshot.finishedAt, now);
			const job: JobState = {
				jobId: snapshot.jobId,
				command: sanitizeJobText(String(snapshot.command ?? "")) || "(unknown command)",
				label: clip(String(snapshot.label ?? snapshot.command ?? "job"), LABEL_MAX),
				cwd: sanitizeJobText(String(snapshot.cwd ?? "")),
				timeoutMs: Math.max(1, finiteOr(snapshot.timeoutMs, 30 * 60 * 1000)),
				status: wasLive ? "interrupted" : snapshot.status,
				pid: Number.isInteger(snapshot.pid) && (snapshot.pid ?? 0) > 0 ? snapshot.pid : undefined,
				startedAt,
				finishedAt: wasLive ? (finishedAt ?? now) : (finishedAt ?? startedAt),
				exitCode: Number.isInteger(snapshot.exitCode) ? snapshot.exitCode : undefined,
				signal: snapshot.signal ? sanitizeJobText(String(snapshot.signal)) : undefined,
				error:
					sanitizeJobText(
						String(
							wasLive
								? (snapshot.error ?? "interrupted when the previous session ended")
								: (snapshot.error ?? ""),
						),
					) || undefined,
				cancelReason: snapshot.cancelReason
					? clip(String(snapshot.cancelReason), CANCEL_REASON_MAX)
					: undefined,
				output: new OutputTail(this.maxOutputBytes),
				slotHeld: false,
				pendingWake: false,
				invalidators: new Set(),
			};
			job.output.seed(snapshot);
			this.jobs.set(job.jobId, job);
			// Only the conversion is a new lifecycle transition worth persisting.
			if (wasLive) this.persistJob(job);
			restored = true;
		}
		return restored;
	}

	/** Track whether the parent turn is idle, which selects the wake delivery mode. */
	setParentSettled(settled: boolean): void {
		this.parentSettled = settled;
		if (this.hasPendingWake()) this.scheduleWakeFlush();
	}

	/** Hold wakes (compaction, shutdown, modal UI) and release them afterwards. */
	setWakeSuppressed(suppressed: boolean): void {
		if (this.wakeSuppressed === suppressed) return;
		this.wakeSuppressed = suppressed;
		if (!suppressed && this.hasPendingWake()) this.scheduleWakeFlush();
	}

	/**
	 * Drive a persistent transcript component for one job. The returned function
	 * unregisters it; the shared animation timer stops once no live job needs it.
	 */
	registerInvalidator(jobId: string, invalidate: () => void): () => void {
		const job = this.requireJob(jobId);
		job.invalidators.add(invalidate);
		this.syncAnimationTimer();
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			job.invalidators.delete(invalidate);
			this.syncAnimationTimer();
		};
	}

	/** Stop every timer, silence wakes, and terminate all live/unconfirmed processes. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.wakeSuppressed = true;
		if (this.wakeFlushTimer) {
			clearTimeout(this.wakeFlushTimer);
			this.wakeFlushTimer = undefined;
		}
		if (this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
		const stopped: Array<Promise<unknown>> = [];
		for (const job of this.jobs.values()) {
			job.invalidators.clear();
			const handle = job.handle;
			if (!isTerminalJobStatus(job.status)) {
				this.finalize(job, "interrupted", {
					error: "job manager disposed",
					retainHandle: handle !== undefined,
				});
			}
			// Live and terminal-but-unconfirmed groups both keep a handle for cleanup.
			if (handle) {
				stopped.push(
					this.terminateForDispose(handle).finally(() => {
						if (job.handle === handle) job.handle = undefined;
					}),
				);
			}
		}
		await Promise.allSettled(stopped);
		process.removeListener("exit", this.onProcessExit);
	}

	/** Never let shutdown hang on a handle that will not confirm termination. */
	private async terminateForDispose(handle: JobProcessHandle): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		try {
			const reaped = await Promise.race([
				handle.terminate(),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), DISPOSE_TERMINATE_TIMEOUT_MS);
					timer.unref?.();
				}),
			]);
			if (reaped) return;
		} catch {
			// Fall through to the forced kill.
		} finally {
			if (timer) clearTimeout(timer);
		}
		try {
			handle.forceKill();
		} catch {
			// Best effort: the process may already be gone.
		}
	}

	private requireJob(jobId: string): JobState {
		const job = typeof jobId === "string" ? this.jobs.get(jobId) : undefined;
		if (!job) throw new Error(`unknown job: ${jobId}`);
		return job;
	}

	private snapshot(job: JobState): JobSnapshot {
		const finishedAt = job.finishedAt;
		return {
			jobId: job.jobId,
			command: job.command,
			label: job.label,
			cwd: job.cwd,
			status: job.status,
			pid: job.pid,
			startedAt: job.startedAt,
			finishedAt,
			durationMs: Math.max(0, (finishedAt ?? this.now()) - job.startedAt),
			timeoutMs: job.timeoutMs,
			exitCode: job.exitCode,
			signal: job.signal,
			error: job.error,
			cancelReason: job.cancelReason,
			outputBytes: job.output.bytes,
			outputLines: job.output.lines,
			lastOutputAt: job.output.lastOutputAt,
			outputTail: job.output.display(SNAPSHOT_TAIL_BYTES),
			truncated: job.output.truncated,
		};
	}

	private persistJob(job: JobState): void {
		if (!this.persist) return;
		try {
			this.persist({ snapshot: this.snapshot(job) });
		} catch {
			// Persistence is best effort; a failed write must not kill the job.
		}
	}

	/** Start queued jobs until the active-slot budget is exhausted. */
	private pump(): void {
		if (this.disposed) return;
		if (this.pumping) {
			this.pumpRequested = true;
			return;
		}
		this.pumping = true;
		try {
			do {
				this.pumpRequested = false;
				for (const job of this.jobs.values()) {
					if (this.active >= this.maxActiveJobs) break;
					if (job.status !== "queued") continue;
					this.launch(job);
				}
			} while (this.pumpRequested && this.active < this.maxActiveJobs);
		} finally {
			this.pumping = false;
		}
	}

	private launch(job: JobState): void {
		job.status = "running";
		job.startedAt = this.now();
		job.slotHeld = true;
		this.active++;
		let handle: JobProcessHandle;
		try {
			handle = this.createProcess(
				{ command: job.command, cwd: job.cwd, label: job.label, timeoutMs: job.timeoutMs },
				{
					onOutput: (chunk, stream) => this.onOutput(job, chunk, stream),
					onExit: (exitCode, signal) => this.onExit(job, exitCode, signal),
					onError: (error) => this.onProcessError(job, error),
				},
			);
		} catch (error) {
			this.finalize(job, "failed", { error: errorText(error) });
			return;
		}
		job.pid = handle.pid;
		// A process that reported its outcome during creation is already terminal.
		if (isTerminalJobStatus(job.status)) return;
		job.handle = handle;
		const timer = setTimeout(() => void this.stop(job, "timed_out"), job.timeoutMs);
		timer.unref?.();
		job.timeoutTimer = timer;
		this.persistJob(job);
		this.invalidate(job);
		this.syncAnimationTimer();
	}

	private onOutput(job: JobState, chunk: Buffer, stream: "stdout" | "stderr"): void {
		if (isTerminalJobStatus(job.status)) return;
		job.output.append(chunk, stream, this.now());
	}

	private onExit(job: JobState, exitCode: number | null, signal: NodeJS.Signals | null): void {
		if (isTerminalJobStatus(job.status)) return;
		const details: FinalizeDetails = {
			exitCode: exitCode ?? undefined,
			signal: signal ?? undefined,
		};
		if (job.stopIntent) {
			this.finalize(job, job.stopIntent, details);
			return;
		}
		if (signal) {
			this.finalize(job, "failed", { ...details, error: `terminated by signal ${signal}` });
			return;
		}
		if (exitCode === 0) {
			this.finalize(job, "completed", details);
			return;
		}
		this.finalize(job, "failed", {
			...details,
			error:
				exitCode === null ? "process exited without a status code" : `exited with code ${exitCode}`,
		});
	}

	private onProcessError(job: JobState, error: Error): void {
		if (isTerminalJobStatus(job.status)) return;
		this.finalize(job, job.stopIntent ?? "failed", { error: errorText(error) });
	}

	/**
	 * Move a live job towards `intent`. Concurrent callers (cancel racing a
	 * timeout) share the first stop; the process exit or the terminate result,
	 * whichever lands first, performs the single terminal transition.
	 */
	private stop(job: JobState, intent: StopIntent, reason?: string): Promise<JobSnapshot> {
		if (isTerminalJobStatus(job.status)) return Promise.resolve(this.snapshot(job));
		if (job.stopping) return job.stopping;
		if (reason !== undefined) job.cancelReason = clip(reason, CANCEL_REASON_MAX);
		job.stopIntent = intent;
		const handle = job.handle;
		if (!handle) {
			// Queued or restored: there is no process to signal.
			this.finalize(job, intent, {});
			return Promise.resolve(this.snapshot(job));
		}
		job.status = "stopping";
		this.clearJobTimeout(job);
		this.invalidate(job);
		let termination: Promise<boolean>;
		try {
			// Signal synchronously: a deferred SIGTERM would let the process keep running.
			termination = handle.terminate();
		} catch (error) {
			this.finalize(job, intent, {
				error: `cleanup failed: ${errorText(error)}`,
				retainHandle: true,
			});
			return Promise.resolve(this.snapshot(job));
		}
		job.stopping = this.awaitStop(job, intent, handle, termination);
		return job.stopping;
	}

	/** Bound stop even if terminate never resolves; fast path stays a plain terminate. */
	private async awaitStop(
		job: JobState,
		intent: StopIntent,
		handle: JobProcessHandle,
		termination: Promise<boolean>,
	): Promise<JobSnapshot> {
		let timer: NodeJS.Timeout | undefined;
		let reaped = false;
		try {
			reaped = await Promise.race([
				termination,
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => {
						try {
							handle.forceKill();
						} catch {
							// Best effort.
						}
						resolve(false);
					}, STOP_TERMINATE_TIMEOUT_MS);
					timer.unref?.();
				}),
			]);
		} catch (error) {
			job.stopping = undefined;
			const message = `cleanup failed: ${errorText(error)}`;
			if (isTerminalJobStatus(job.status)) this.retainUnconfirmedHandle(job, handle, message);
			else this.finalize(job, intent, { error: message, retainHandle: true });
			return this.snapshot(job);
		} finally {
			if (timer) clearTimeout(timer);
		}
		job.stopping = undefined;
		if (!reaped && isTerminalJobStatus(job.status)) {
			this.retainUnconfirmedHandle(job, handle, "process cleanup could not be confirmed");
		} else if (!isTerminalJobStatus(job.status)) {
			this.finalize(job, intent, {
				error: reaped ? undefined : "process cleanup could not be confirmed",
				retainHandle: !reaped,
			});
		}
		return this.snapshot(job);
	}

	private retainUnconfirmedHandle(job: JobState, handle: JobProcessHandle, message: string): void {
		job.handle = handle;
		job.error = sanitizeJobText([job.error, message].filter(Boolean).join("; "));
		this.persistJob(job);
		this.invalidate(job);
		job.pendingWake = true;
		this.scheduleWakeFlush();
	}

	/** The one place a job becomes terminal, releases its slot, and is persisted. */
	private finalize(job: JobState, status: JobStatus, details: FinalizeDetails): void {
		if (isTerminalJobStatus(job.status)) return;
		this.clearJobTimeout(job);
		job.output.finish();
		job.status = status;
		job.finishedAt = this.now();
		if (details.exitCode !== undefined) job.exitCode = details.exitCode;
		if (details.signal !== undefined) job.signal = sanitizeJobText(details.signal);
		if (details.error !== undefined) job.error = sanitizeJobText(details.error);
		job.stopIntent = undefined;
		if (!details.retainHandle) job.handle = undefined;
		if (job.slotHeld) {
			job.slotHeld = false;
			this.active--;
		}
		this.persistJob(job);
		this.invalidate(job);
		this.syncAnimationTimer();
		job.pendingWake = true;
		this.scheduleWakeFlush();
		this.pump();
	}

	private clearJobTimeout(job: JobState): void {
		if (!job.timeoutTimer) return;
		clearTimeout(job.timeoutTimer);
		job.timeoutTimer = undefined;
	}

	private hasPendingWake(): boolean {
		for (const job of this.jobs.values()) if (job.pendingWake) return true;
		return false;
	}

	/** Coalesce every completion in this tick into a single wake. */
	private scheduleWakeFlush(delayMs = 0): void {
		if (this.disposed || this.wakeSuppressed || this.wakeFlushTimer) return;
		const timer = setTimeout(() => {
			this.wakeFlushTimer = undefined;
			this.flushWakes();
		}, delayMs);
		timer.unref?.();
		this.wakeFlushTimer = timer;
	}

	private flushWakes(): void {
		if (this.disposed || this.wakeSuppressed) return;
		const pending = [...this.jobs.values()].filter((job) => job.pendingWake);
		if (pending.length === 0) return;
		const lines = pending.slice(0, WAKE_MAX_LINES).map((job) => wakeLine(this.snapshot(job)));
		if (pending.length > WAKE_MAX_LINES) {
			lines.push(`(+${pending.length - WAKE_MAX_LINES} more finished background jobs)`);
		}
		lines.push("Use job_result with the job id to read captured output.");
		try {
			this.sendWake(lines.join("\n"), this.parentSettled ? undefined : "steer");
		} catch {
			// Retain pending wakes and retry autonomously: an idle parent has no
			// lifecycle event that could otherwise recover a transient send failure.
			this.scheduleWakeFlush(WAKE_RETRY_DELAY_MS);
			return;
		}
		for (const job of pending) job.pendingWake = false;
	}

	private invalidate(job: JobState): void {
		for (const invalidator of job.invalidators) {
			try {
				invalidator();
			} catch {
				// A broken component must not stall the runtime.
			}
		}
	}

	private syncAnimationTimer(): void {
		const needed =
			!this.disposed &&
			[...this.jobs.values()].some(
				(job) => !isTerminalJobStatus(job.status) && job.invalidators.size > 0,
			);
		if (needed && !this.animationTimer) {
			const timer = setInterval(() => this.tickAnimation(), INVALIDATE_INTERVAL_MS);
			timer.unref?.();
			this.animationTimer = timer;
			return;
		}
		if (!needed && this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
	}

	private tickAnimation(): void {
		for (const job of this.jobs.values()) {
			if (isTerminalJobStatus(job.status)) continue;
			this.invalidate(job);
		}
	}
}

export function createJobManager(options: JobManagerOptions): JobManager {
	return new JobManager(options);
}
