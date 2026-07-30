import { isTerminalStatus, type Supervisor } from "./supervisor.ts";

export interface SubagentControlBinding {
	supervisor: Supervisor;
	sync: () => void;
	recordManualKill: (runId: string, taskId: string) => void;
}

/** Active supervisor binding for cross-extension hard-kill, such as team-cancel. */
let activeKillBinding: SubagentControlBinding | undefined;

export function bindSubagentControl(binding: SubagentControlBinding): void {
	activeKillBinding = binding;
}

export function unbindSubagentControl(supervisor: Supervisor): void {
	if (activeKillBinding?.supervisor === supervisor) activeKillBinding = undefined;
}

/**
 * Hard-kill running subagent children.
 * - `undefined` runIds: kill every tracked run
 * - empty array: no-op
 * - non-empty: kill only those run IDs
 * Returns the number of tasks killTask was invoked for.
 */
export function killSubagentRuns(runIds?: readonly string[], manualKill = false): number {
	if (!activeKillBinding) return 0;
	const { supervisor, sync, recordManualKill } = activeKillBinding;
	if (runIds !== undefined && runIds.length === 0) return 0;
	const filter = runIds === undefined ? undefined : new Set(runIds);
	let killed = 0;
	for (const run of supervisor.runs.values()) {
		if (filter && !filter.has(run.runId)) continue;
		for (const task of [...run.tasks]) {
			if (isTerminalStatus(task.status)) continue;
			if (manualKill) recordManualKill(run.runId, task.taskId);
			supervisor.killTask(run.runId, task.taskId, manualKill);
			killed++;
		}
	}
	sync();
	return killed;
}
