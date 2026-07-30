import type {
	ComponentDefinition,
	ComponentId,
	ComponentInspection,
	SystemInspection,
} from "../domain/contracts.ts";
import type { DoctorReportView, OperationPlanView, OperationResultView } from "./contracts.ts";

export const MINIMUM_WIDTH = 60;

function wrapLine(value: string, width: number): readonly string[] {
	if (!value) return [""];
	const wrapped: string[] = [];
	for (let offset = 0; offset < value.length; offset += width) {
		wrapped.push(value.slice(offset, offset + width));
	}
	return wrapped;
}

function linesAtWidth(lines: readonly string[], width: number): string {
	return lines.flatMap((line) => wrapLine(line, Math.max(1, width))).join("\n");
}

export function ownershipLabel(inspection: ComponentInspection): string {
	if (inspection.managed) return "managed";
	if (inspection.outputs.some(({ state }) => state === "legacy")) return "legacy detected";
	return "unmanaged";
}

export function renderMinimumWidth(width: number): string {
	return `Terminal too narrow (${width} columns). agents requires at least ${MINIMUM_WIDTH} columns.`;
}

export function renderDashboard(width: number): string {
	if (width < MINIMUM_WIDTH) return renderMinimumWidth(width);
	return linesAtWidth(
		[
			"agents | Local agent configuration",
			"",
			"> Install                 Configure selected components",
			"  Remove                  Remove managed components safely",
			"  Installed Components    Inspect all component states",
			"  Doctor                  Diagnose local configuration",
			"",
			"Keys: ↑/↓ move • Enter open • Esc cancel • Ctrl+C quit",
		],
		width,
	);
}

export function renderList(
	inspection: SystemInspection,
	definitions: readonly ComponentDefinition[],
	width: number,
): string {
	if (width < MINIMUM_WIDTH) return renderMinimumWidth(width);
	const byId = new Map(definitions.map((definition) => [definition.id, definition]));
	const lines = ["Components | status and ownership"];
	for (const item of inspection.components) {
		const definition = byId.get(item.id);
		lines.push(
			`${item.status.toUpperCase().padEnd(11)} [${ownershipLabel(item)}] ${definition?.label ?? item.id} (${item.id})`,
		);
	}
	if (inspection.unmanagedSkills.length) {
		lines.push("", `Unmanaged skills (${inspection.unmanagedSkills.length})`);
		for (const skill of inspection.unmanagedSkills)
			lines.push(`UNMANAGED   ${skill.name} | ${skill.path}`);
	}
	for (const warning of inspection.warnings) lines.push(`WARNING     ${warning}`);
	lines.push("", "Keys: Esc back • Ctrl+C quit");
	return linesAtWidth(lines, width);
}

export interface SelectorRenderState {
	readonly operation: "install" | "remove";
	readonly selected: ReadonlySet<ComponentId>;
	readonly visible: readonly ComponentDefinition[];
	readonly inspections: ReadonlyMap<ComponentId, ComponentInspection>;
	readonly focus: number;
	readonly category: string;
	readonly search: string;
	readonly installedOnly: boolean;
}

function requirementLabel(definition: ComponentDefinition): string {
	if (!definition.requirements.length) return "none";
	return definition.requirements
		.map((requirement) => {
			switch (requirement.kind) {
				case "runtime":
					return `${requirement.runtime} ${requirement.range}`;
				case "command":
					return `command ${requirement.command}`;
				case "package":
					return `${requirement.name}@${requirement.version}`;
			}
		})
		.join(", ");
}

export function renderSelector(state: SelectorRenderState, total: number, width: number): string {
	if (width < MINIMUM_WIDTH) return renderMinimumWidth(width);
	const focused = state.visible[state.focus];
	const lines = [
		`${state.operation === "install" ? "Install" : "Remove"} components | Selected ${state.selected.size}/${total}`,
		`Category: ${state.category} | Search: ${state.search || "none"} | Installed only: ${state.installedOnly ? "yes" : "no"}`,
		"Profiles: [1] Default  [2] Pi  [3] Skills",
		"",
	];
	for (const [index, definition] of state.visible.entries()) {
		const inspection = state.inspections.get(definition.id);
		lines.push(
			`${index === state.focus ? ">" : " "} ${state.selected.has(definition.id) ? "[x]" : "[ ]"} ${definition.label} | ${inspection?.status ?? "available"} | ${inspection ? ownershipLabel(inspection) : "unmanaged"}`,
		);
	}
	if (!state.visible.length) lines.push("  No components match these filters.");
	if (focused) {
		lines.push(
			"",
			`Detail: ${focused.description}`,
			`Dependencies: ${focused.dependsOn.join(", ") || "none"}`,
			`Requirements: ${requirementLabel(focused)}`,
		);
	}
	lines.push(
		"",
		"Keys: ↑/↓ focus • Space toggle • A all • C category • X clear • Tab category",
		"      1/2/3 profile • / search • F installed • Enter review • Esc cancel",
	);
	return linesAtWidth(lines, width);
}

export function renderPreview(
	plan: OperationPlanView,
	width: number,
	definitions: readonly ComponentDefinition[] = [],
): string {
	if (width < MINIMUM_WIDTH) return renderMinimumWidth(width);
	const requested = new Set(plan.requested);
	const dependencies = plan.resolved.filter((id) => !requested.has(id));
	const lines = [
		`Review ${plan.operation} | Requested ${plan.requested.length} | Dependencies ${dependencies.length}`,
		`Requested: ${plan.requested.join(", ") || "none"}`,
		`Dependency-added: ${dependencies.join(", ") || "none"}`,
		`Requirements: ${
			definitions
				.filter(({ id, requirements }) => plan.resolved.includes(id) && requirements.length > 0)
				.flatMap(({ requirements }) =>
					requirements.map((requirement) =>
						requirement.kind === "runtime"
							? `${requirement.runtime} ${requirement.range}`
							: requirement.kind === "command"
								? `command ${requirement.command}`
								: `${requirement.name}@${requirement.version}`,
					),
				)
				.filter((value, index, all) => all.indexOf(value) === index)
				.join(", ") || "none"
		}`,
		"",
		`Planned changes (${plan.changes.length})`,
	];
	for (const change of plan.changes)
		lines.push(
			`${change.action.toUpperCase()} ${change.path}${change.detail ? ` | ${change.detail}` : ""}`,
		);
	for (const warning of plan.warnings) lines.push(`WARNING ${warning}`);
	lines.push("", "Enter continue • Esc cancel");
	return linesAtWidth(lines, width);
}

export function renderConfirmation(plan: OperationPlanView, width: number): string {
	return linesAtWidth(
		[
			`Confirm ${plan.operation}`,
			`${plan.changes.length} planned change(s) affecting ${plan.resolved.length} component(s).`,
			"Apply this plan? [y/N]",
			"Y apply • N/Esc cancel",
		],
		width,
	);
}

export function renderProgress(message: string, width: number): string {
	return linesAtWidth(
		[
			"Operation in progress",
			`… ${message}`,
			"Please wait. Cancellation occurs only at a safe boundary.",
		],
		width,
	);
}

export function renderResult(result: OperationResultView, width: number): string {
	return linesAtWidth(
		[
			"SUCCESS Operation completed",
			result.message ?? `${result.changed ?? 0} change(s) applied.`,
			result.operationId ? `Operation: ${result.operationId}` : "",
			"Enter return to dashboard • Ctrl+C quit",
		].filter(Boolean),
		width,
	);
}

export function renderDoctor(report: DoctorReportView, width: number): string {
	if (width < MINIMUM_WIDTH) return renderMinimumWidth(width);
	const lines = ["Doctor | local configuration checks"];
	for (const check of report.checks) {
		lines.push(`${check.severity.toUpperCase().padEnd(7)} ${check.id} | ${check.summary}`);
		if (check.remediation) lines.push(`  Remediation: ${check.remediation}`);
	}
	for (const warning of report.warnings ?? []) lines.push(`WARNING ${warning}`);
	lines.push("", "Keys: Esc back • Ctrl+C quit");
	return linesAtWidth(lines, width);
}

export function renderError(error: unknown, debug: boolean, width: number): string {
	const record = error as {
		code?: unknown;
		message?: unknown;
		stack?: unknown;
		recoveryPath?: unknown;
	};
	const code = typeof record.code === "string" ? record.code : "operational-failure";
	const cause = typeof record.message === "string" ? record.message : "The operation failed.";
	const recovery =
		code === "rollback-failed"
			? "Automatic rollback failed. Preserve the recovery backup and restore it manually."
			: "Review the message, run agents doctor, then retry.";
	const lines = [`ERROR [${code}] ${cause}`, `Recovery: ${recovery}`];
	if (code === "rollback-failed" && typeof record.recoveryPath === "string") {
		lines.push(`Recovery backup: ${record.recoveryPath}`);
	}
	if (debug && typeof record.stack === "string") lines.push(record.stack);
	return linesAtWidth(lines, width);
}
