import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { components } from "../../src/registry/index.ts";
import {
	renderDashboard,
	renderDoctor,
	renderError,
	renderList,
	renderMinimumWidth,
	renderPreview,
	renderProgress,
	renderResult,
	renderSelector,
} from "../../src/ui/presenters.ts";
import { FakeServices, inspection } from "./fakes.ts";

const statuses = inspection({
	"skill:foreman-plan": { status: "installed", managed: true },
	"skill:foreman-review": { status: "drifted", managed: false, legacy: true },
	"skill:foreman-worker": { status: "partial", managed: true },
	"pi-extension:announce-step": { status: "unavailable", managed: false },
});
const byInspection = new Map(statuses.components.map((item) => [item.id, item]));
const plan = {
	operation: "install" as const,
	requested: ["pi-extension:team" as const],
	resolved: ["pi-extension:team" as const, "pi-extension:subagent" as const],
	changes: [
		{
			action: "write",
			path: "/fixture home/.pi/agent/settings.json",
			detail: "owned package filters",
		},
	],
	warnings: ["command typescript-language-server is missing"],
};

describe("semantic responsive renders", () => {
	it("T3 labels every status, ownership, unmanaged skills, warnings, and doctor severity", () => {
		const list = renderList(statuses, components, 120);
		for (const status of ["AVAILABLE", "INSTALLED", "DRIFTED", "PARTIAL", "UNAVAILABLE"])
			expect(list).toContain(status);
		expect(list).toContain("[managed]");
		expect(list).toContain("[legacy detected]");
		expect(list).toContain("Unmanaged skills (1)");

		const doctor = renderDoctor(new FakeServices().doctor, 120);
		expect(doctor).toContain("PASS");
		expect(doctor).toContain("WARNING");
		expect(doctor).toContain("FAILURE");
		expect(doctor).toContain("Remediation:");

		const preview = renderPreview(plan, 120, components);
		expect(preview).toContain("Dependency-added");
		expect(preview).toContain("Requirements:");
		expect(preview).toContain("WARNING");
	});

	it.each([60, 80, 120])(
		"T4 captures all required screens at %i columns without clipping",
		(width) => {
			const renders = {
				dashboard: renderDashboard(width),
				selection: renderSelector(
					{
						operation: "install",
						selected: new Set(["skill:foreman-plan"] as const),
						visible: components.slice(0, 3),
						inspections: byInspection,
						focus: 0,
						category: "all",
						search: "none",
						installedOnly: false,
					},
					components.length,
					width,
				),
				preview: renderPreview(plan, width, components),
				list: renderList(statuses, components, width),
				doctor: renderDoctor(new FakeServices().doctor, width),
				rollback: renderError(
					Object.assign(new Error("Restore failed."), {
						code: "rollback-failed",
						recoveryPath: "/fixture home/recovery backup",
					}),
					false,
					width,
				),
				success: renderResult({ operationId: "operation-1", changed: 1 }, width),
				progress: renderProgress("Committing managed files", width),
			};
			for (const output of Object.values(renders)) {
				expect(Math.max(...output.split("\n").map((line) => line.length))).toBeLessThanOrEqual(
					width,
				);
			}
			expect(renders.dashboard).toContain("Keys:");
			expect(renders.selection).toContain("Selected 1/");
			expect(renders.selection).toContain(">");
			expect(renders.rollback).toContain("ERROR [rollback-failed]");
			expect(renders.success).toContain("SUCCESS");
		},
	);

	it("T4 shows a clear minimum-width message and uses no color-only state", () => {
		expect(renderMinimumWidth(59)).toBe(
			"Terminal too narrow (59 columns). agents requires at least 60 columns.",
		);
		expect(renderList(statuses, components, 59)).toContain("requires at least 60");
		expect(renderError(new Error("No stack please"), false, 80)).not.toContain("presenters.test");
	});

	it("T7 renders the full inventory first frame within one second and under the RSS budget", () => {
		const before = performance.now();
		const output = renderList(statuses, components, 120);
		const elapsed = performance.now() - before;
		expect(output).toContain("Components");
		expect(elapsed).toBeLessThan(1000);
		expect(process.memoryUsage().rss).toBeLessThan(150 * 1024 * 1024);
	});
});
