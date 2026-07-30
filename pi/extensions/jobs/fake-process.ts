/**
 * Deterministic in-memory job process for manager tests.
 *
 * Nothing is spawned and no timer runs: every lifecycle event (output, exit,
 * spawn error, termination) is driven explicitly, so queueing, races, and wake
 * batching can be asserted without sleeping on a real process.
 */
import type { JobProcessFactory, JobProcessHandle, JobProcessHooks, JobSpec } from "./contracts.ts";

export interface FakeProcessBehavior {
	/** Throw from the factory to simulate a spawn failure. */
	spawnError?: string;
	/** Throw synchronously from terminate(). */
	terminateError?: string;
	/** Report an exit as soon as terminate() runs. Default true. */
	exitOnTerminate?: boolean;
	/** Signal reported when terminate() ends the process. Default "SIGTERM". */
	terminateSignal?: NodeJS.Signals;
	/** Value terminate() resolves with, i.e. whether the reap was confirmed. Default true. */
	reap?: boolean;
	/** Keep terminate() pending until releaseTerminate() runs. Default false. */
	manualTerminate?: boolean;
	/** Report an exit from forceKill(). Default true. */
	exitOnForceKill?: boolean;
}

let nextPid = 4200;

export class FakeJobProcess implements JobProcessHandle {
	readonly pid: number;
	terminateCalls = 0;
	forceKillCalls = 0;
	exited = false;

	private pendingTerminate?: PromiseWithResolvers<boolean>;

	constructor(
		readonly spec: JobSpec,
		private readonly hooks: JobProcessHooks,
		private readonly behavior: FakeProcessBehavior,
	) {
		this.pid = nextPid++;
	}

	/** Emit stdout text as a UTF-8 chunk. */
	stdout(text: string): void {
		this.write(Buffer.from(text, "utf8"), "stdout");
	}

	/** Emit stderr text as a UTF-8 chunk. */
	stderr(text: string): void {
		this.write(Buffer.from(text, "utf8"), "stderr");
	}

	/** Emit raw bytes, e.g. one half of a multi-byte character. */
	write(chunk: Buffer, stream: "stdout" | "stderr" = "stdout"): void {
		this.hooks.onOutput(chunk, stream);
	}

	/** Report a process exit exactly once. */
	exit(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.exited) return;
		this.exited = true;
		this.hooks.onExit(exitCode, signal);
	}

	/** Report a process-level error, e.g. a late spawn failure. */
	fail(message: string): void {
		this.hooks.onError(new Error(message));
	}

	terminate(): Promise<boolean> {
		this.terminateCalls++;
		if (this.behavior.terminateError) throw new Error(this.behavior.terminateError);
		if (this.behavior.manualTerminate) {
			this.pendingTerminate ??= Promise.withResolvers<boolean>();
			return this.pendingTerminate.promise;
		}
		return Promise.resolve(this.settle());
	}

	forceKill(): void {
		this.forceKillCalls++;
		if (this.behavior.exitOnForceKill ?? true) {
			this.exit(null, "SIGKILL");
		}
	}

	/** Complete a manual terminate(): emits the exit, then resolves the caller. */
	releaseTerminate(reap = this.behavior.reap ?? true): void {
		const pending = this.pendingTerminate;
		this.pendingTerminate = undefined;
		const result = this.settle(reap);
		pending?.resolve(result);
	}

	private settle(reap = this.behavior.reap ?? true): boolean {
		if (this.behavior.exitOnTerminate ?? true) {
			this.exit(null, this.behavior.terminateSignal ?? "SIGTERM");
		}
		return reap;
	}
}

export interface FakeProcessFleet {
	factory: JobProcessFactory;
	/** Every process created, in launch order. */
	readonly all: FakeJobProcess[];
	/** Mutable behavior applied to processes created from now on. */
	behavior: FakeProcessBehavior;
	last(): FakeJobProcess;
	byLabel(label: string): FakeJobProcess;
}

/** Create a fake factory plus the handles it hands out. */
export function createFakeProcessFleet(behavior: FakeProcessBehavior = {}): FakeProcessFleet {
	const all: FakeJobProcess[] = [];
	const fleet: FakeProcessFleet = {
		behavior,
		all,
		factory: (spec, hooks) => {
			if (fleet.behavior.spawnError) throw new Error(fleet.behavior.spawnError);
			const fake = new FakeJobProcess(spec, hooks, { ...fleet.behavior });
			all.push(fake);
			return fake;
		},
		last: () => {
			const fake = all[all.length - 1];
			if (!fake) throw new Error("no fake process has been created");
			return fake;
		},
		byLabel: (label) => {
			const fake = all.find((candidate) => candidate.spec.label === label);
			if (!fake) throw new Error(`no fake process for label ${label}`);
			return fake;
		},
	};
	return fleet;
}
