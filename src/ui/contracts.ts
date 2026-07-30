import type { ComponentId, InspectionContext, SystemInspection } from "../domain/contracts.ts";

export type OperationKind = "install" | "remove";

export interface PlannedChangeView {
	readonly action: string;
	readonly path: string;
	readonly detail?: string;
}

export interface OperationPlanView {
	readonly operation: OperationKind;
	readonly requested: readonly ComponentId[];
	readonly resolved: readonly ComponentId[];
	readonly changes: readonly PlannedChangeView[];
	readonly warnings: readonly string[];
}

export interface OperationResultView {
	readonly operationId?: string;
	readonly changed?: number;
	readonly message?: string;
}

export type DoctorSeverity = "pass" | "warning" | "failure";

export interface DoctorCheckView {
	readonly id: string;
	readonly severity: DoctorSeverity;
	readonly summary: string;
	readonly remediation?: string;
}

export interface DoctorReportView {
	readonly checks: readonly DoctorCheckView[];
	readonly warnings?: readonly string[];
}

/** Structural boundary implemented by F3 and replaced with fakes in F4 tests. */
export interface AgentsUiServices {
	inspect(context: InspectionContext): Promise<SystemInspection>;
	planInstall(context: InspectionContext, ids: readonly ComponentId[]): Promise<OperationPlanView>;
	planRemove(context: InspectionContext, ids: readonly ComponentId[]): Promise<OperationPlanView>;
	applyPlan(
		context: InspectionContext,
		plan: OperationPlanView,
		onProgress?: (message: string) => void,
	): Promise<OperationResultView>;
	runDoctor(context: InspectionContext): Promise<DoctorReportView>;
}

export interface UiContext {
	readonly home: string;
	readonly sourceRoot: string;
}
