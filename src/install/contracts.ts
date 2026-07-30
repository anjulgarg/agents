import type { ComponentId, InspectionContext } from "../domain/contracts.ts";

export type AgentsErrorCode =
	| "invalid-component"
	| "unsupported-runtime"
	| "unsafe-path"
	| "malformed-config"
	| "unsupported-state"
	| "operation-in-progress"
	| "requirement-missing"
	| "transaction-failed"
	| "rollback-failed";

export class AgentsError extends Error {
	constructor(
		public readonly code: AgentsErrorCode,
		message: string,
		public readonly recoveryPath?: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AgentsError";
	}
}

export interface InstallStateV1 {
	schemaVersion: 1;
	source: { kind: "local"; root: string; revision: string | null };
	components: Record<
		ComponentId,
		{
			installedAt: string;
			sourceDigest: string;
			outputs: readonly { path: string; strategy: string; sha256: string | null }[];
		}
	>;
}

export interface PlannedChange {
	path: string;
	action: "create" | "update" | "delete";
	strategy: string;
	componentIds: readonly ComponentId[];
	beforeSha256: string | null;
	afterSha256: string | null;
}

export interface OperationPlan {
	operation: "install" | "remove";
	requested: readonly ComponentId[];
	resolved: readonly ComponentId[];
	changes: readonly PlannedChange[];
	warnings: readonly string[];
}

export interface OperationEvent {
	name:
		| "agents.plan"
		| "agents.transaction.start"
		| "agents.transaction.commit"
		| "agents.transaction.rollback";
	operationId: string;
	componentIds: readonly ComponentId[];
	count: number;
	durationMs: number;
	errorCode?: AgentsErrorCode;
}

export type FailurePhase =
	"after-lock" | "after-stage" | "after-backup" | "during-commit" | "after-receipt";

export interface OperationContext extends InspectionContext {
	now?: () => Date;
	operationId?: () => string;
	emit?: (event: OperationEvent) => void;
	failureInjection?: { phase: FailurePhase; rollback?: boolean };
}

export interface OperationResult {
	operationId: string;
	changed: number;
	receiptPath: string;
	events: readonly OperationEvent[];
}
