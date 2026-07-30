import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ComponentDefinition, ComponentId } from "../../src/domain/contracts.ts";
import {
	components,
	createResolver,
	localPiConfigFiles,
	profiles,
	RegistryError,
	resolveProfile,
	resolveSelection,
	validateRegistry,
} from "../../src/registry/index.ts";

const extensionIds = [
	"pi-extension:announce-step",
	"pi-extension:branch",
	"pi-extension:btw",
	"pi-extension:claude-code-ui",
	"pi-extension:codex-usage",
	"pi-extension:codex-web-search",
	"pi-extension:context",
	"pi-extension:conversation-separator",
	"pi-extension:escape-unsend",
	"pi-extension:git-checkpoint",
	"pi-extension:hide-thinking-history",
	"pi-extension:jobs",
	"pi-extension:lsp",
	"pi-extension:memory",
	"pi-extension:minimal-mode",
	"pi-extension:plan-mode",
	"pi-extension:proactive-compaction",
	"pi-extension:publish",
	"pi-extension:pull",
	"pi-extension:question",
	"pi-extension:session-cleanup",
	"pi-extension:session-recap",
	"pi-extension:session-title",
	"pi-extension:subagent",
	"pi-extension:team",
	"pi-extension:todo",
	"pi-extension:token-speed",
	"pi-extension:worktree",
];
const skillIds = ["skill:foreman-plan", "skill:foreman-review", "skill:foreman-worker"];

function definition(
	id: ComponentId,
	overrides: Partial<ComponentDefinition> = {},
): ComponentDefinition {
	const category = id.slice(0, id.indexOf(":")) as ComponentDefinition["category"];
	return {
		id,
		category,
		label: id,
		description: id,
		resources: [],
		outputs: [],
		dependsOn: [],
		requirements: [],
		...overrides,
	};
}

async function errorCode(action: () => Promise<unknown>): Promise<string | undefined> {
	try {
		await action();
	} catch (error) {
		expect(error).toBeInstanceOf(RegistryError);
		return (error as RegistryError).code;
	}
	return undefined;
}

describe("component registry", () => {
	it("contains the exact approved inventory and valid source resources", async () => {
		await expect(validateRegistry(components, process.cwd())).resolves.toBeUndefined();
		expect(components.length).toBe(
			30 +
				(localPiConfigFiles.settings ? 1 : 0) +
				(localPiConfigFiles.models ? 1 : 0) +
				1 +
				(localPiConfigFiles.mcp ? 2 : 0) +
				5,
		);
		expect(components.filter(({ category }) => category === "skill").map(({ id }) => id)).toEqual(
			skillIds,
		);
		expect(
			components.filter(({ category }) => category === "pi-extension").map(({ id }) => id),
		).toEqual(extensionIds);
		expect(components.slice(31).map(({ id }) => id)).toEqual([
			...(localPiConfigFiles.settings ? ["pi-config:settings"] : []),
			...(localPiConfigFiles.models ? ["pi-config:models"] : []),
			"pi-config:keybindings",
			...(localPiConfigFiles.mcp ? ["pi-package:mcp-adapter", "pi-config:mcp-sentry"] : []),
			"pi-theme:claude-code",
			"pi-prompt:orchestrate",
			"pi-team:product",
			"instructions:shared",
		]);
	});

	it("resolves exact deterministic profile closures", () => {
		const defaultIds = resolveProfile("default");
		const piIds = resolveProfile("pi");
		expect(defaultIds).toHaveLength(components.length);
		expect(piIds).toHaveLength(
			components.filter(({ category }) =>
				["pi-extension", "pi-config", "pi-package", "pi-prompt", "pi-theme", "pi-team"].includes(
					category,
				),
			).length + 1,
		);
		expect(resolveProfile("skills")).toEqual(skillIds);
		expect(new Set(defaultIds)).toEqual(new Set(components.map(({ id }) => id)));
		expect(piIds).toContain("instructions:shared");
		expect(piIds.some((id) => id.startsWith("skill:"))).toBe(false);
		expect(profiles.map(({ id }) => id)).toEqual(["default", "pi", "skills"]);
		expect(resolveProfile("default")).toEqual(defaultIds);
	});

	it("adds mandatory dependencies and stable-sorts by category then label", () => {
		expect(resolveSelection(["pi-extension:team"])).toEqual([
			"pi-extension:subagent",
			"pi-extension:team",
		]);
		expect(resolveSelection(["pi-team:product"])).toEqual([
			"pi-extension:subagent",
			"pi-extension:team",
			"pi-team:product",
		]);
		if (localPiConfigFiles.mcp) {
			expect(resolveSelection(["pi-config:mcp-sentry"])).toEqual([
				"pi-config:mcp-sentry",
				"pi-package:mcp-adapter",
			]);
		}
		if (localPiConfigFiles.settings) {
			expect(resolveSelection(["pi-config:settings"])).toEqual([
				"pi-config:settings",
				"pi-theme:claude-code",
			]);
		}
	});

	it("rejects duplicate and malformed IDs", async () => {
		const one = definition("skill:one");
		expect(await errorCode(() => validateRegistry([one, one]))).toBe("duplicate-id");
		expect(
			await errorCode(() => validateRegistry([definition("skill:bad:slug" as ComponentId)])),
		).toBe("duplicate-id");
	});

	it("rejects missing dependencies and cycles", async () => {
		expect(
			await errorCode(() =>
				validateRegistry([definition("skill:one", { dependsOn: ["skill:missing"] })]),
			),
		).toBe("missing-dependency");
		expect(
			await errorCode(() =>
				validateRegistry([
					definition("skill:one", { dependsOn: ["skill:two"] }),
					definition("skill:two", { dependsOn: ["skill:one"] }),
				]),
			),
		).toBe("dependency-cycle");
	});

	it("rejects exclusive output collisions", async () => {
		const output = { strategy: "copy" as const, destination: ".agents/skills/shared" };
		expect(
			await errorCode(() =>
				validateRegistry([
					definition("skill:one", { outputs: [output] }),
					definition("skill:two", { outputs: [output] }),
				]),
			),
		).toBe("duplicate-output");
	});

	it("rejects missing and escaping resources", async () => {
		const root = await mkdtemp(join(tmpdir(), "agents-registry-"));
		await writeFile(join(root, "present"), "ok");
		expect(
			await errorCode(() =>
				validateRegistry(
					[definition("skill:one", { resources: [{ path: "missing", kind: "file" }] })],
					root,
				),
			),
		).toBe("missing-resource");
		expect(
			await errorCode(() =>
				validateRegistry(
					[definition("skill:one", { resources: [{ path: "../present", kind: "file" }] })],
					root,
				),
			),
		).toBe("missing-resource");
	});

	it("rejects unknown selections and profiles", () => {
		expect(() => resolveSelection(["skill:unknown"])).toThrowError(
			expect.objectContaining({ code: "unknown-component" }),
		);
		expect(() => resolveProfile("unknown")).toThrowError(
			expect.objectContaining({ code: "unknown-component" }),
		);
		expect(() => createResolver([])(["skill:unknown"])).toThrowError(RegistryError);
	});
});
