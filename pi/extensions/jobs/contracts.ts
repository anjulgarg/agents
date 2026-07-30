export const JOB_MANAGEMENT_TOOLS = ["job_status", "job_result", "job_cancel"] as const;

export type JobStatus =
	| "queued"
	| "running"
	| "stopping"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "interrupted";

export function isTerminalJobStatus(status: JobStatus): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "timed_out" ||
		status === "interrupted"
	);
}

export type JobSpec = {
	command: string;
	cwd: string;
	label?: string;
	timeoutMs: number;
};

export type JobSnapshot = {
	jobId: string;
	command: string;
	label: string;
	cwd: string;
	status: JobStatus;
	pid?: number;
	startedAt: number;
	finishedAt?: number;
	durationMs: number;
	timeoutMs: number;
	exitCode?: number;
	signal?: string;
	error?: string;
	cancelReason?: string;
	outputBytes: number;
	outputLines: number;
	lastOutputAt?: number;
	outputTail: string;
	truncated: boolean;
};

export type JobResult = {
	snapshot: JobSnapshot;
	output: string;
	truncated: boolean;
};

export type PersistedJobRecord = {
	snapshot: JobSnapshot;
};

export type JobProcessHooks = {
	onOutput: (chunk: Buffer, stream: "stdout" | "stderr") => void;
	onExit: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
	onError: (error: Error) => void;
};

export interface JobProcessHandle {
	readonly pid?: number;
	terminate(): Promise<boolean>;
	forceKill(): void;
}

export type JobProcessFactory = (spec: JobSpec, hooks: JobProcessHooks) => JobProcessHandle;

export type JobWakeDelivery = "steer" | undefined;

export type JobManagerOptions = {
	createProcess: JobProcessFactory;
	sendWake: (content: string, deliverAs?: JobWakeDelivery) => void;
	persist?: (record: PersistedJobRecord) => void;
	now?: () => number;
	maxActiveJobs?: number;
	maxOutputBytes?: number;
};

export interface JobManagerApi {
	start(spec: JobSpec): JobSnapshot;
	status(jobId?: string): JobSnapshot[];
	result(jobId: string): JobResult;
	cancel(jobId: string, reason: string): Promise<JobSnapshot>;
	restore(records: PersistedJobRecord[]): boolean;
	setParentSettled(settled: boolean): void;
	setWakeSuppressed(suppressed: boolean): void;
	registerInvalidator(jobId: string, invalidate: () => void): () => void;
	dispose(): Promise<void>;
}
