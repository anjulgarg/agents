import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsUiServices } from "../../src/cli/services.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("integrated CLI services", () => {
	it("plans, applies, inspects, and maps doctor results through the real F3 boundary", async () => {
		const home = await mkdtemp(join(tmpdir(), "agents-cli-services-"));
		temporary.push(home);
		const context = { home, sourceRoot: resolve(".") };
		const services = createAgentsUiServices();

		const plan = await services.planInstall(context, ["skill:pr"]);
		expect(plan).toMatchObject({
			operation: "install",
			requested: ["skill:pr"],
			resolved: ["skill:pr"],
		});
		await services.applyPlan(context, plan);

		const inspection = await services.inspect(context);
		expect(inspection.components.find(({ id }) => id === "skill:pr")).toMatchObject({
			status: "installed",
			managed: true,
		});
		expect(await readFile(join(home, ".agents/skills/pr/SKILL.md"), "utf8")).toContain("name: pr");

		const doctor = await services.runDoctor(context);
		expect(doctor.checks.length).toBeGreaterThan(0);
		expect(
			doctor.checks.every(({ severity }) => ["pass", "warning", "failure"].includes(severity)),
		).toBe(true);
	});
});
