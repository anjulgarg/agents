import type { TeamRun, TeamRunStatus, TeamTaskStatus } from "./contracts.ts";

export interface TeamTaskCounts {
	completed: number;
	running: number;
	failed: number;
}

export function teamTaskCounts(run: TeamRun): TeamTaskCounts {
	return {
		completed: run.tasks.filter((task) => task.status === "completed").length,
		running: run.tasks.filter((task) => task.status === "running").length,
		failed: run.tasks.filter((task) => task.status === "failed").length,
	};
}

export function teamTaskStatusIcon(status: TeamTaskStatus): string {
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "running":
			return "◌";
		case "blocked":
			return "⊘";
		default:
			return "○";
	}
}

export function teamTaskStatusColor(
	status: TeamTaskStatus,
): "success" | "error" | "warning" | "muted" | "dim" {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "running":
			return "warning";
		case "blocked":
			return "muted";
		default:
			return "dim";
	}
}

export function teamRunStatusIcon(status: TeamRunStatus): string {
	return status === "completed"
		? "✓"
		: status === "failed" || status === "cancelled"
			? "✗"
			: status === "executing"
				? "◌"
				: "○";
}

export function teamRunStatusColor(
	status: TeamRunStatus,
): "success" | "error" | "warning" | "muted" {
	return status === "completed"
		? "success"
		: status === "failed" || status === "cancelled"
			? "error"
			: status === "executing"
				? "warning"
				: "muted";
}
