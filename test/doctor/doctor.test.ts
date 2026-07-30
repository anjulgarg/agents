import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runDoctor } from "../../src/doctor/index.ts";
import { applyPlan, planInstall } from "../../src/install/index.ts";
import { resolveProfile } from "../../src/registry/index.ts";

const temporary: string[] = [];
const sourceRoot = resolve(".");
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(): Promise<{ home: string; bin: string }> {
	const root = await mkdtemp(join(tmpdir(), "agents-doctor-"));
	temporary.push(root);
	const home = join(root, "home");
	const bin = join(root, "bin");
	await mkdir(home);
	await mkdir(bin);
	for (const command of [
		"pi",
		"npx",
		"typescript-language-server",
		"claude",
		"codex",
		"opencode",
	]) {
		const path = join(bin, command);
		await writeFile(path, "#!/bin/sh\nexit 0\n");
		await chmod(path, 0o755);
	}
	return { home, bin };
}

// T5: healthy, missing requirements, drift, package inconsistency, and read-only behavior.
it("reports healthy installs and performs no writes", async () => {
	const { home, bin } = await fixture();
	await applyPlan(
		{ home, sourceRoot },
		await planInstall({ home, sourceRoot, now: () => new Date(0) }, resolveProfile("default")),
	);
	const receipt = await readFile(join(home, ".agents/anjulgarg-agents.json"));
	const report = await runDoctor({
		home,
		sourceRoot,
		nodeVersion: "v22.19.0",
		piVersion: "0.83.0",
		path: bin,
	});
	expect(report.healthy).toBe(true);
	expect(report.checks.find(({ id }) => id === "components")?.status).toBe("ok");
	expect(await readFile(join(home, ".agents/anjulgarg-agents.json"))).toEqual(receipt);
});

it("reports unsupported runtimes, missing commands, drift, stale filters, and legacy copies", async () => {
	const { home } = await fixture();
	await applyPlan(
		{ home, sourceRoot },
		await planInstall({ home, sourceRoot }, ["skill:pr", "pi-extension:question"]),
	);
	await writeFile(join(home, ".agents/skills/pr/SKILL.md"), "drift");
	const settingsPath = join(home, ".pi/agent/settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	settings.packages[0].extensions = ["+pi/extensions/stale.ts"];
	await writeFile(settingsPath, JSON.stringify(settings));
	const legacy = join(home, ".pi/agent/extensions/question.ts");
	await mkdir(join(home, ".pi/agent/extensions"), { recursive: true });
	await writeFile(legacy, await readFile(join(sourceRoot, "pi/extensions/question.ts")));
	const report = await runDoctor({
		home,
		sourceRoot,
		nodeVersion: "v20.0.0",
		piVersion: null,
		path: "",
	});
	expect(report.healthy).toBe(false);
	expect(report.checks.find(({ id }) => id === "runtime:node")?.status).toBe("error");
	expect(report.checks.find(({ id }) => id === "command:typescript-language-server")?.status).toBe(
		"error",
	);
	expect(report.checks.find(({ id }) => id === "components")?.status).toBe("error");
	expect(report.checks.find(({ id }) => id === "legacy")?.status).toBe("warning");
});
