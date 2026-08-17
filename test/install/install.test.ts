import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentId } from "../../src/domain/contracts.ts";
import { AgentsError, applyPlan, planInstall, planRemove } from "../../src/install/index.ts";
import { localPiConfigFiles, resolveProfile } from "../../src/registry/index.ts";

const roots: string[] = [];
const sourceRoot = resolve(".");
async function home(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "agents-f3-"));
	roots.push(path);
	return path;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function text(path: string): Promise<string> {
	return readFile(path, "utf8");
}
async function object(path: string): Promise<Record<string, any>> {
	return JSON.parse(await text(path));
}
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}
async function inventory(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	const visit = async (directory: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(directory, entry.name);
			const relative = path.slice(root.length + 1);
			if (entry.isDirectory()) await visit(path);
			else result[relative] = (await readFile(path)).toString("base64");
		}
	};
	await visit(root);
	return result;
}
const fixed = () => new Date("2026-01-01T00:00:00.000Z");

// T1: complete profile, exact Pi package model, and idempotency.
describe("transactional install", () => {
	it("replaces Pi instructions instead of retaining duplicate managed blocks", async () => {
		const target = await home();
		const destination = join(target, ".pi/agent/AGENTS.md");
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(
			destination,
			"<!-- agents:instructions:begin -->\nstale\n<!-- agents:instructions:end -->\n\n<!-- agents:instructions:begin -->\nstale\n<!-- agents:instructions:end -->\n",
		);

		await applyPlan(
			{ home: target, sourceRoot },
			await planInstall({ home: target, sourceRoot, now: fixed }, ["instructions:shared"]),
		);

		expect(await text(destination)).toBe(await text(join(sourceRoot, "pi/AGENTS.md")));
		const second = await planInstall({ home: target, sourceRoot, now: fixed }, [
			"instructions:shared",
		]);
		expect(second.changes).toEqual([]);
	});

	it("installs the default profile deterministically and is idempotent", async () => {
		const target = await home();
		const ids = resolveProfile("default");
		const first = await planInstall({ home: target, sourceRoot, now: fixed }, ids);
		expect(first.changes.length).toBeGreaterThan(0);
		await applyPlan({ home: target, sourceRoot, operationId: () => "success" }, first);
		const before = await inventory(target);
		const settings = await object(join(target, ".pi/agent/settings.json"));
		expect(settings).not.toHaveProperty("enabledModels");
		expect(await exists(join(target, ".pi/agent/models.json"))).toBe(false);
		expect(await exists(join(target, ".pi/agent/models-store.json"))).toBe(false);
		const local = settings.packages.find(
			(entry: any) => typeof entry === "object" && entry.source === sourceRoot,
		);
		expect(local.skills).toEqual([]);
		expect(local.extensions).toHaveLength(34);
		expect(
			local.extensions.every(
				(path: string) => path.startsWith("+pi/extensions/") && !path.includes("test"),
			),
		).toBe(true);
		expect(local.prompts).toEqual(["+pi/prompts/orchestrate.md"]);
		expect(local.themes).toEqual(["+pi/themes/claude-code.json"]);
		if (localPiConfigFiles.mcp) {
			expect(
				settings.packages.filter((entry: unknown) => entry === "npm:pi-mcp-adapter@2.15.0"),
			).toHaveLength(1);
			expect((await object(join(target, ".pi/agent/mcp.json"))).mcpServers.sentry.args).toContain(
				"@sentry/mcp-server@0.37.0",
			);
		}
		const second = await planInstall(
			{ home: target, sourceRoot, now: () => new Date("2030-01-01") },
			ids,
		);
		expect(second.changes).toEqual([]);
		await applyPlan({ home: target, sourceRoot }, second);
		expect(await inventory(target)).toEqual(before);
	});

	// T2: machine-local data survives install and component removal.
	it("preserves receipt digests for components unaffected by a later operation", async () => {
		const target = await home();
		await applyPlan(
			{ home: target, sourceRoot },
			await planInstall({ home: target, sourceRoot, now: fixed }, ["skill:foreman-plan"]),
		);
		await applyPlan(
			{ home: target, sourceRoot },
			await planInstall({ home: target, sourceRoot, now: fixed }, ["skill:foreman-review"]),
		);
		const receipt = await object(join(target, ".agents/anjulgarg-agents.json"));
		expect(receipt.components["skill:foreman-plan"].outputs[0].sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("retires the old settings component without changing user settings", async () => {
		const target = await home();
		await mkdir(join(target, ".pi/agent"), { recursive: true });
		await mkdir(join(target, ".agents"), { recursive: true });
		await writeFile(
			join(target, ".pi/agent/settings.json"),
			JSON.stringify({ defaultProvider: "user", packages: ["npm:other@1"] }),
		);
		await writeFile(
			join(target, ".agents/anjulgarg-agents.json"),
			JSON.stringify({
				schemaVersion: 1,
				source: { kind: "local", root: sourceRoot, revision: null },
				components: {
					"pi-config:settings": {
						installedAt: "2026-01-01T00:00:00Z",
						sourceDigest: "retired",
						outputs: [],
					},
				},
			}),
		);

		await applyPlan(
			{ home: target, sourceRoot },
			await planInstall({ home: target, sourceRoot, now: fixed }, ["skill:foreman-plan"]),
		);

		const settings = await object(join(target, ".pi/agent/settings.json"));
		const receipt = await object(join(target, ".agents/anjulgarg-agents.json"));
		expect(settings.defaultProvider).toBe("user");
		expect(settings.packages).toEqual(["npm:other@1"]);
		expect(receipt.components["pi-config:settings"]).toBeUndefined();
		expect(receipt.components["skill:foreman-plan"]).toBeDefined();
	});

	it("preserves user-owned model scope and runtime model files", async () => {
		const target = await home();
		const agentDir = join(target, ".pi/agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				enabledModels: ["provider/model"],
				custom: { keep: true },
				packages: ["npm:other@1"],
			}),
		);
		await writeFile(join(agentDir, "models.json"), "custom-model-config\n");
		await writeFile(join(agentDir, "models-store.json"), "runtime-model-cache\n");

		await applyPlan(
			{ home: target, sourceRoot },
			await planInstall({ home: target, sourceRoot, now: fixed }, ["pi-extension:todo"]),
		);

		const settings = await object(join(agentDir, "settings.json"));
		expect(settings.enabledModels).toEqual(["provider/model"]);
		expect(settings.custom).toEqual({ keep: true });
		expect(settings.packages).toContain("npm:other@1");
		expect(await text(join(agentDir, "models.json"))).toBe("custom-model-config\n");
		expect(await text(join(agentDir, "models-store.json"))).toBe("runtime-model-cache\n");
	});

	it.skipIf(!localPiConfigFiles.mcp)(
		"preserves unknown JSON, hooks, blocks, skills, and files",
		async () => {
			const target = await home();
			await mkdir(join(target, ".pi/agent"), { recursive: true });
			await writeFile(
				join(target, ".pi/agent/settings.json"),
				JSON.stringify({ custom: { tokenRef: "env:X" }, packages: ["npm:other@1"] }),
			);
			await writeFile(
				join(target, ".pi/agent/mcp.json"),
				JSON.stringify({ mcpServers: { private: { command: "private" } } }),
			);
			await mkdir(join(target, ".cursor"), { recursive: true });
			await writeFile(
				join(target, ".cursor/hooks.json"),
				JSON.stringify({ version: 9, hooks: { preToolUse: [{ command: "keep" }] } }),
			);
			await mkdir(join(target, ".agents/skills/foreman-planivate"), { recursive: true });
			await writeFile(join(target, ".agents/skills/foreman-planivate/SKILL.md"), "private");
			await mkdir(join(target, ".codex"), { recursive: true });
			await writeFile(join(target, ".codex/AGENTS.md"), "local preface\n");
			const ids: ComponentId[] = ["pi-config:mcp-sentry"];
			await applyPlan(
				{ home: target, sourceRoot },
				await planInstall({ home: target, sourceRoot, now: fixed }, ids),
			);
			await applyPlan(
				{ home: target, sourceRoot },
				await planRemove({ home: target, sourceRoot }, ids),
			);
			expect((await object(join(target, ".pi/agent/settings.json"))).packages).toEqual([
				"npm:other@1",
			]);
			expect((await object(join(target, ".pi/agent/mcp.json"))).mcpServers.private.command).toBe(
				"private",
			);
			const hooks = await object(join(target, ".cursor/hooks.json"));
			expect(hooks.version).toBe(9);
			expect(hooks.hooks.preToolUse).toEqual([{ command: "keep" }]);
			expect(await text(join(target, ".codex/AGENTS.md"))).toBe("local preface\n");
			expect(await text(join(target, ".agents/skills/foreman-planivate/SKILL.md"))).toBe("private");
		},
	);

	// T3: every transaction phase restores managed paths, with fatal recovery evidence.
	it.each(["after-lock", "after-stage", "after-backup", "during-commit", "after-receipt"] as const)(
		"rolls back an injected %s failure",
		async (phase) => {
			const target = await home();
			await writeFile(join(target, "unrelated"), "keep");
			const before = await inventory(target);
			const plan = await planInstall({ home: target, sourceRoot, now: fixed }, [
				"skill:foreman-plan",
			]);
			await expect(
				applyPlan(
					{ home: target, sourceRoot, operationId: () => phase, failureInjection: { phase } },
					plan,
				),
			).rejects.toMatchObject({ code: "transaction-failed" });
			expect(await inventory(target)).toEqual(before);
		},
	);

	it("retains the backup path when rollback itself fails", async () => {
		const target = await home();
		const plan = await planInstall({ home: target, sourceRoot }, ["skill:foreman-plan"]);
		let failure: AgentsError | undefined;
		try {
			await applyPlan(
				{
					home: target,
					sourceRoot,
					operationId: () => "fatal",
					failureInjection: { phase: "during-commit", rollback: true },
				},
				plan,
			);
		} catch (error) {
			failure = error as AgentsError;
		}
		expect(failure?.code).toBe("rollback-failed");
		expect(failure?.recoveryPath).toContain("fatal/backup");
		expect(await exists(failure!.recoveryPath!)).toBe(true);
	});

	// T4: all unsafe or unsupported inputs fail before destination writes.
	it("fails closed for links, overlap, malformed JSON, and future receipts", async () => {
		const target = await home();
		const linked = `${target}-link`;
		roots.push(linked);
		await symlink(target, linked, "dir");
		await expect(
			planInstall({ home: linked, sourceRoot }, ["skill:foreman-plan"]),
		).rejects.toMatchObject({
			code: "unsafe-path",
		});
		await expect(
			planInstall({ home: join(sourceRoot, "nested-home"), sourceRoot }, ["skill:foreman-plan"]),
		).rejects.toMatchObject({ code: "unsafe-path" });
		await mkdir(join(target, ".pi/agent"), { recursive: true });
		await mkdir(join(target, ".agents"), { recursive: true });
		await writeFile(
			join(target, ".agents/anjulgarg-agents.json"),
			JSON.stringify({ schemaVersion: 2 }),
		);
		await expect(
			planInstall({ home: target, sourceRoot }, ["skill:foreman-plan"]),
		).rejects.toMatchObject({
			code: "unsupported-state",
		});
	});

	// T6: approved direct extension copies are removed, unknown skills remain.
	it("adopts the legacy layout without duplicate Pi loading or touching excluded skills", async () => {
		const target = await home();
		const legacyExtension = join(target, ".pi/agent/extensions/question.ts");
		const legacyPrompt = join(target, ".pi/agent/prompts/orchestrate.md");
		const legacyTheme = join(target, ".pi/agent/themes/claude-code.json");
		for (const [source, destination] of [
			["pi/extensions/question.ts", legacyExtension],
			["pi/prompts/orchestrate.md", legacyPrompt],
			["pi/themes/claude-code.json", legacyTheme],
		] as const) {
			await mkdir(dirname(destination), { recursive: true });
			await cp(join(sourceRoot, source), destination);
		}
		await writeFile(
			join(target, ".pi/agent/settings.json"),
			JSON.stringify({ packages: ["./packages/pi-mcp-adapter", "npm:other@1"] }),
		);
		await mkdir(join(target, ".agents/skills/local-only"), { recursive: true });
		await writeFile(join(target, ".agents/skills/local-only/SKILL.md"), "local");
		await applyPlan(
			{ home: target, sourceRoot },
			await planInstall({ home: target, sourceRoot, now: fixed }, resolveProfile("default")),
		);
		for (const legacy of [legacyExtension, legacyPrompt, legacyTheme]) {
			expect(await exists(legacy)).toBe(false);
		}
		const settings = await object(join(target, ".pi/agent/settings.json"));
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
		expect(await text(join(target, ".agents/skills/local-only/SKILL.md"))).toBe("local");
	});

	// T7: exclusive per-home lock rejects a second operation.
	it("rejects lock contention without changing the plan targets", async () => {
		const target = await home();
		const plan = await planInstall({ home: target, sourceRoot }, ["skill:foreman-plan"]);
		await mkdir(join(target, ".agents/.operation.lock"), { recursive: true });
		const before = await inventory(target);
		await expect(applyPlan({ home: target, sourceRoot }, plan)).rejects.toMatchObject({
			code: "operation-in-progress",
		});
		expect(await inventory(target)).toEqual(before);
	});
});
