import { runDoctor } from "../doctor/index.ts";
import { applyPlan, planInstall, planRemove } from "../install/index.ts";
import type { OperationPlan } from "../install/index.ts";
import { inspectSystem } from "../status/index.ts";
import type { AgentsUiServices, DoctorCheckView } from "../ui/contracts.ts";

function doctorCheckView(
	check: Awaited<ReturnType<typeof runDoctor>>["checks"][number],
): DoctorCheckView {
	return {
		id: check.id,
		severity: check.status === "ok" ? "pass" : check.status === "error" ? "failure" : "warning",
		summary: check.message,
		remediation:
			check.status === "ok"
				? undefined
				: check.details?.length
					? `Review: ${check.details.join(", ")}`
					: "Resolve this check, then run agents doctor again.",
	};
}

/** Compose the frozen F2 inspection service with the F3 operation services. */
export function createAgentsUiServices(
	overrides: Partial<Omit<AgentsUiServices, "inspect">> = {},
): AgentsUiServices {
	return {
		inspect: inspectSystem,
		planInstall: overrides.planInstall ?? planInstall,
		planRemove: overrides.planRemove ?? planRemove,
		applyPlan:
			overrides.applyPlan ?? ((context, plan) => applyPlan(context, plan as OperationPlan)),
		runDoctor:
			overrides.runDoctor ??
			(async (context) => {
				const report = await runDoctor(context);
				return {
					checks: report.checks.map(doctorCheckView),
					warnings: report.inspection.warnings,
				};
			}),
	};
}
