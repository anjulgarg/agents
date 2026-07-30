/**
 * Real background job processes: one detached shell per job.
 *
 * Mirrors pi's built-in bash backend (resolved shell, `-c` argv transport, ignored
 * stdin, detached process group on POSIX) so job cancellation and output match the
 * bash tool. Unlike the bash tool this streams output to hooks instead of buffering
 * a whole result, and it never blocks the caller: `createJobProcess` returns as soon
 * as `spawn` has been issued.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";

import { getShellConfig } from "@earendil-works/pi-coding-agent";

import type { JobProcessFactory, JobProcessHandle, JobProcessHooks, JobSpec } from "./contracts.ts";

/** Grace period between SIGTERM and SIGKILL during terminate(). */
export const KILL_GRACE_MS = 250;
/** Budget for confirming that the leader and its group are gone after SIGKILL. */
export const KILL_CONFIRM_MS = 250;
/** Idle window after exit before abandoning pipes held open by detached descendants. */
const EXIT_STDIO_GRACE_MS = 100;
/** Poll interval while confirming that a process group has been reaped. */
const REAP_POLL_MS = 10;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Inherit the caller's environment, minus the two hooks that would make a
 * non-interactive `bash -c` source a profile script before the command runs.
 */
function jobEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.BASH_ENV;
	delete env.ENV;
	return env;
}

function assertUsableCwd(cwd: string): void {
	if (!cwd) throw new Error("job cwd must not be empty");
	let stats;
	try {
		stats = statSync(cwd);
	} catch {
		throw new Error(`job working directory does not exist: ${cwd}`);
	}
	if (!stats.isDirectory()) throw new Error(`job working directory is not a directory: ${cwd}`);
}

/**
 * A job whose process never started. The failure is reported asynchronously so
 * callers observe the same ordering as a real spawn error.
 */
class UnstartedJobProcess implements JobProcessHandle {
	readonly pid = undefined;

	constructor(error: Error, hooks: JobProcessHooks) {
		queueMicrotask(() => hooks.onError(error));
	}

	terminate(): Promise<boolean> {
		return Promise.resolve(true);
	}

	forceKill(): void {}
}

class SpawnedJobProcess implements JobProcessHandle {
	private readonly exitWaiters: Array<() => void> = [];
	private exited = false;
	private exitReported = false;
	private exitCode: number | null = null;
	private exitSignal: NodeJS.Signals | null = null;
	private stdoutEnded: boolean;
	private stderrEnded: boolean;
	private idleTimer?: NodeJS.Timeout;
	private terminating?: Promise<boolean>;

	constructor(
		private readonly child: ChildProcess,
		private readonly hooks: JobProcessHooks,
	) {
		this.stdoutEnded = child.stdout === null;
		this.stderrEnded = child.stderr === null;
		child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => this.onData(chunk, "stderr"));
		// Unhandled stream errors are thrown; swallow so a broken pipe cannot crash Pi.
		child.stdout?.on("error", () => {});
		child.stderr?.on("error", () => {});
		child.stdout?.once("end", () => {
			this.stdoutEnded = true;
			this.maybeReportExit();
		});
		child.stderr?.once("end", () => {
			this.stderrEnded = true;
			this.maybeReportExit();
		});
		child.once("error", (error: Error) => {
			// A failed spawn also emits "close"; reporting the error first lets the
			// owner record the real cause instead of a synthetic exit status.
			this.hooks.onError(error);
			if (child.pid === undefined) this.exitReported = true;
			this.markExited(null, null);
		});
		child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			this.markExited(code, signal);
			this.maybeReportExit();
			if (!this.exitReported) this.armIdleTimer();
		});
		child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
			this.markExited(code, signal);
			this.reportExit();
		});
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	/**
	 * Stop the whole process group: SIGTERM, a short grace period, then SIGKILL.
	 * Resolves true only when the leader exited and, on POSIX, the group is gone.
	 */
	terminate(): Promise<boolean> {
		if (this.terminating) return this.terminating;
		this.terminating = this.terminateOnce().then((reaped) => {
			// Allow a later retry when cleanup could not be confirmed.
			if (!reaped) this.terminating = undefined;
			return reaped;
		});
		return this.terminating;
	}

	/** Synchronous best-effort kill for parent-exit handlers. */
	forceKill(): void {
		this.signalGroup("SIGKILL");
	}

	private async terminateOnce(): Promise<boolean> {
		this.signalGroup("SIGTERM");
		const exitedEarly = await this.waitForExitWithin(KILL_GRACE_MS);
		// Sweep the group even after the leader exits; grandchildren ignore SIGTERM.
		this.signalGroup("SIGKILL");
		const leaderGone = exitedEarly || (await this.waitForExitWithin(KILL_CONFIRM_MS));
		const groupGone = await this.waitForGroupGoneWithin(KILL_CONFIRM_MS);
		return leaderGone && groupGone;
	}

	private signalGroup(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (process.platform !== "win32" && pid !== undefined) {
			try {
				process.kill(-pid, signal);
				return;
			} catch {
				// Fall through to the single-pid path when the group is already gone.
			}
		}
		if (this.exited) return;
		try {
			this.child.kill(signal);
		} catch {
			// The process may have exited between the check and the signal.
		}
	}

	private waitForExitWithin(timeoutMs: number): Promise<boolean> {
		if (this.exited) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			timer.unref?.();
			this.exitWaiters.push(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	/** Windows has no process groups, so reaping is only confirmed on POSIX. */
	private async waitForGroupGoneWithin(timeoutMs: number): Promise<boolean> {
		const pid = this.child.pid;
		if (process.platform === "win32" || pid === undefined) return this.exited;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				process.kill(-pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
			}
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, REAP_POLL_MS);
				timer.unref?.();
			});
		}
	}

	private onData(chunk: Buffer, stream: "stdout" | "stderr"): void {
		this.hooks.onOutput(chunk, stream);
		// Output still arriving after exit: keep reading instead of truncating it.
		if (this.exited && !this.exitReported) this.armIdleTimer();
	}

	private markExited(code: number | null, signal: NodeJS.Signals | null): void {
		if (!this.exited) {
			this.exited = true;
			this.exitCode = code;
			this.exitSignal = signal;
		} else if (this.exitCode === null && this.exitSignal === null) {
			this.exitCode = code;
			this.exitSignal = signal;
		}
		while (this.exitWaiters.length) this.exitWaiters.shift()?.();
	}

	private maybeReportExit(): void {
		if (!this.exited || this.exitReported) return;
		if (this.stdoutEnded && this.stderrEnded) this.reportExit();
	}

	private armIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.reportExit(), EXIT_STDIO_GRACE_MS);
		this.idleTimer.unref?.();
	}

	private reportExit(): void {
		if (this.exitReported) return;
		this.exitReported = true;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		// Leader may exit while POSIX background descendants remain; sweep the
		// group without altering the recorded leader exit status.
		this.signalGroup("SIGKILL");
		this.child.stdout?.destroy();
		this.child.stderr?.destroy();
		this.hooks.onExit(this.exitCode, this.exitSignal);
	}
}

/**
 * Production job process factory.
 *
 * Never throws: invalid working directories and unusable shells are reported
 * through `hooks.onError` so every job failure follows one path.
 */
export const createJobProcess: JobProcessFactory = (
	spec: JobSpec,
	hooks: JobProcessHooks,
): JobProcessHandle => {
	let child: ChildProcess;
	try {
		assertUsableCwd(spec.cwd);
		const shellConfig = getShellConfig();
		if (shellConfig.commandTransport === "stdin") {
			// Jobs run with stdin ignored, so a shell that only accepts the command
			// on stdin cannot host them.
			throw new Error(
				`shell ${shellConfig.shell} requires stdin command transport, which background jobs do not support`,
			);
		}
		child = spawn(shellConfig.shell, [...shellConfig.args, spec.command], {
			cwd: spec.cwd,
			env: jobEnv(),
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		return new UnstartedJobProcess(new Error(errorText(error)), hooks);
	}
	return new SpawnedJobProcess(child, hooks);
};
