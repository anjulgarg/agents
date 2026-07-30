import type { ComponentId, SystemInspection } from "../../src/domain/contracts.ts";
import { components } from "../../src/registry/index.ts";
import type {
	AgentsUiServices,
	DoctorReportView,
	OperationPlanView,
	OperationResultView,
} from "../../src/ui/contracts.ts";

export function inspection(
	overrides: Partial<
		Record<
			ComponentId,
			{
				status: "available" | "installed" | "drifted" | "partial" | "unavailable";
				managed: boolean;
				legacy?: boolean;
			}
		>
	> = {},
): SystemInspection {
	return {
		source: { kind: "local", root: "/source root", revision: null },
		receipt: {
			path: "/fixture home/.agents/install-state.json",
			schemaState: "current",
			schemaVersion: 1,
			managedComponents: new Set(),
		},
		components: components.map(({ id }) => {
			const value = overrides[id] ?? { status: "available" as const, managed: false };
			return {
				id,
				status: value.status,
				managed: value.managed,
				reasons: [`Component is ${value.status}.`],
				outputs: value.legacy
					? [
							{
								strategy: "legacy-copy" as const,
								path: `/legacy/${id}`,
								state: "legacy" as const,
								reason: "Legacy copy detected.",
							},
						]
					: [],
			};
		}),
		unmanagedSkills: [{ name: "personal", path: "/fixture home/.agents/skills/personal" }],
		warnings: ["Receipt warning example."],
	};
}

export class FakeServices implements AgentsUiServices {
	applyCalls = 0;
	readonly plans: OperationPlanView[] = [];
	failure?: Error & { code?: string; recoveryPath?: string };
	constructor(
		readonly current = inspection(),
		readonly doctor: DoctorReportView = {
			checks: [
				{ id: "node", severity: "pass", summary: "Node is supported." },
				{
					id: "pi",
					severity: "warning",
					summary: "Pi was not found.",
					remediation: "Install Pi and retry.",
				},
				{
					id: "receipt",
					severity: "failure",
					summary: "Receipt is malformed.",
					remediation: "Restore the receipt backup.",
				},
			],
		},
	) {}
	async inspect(): Promise<SystemInspection> {
		return this.current;
	}
	private plan(operation: "install" | "remove", ids: readonly ComponentId[]): OperationPlanView {
		const resolved = ids.includes("pi-extension:team")
			? [...ids, "pi-extension:subagent" as ComponentId]
			: ids;
		const plan = {
			operation,
			requested: ids,
			resolved,
			changes: ids.map((id) => ({
				action: operation === "install" ? "write" : "remove",
				path: `/fixture home/output/${id}`,
			})),
			warnings: ["Missing optional command requirement."],
		} satisfies OperationPlanView;
		this.plans.push(plan);
		return plan;
	}
	async planInstall(_context: unknown, ids: readonly ComponentId[]): Promise<OperationPlanView> {
		return this.plan("install", ids);
	}
	async planRemove(_context: unknown, ids: readonly ComponentId[]): Promise<OperationPlanView> {
		return this.plan("remove", ids);
	}
	async applyPlan(): Promise<OperationResultView> {
		this.applyCalls += 1;
		if (this.failure) throw this.failure;
		return { operationId: "operation-1", changed: 2, message: "Applied safely." };
	}
	async runDoctor(): Promise<DoctorReportView> {
		return this.doctor;
	}
}
