import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsUiServices } from "../../src/cli/services.ts";
import { applyPlan } from "../../src/install/index.ts";
import type { OperationPlan } from "../../src/install/index.ts";
import {
	components,
	localPiConfigFiles,
	resolveProfile,
	resolveSelection,
} from "../../src/registry/index.ts";
import { cleanupFixtures, fixtureHome, inventory, runAgents, sourceRoot } from "./helpers.ts";

afterEach(cleanupFixtures);

function jsonOutput(output: string): any {
	return JSON.parse(output);
}

async function install(home: string, selection: readonly string[] = []): Promise<any> {
	const result = await runAgents(home, ["install", ...selection, "--yes", "--json"]);
	expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
	return jsonOutput(result.stdout);
}

describe("temporary-home CLI parity", () => {
	it("T1 installs the default profile into an empty isolated home", async () => {
		const { home } = await fixtureHome();
		const result = await install(home);
		expect(result.plan.resolved).toEqual(resolveProfile("default"));

		const listed = await runAgents(home, ["list", "--json"]);
		expect(listed.code).toBe(0);
		const inspection = jsonOutput(listed.stdout);
		expect(inspection.components).toHaveLength(components.length);
		expect(
			inspection.components.every(({ status, managed }: any) => status === "installed" && managed),
		).toBe(true);
	});

	it("T1 installs a category into its own empty home", async () => {
		const { home } = await fixtureHome();
		const result = await install(home, ["--category", "pi-extension"]);
		const extensionIds = components
			.filter(({ category }) => category === "pi-extension")
			.map(({ id }) => id);
		expect(result.plan.requested).toEqual(extensionIds);
		expect(result.plan.resolved).toEqual(resolveSelection(extensionIds));
		const settings = JSON.parse(await readFile(join(home, ".pi/agent/settings.json"), "utf8"));
		expect(settings.packages[0].extensions).toHaveLength(extensionIds.length);
	});

	it("T1 and T3 install one skill and preserve its complete directory", async () => {
		const { home } = await fixtureHome();
		await install(home, ["--component", "skill:foreman-plan"]);
		expect(
			await readFile(join(home, ".agents/skills/foreman-plan/plan-template.md"), "utf8"),
		).toContain("# <Plan title>");
	});

	it("T3 installs all skills without selecting unrelated categories", async () => {
		const { home } = await fixtureHome();
		const result = await install(home, ["--profile", "skills"]);
		expect(result.plan.resolved).toEqual(resolveProfile("skills"));
		expect(result.plan.resolved).toHaveLength(3);
	});

	it("T3 resolves the product team subagent dependency", async () => {
		const { home } = await fixtureHome();
		const result = await install(home, ["--component", "pi-team:product"]);
		expect(result.plan.requested).toEqual(["pi-team:product"]);
		expect(result.plan.resolved).toEqual([
			"pi-extension:subagent",
			"pi-extension:team",
			"pi-team:product",
		]);
		expect(await readFile(join(home, ".pi/agent/teams/product.json"), "utf8")).toContain(
			'"name": "product"',
		);
	});

	it("T1 reports drift, removes selectively, and reinstalls", async () => {
		const { home } = await fixtureHome();
		await install(home, ["--component", "skill:foreman-plan"]);
		await writeFile(join(home, ".agents/skills/foreman-plan/SKILL.md"), "local drift\n");
		let listed = jsonOutput((await runAgents(home, ["list", "--json"])).stdout);
		expect(listed.components.find(({ id }: any) => id === "skill:foreman-plan").status).toBe(
			"drifted",
		);

		const removed = await runAgents(home, [
			"remove",
			"--component",
			"skill:foreman-plan",
			"--yes",
			"--json",
		]);
		expect(removed.code).toBe(0);
		listed = jsonOutput((await runAgents(home, ["list", "--json"])).stdout);
		expect(listed.components.find(({ id }: any) => id === "skill:foreman-plan").status).toBe(
			"available",
		);
		await install(home, ["--component", "skill:foreman-plan"]);
		listed = jsonOutput((await runAgents(home, ["list", "--json"])).stdout);
		expect(listed.components.find(({ id }: any) => id === "skill:foreman-plan")).toMatchObject({
			status: "installed",
			managed: true,
		});
	});

	it("T2 rolls an injected mid-transaction failure back byte-for-byte", async () => {
		const { home } = await fixtureHome();
		await mkdir(home, { recursive: true });
		await writeFile(join(home, "unrelated"), "preserve\n");
		const before = await inventory(home);
		const services = createAgentsUiServices({
			applyPlan: (context, plan) =>
				applyPlan(
					{
						...context,
						operationId: () => "e2e-injected",
						failureInjection: { phase: "during-commit" },
					},
					plan as OperationPlan,
				),
		});
		const result = await runAgents(
			home,
			["install", "--component", "skill:foreman-plan", "--yes"],
			services,
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ERROR [transaction-failed]");
		expect(await inventory(home)).toEqual(before);
	});

	it("T4 migrates the pinned legacy shape without duplicate loading", async () => {
		const { home } = await fixtureHome();
		const legacyResources = [
			["pi/extensions/question.ts", ".pi/agent/extensions/question.ts"],
			["pi/prompts/orchestrate.md", ".pi/agent/prompts/orchestrate.md"],
			["pi/themes/claude-code.json", ".pi/agent/themes/claude-code.json"],
		] as const;
		for (const [source, destination] of legacyResources) {
			const path = join(home, destination);
			await mkdir(dirname(path), { recursive: true });
			await cp(join(sourceRoot, source), path);
		}
		await writeFile(
			join(home, ".pi/agent/settings.json"),
			JSON.stringify({ packages: ["./packages/pi-mcp-adapter", "npm:other@1"] }),
		);
		await mkdir(join(home, ".agents/skills/find-skills"), { recursive: true });
		await writeFile(join(home, ".agents/skills/find-skills/SKILL.md"), "unmanaged\n");

		const before = jsonOutput((await runAgents(home, ["list", "--json"])).stdout);
		expect(before.components.find(({ id }: any) => id === "pi-extension:question")).toMatchObject({
			status: "installed",
			managed: false,
		});
		await install(home);
		for (const destination of legacyResources.map(([, path]) => path)) {
			await expect(readFile(join(home, destination))).rejects.toMatchObject({ code: "ENOENT" });
		}
		const settings = JSON.parse(await readFile(join(home, ".pi/agent/settings.json"), "utf8"));
		expect(settings.packages).toContain("npm:other@1");
		if (localPiConfigFiles.mcp) {
			expect(settings.packages).not.toContain("./packages/pi-mcp-adapter");
			expect(
				settings.packages.filter((entry: unknown) => entry === "npm:pi-mcp-adapter@2.15.0"),
			).toHaveLength(1);
		} else {
			expect(settings.packages).toContain("./packages/pi-mcp-adapter");
			expect(settings.packages).not.toContain("npm:pi-mcp-adapter@2.15.0");
		}
		const after = jsonOutput((await runAgents(home, ["list", "--json"])).stdout);
		expect(
			after.components.every(({ status, managed }: any) => status === "installed" && managed),
		).toBe(true);
		expect(after.unmanagedSkills.map(({ name }: any) => name)).toContain("find-skills");
		expect(await readFile(join(home, ".agents/skills/find-skills/SKILL.md"), "utf8")).toBe(
			"unmanaged\n",
		);
	});

	it("T6 restores a disposable migration backup to exact pre-migration bytes", async () => {
		const { root, home } = await fixtureHome();
		const legacy = join(home, ".pi/agent/extensions/question.ts");
		await mkdir(dirname(legacy), { recursive: true });
		await cp(join(sourceRoot, "pi/extensions/question.ts"), legacy);
		await writeFile(join(home, "local-only"), "keep\n");
		const before = await inventory(home);
		const backup = join(root, "pre-migration-backup");
		await cp(home, backup, { recursive: true });

		await install(home, ["--component", "pi-extension:question"]);
		await rm(home, { recursive: true });
		await cp(backup, home, { recursive: true });
		expect(await inventory(home)).toEqual(before);
	});
});
