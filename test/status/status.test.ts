import { cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	ComponentDefinition,
	OutputDefinition,
	ReadOnlyFileSystem,
} from "../../src/domain/contracts.ts";
import { components } from "../../src/registry/catalog.ts";
import { resolveContainedPath, resolveSource } from "../../src/registry/destinations.ts";
import { inspectSystem, inspectionPathIsProtected } from "../../src/status/inspect.ts";
import { readReceipt } from "../../src/status/receipt.ts";

const sourceRoot = process.cwd();

async function fixtureHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "agents-status-"));
}

function find(result: Awaited<ReturnType<typeof inspectSystem>>, id: string) {
	return result.components.find((component) => component.id === id)!;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function installCopy(home: string, component: ComponentDefinition): Promise<void> {
	const output = component.outputs.find(({ strategy }) => strategy === "copy");
	const resource = component.resources.find(({ kind }) => kind !== "external");
	if (!output || output.strategy !== "copy" || !resource) throw new Error("copy fixture expected");
	const destination = resolveContainedPath(home, output.destination);
	await mkdir(dirname(destination), { recursive: true });
	await cp(resolveSource(sourceRoot, resource.path), destination, { recursive: true });
}

function setPointer(target: Record<string, unknown>, pointer: string, value: unknown): void {
	const segments = pointer
		.slice(1)
		.split("/")
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
	let current = target;
	for (const segment of segments.slice(0, -1)) {
		if (typeof current[segment] !== "object" || current[segment] === null) current[segment] = {};
		current = current[segment] as Record<string, unknown>;
	}
	current[segments.at(-1)!] = value;
}

function getPointer(source: Record<string, unknown>, pointer: string): unknown {
	return pointer
		.slice(1)
		.split("/")
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
		.reduce<unknown>(
			(current, segment) =>
				typeof current === "object" && current !== null
					? (current as Record<string, unknown>)[segment]
					: undefined,
			source,
		);
}

async function materializeAll(home: string): Promise<void> {
	const jsonDestinations = new Map<string, Record<string, unknown>>();
	for (const component of components) {
		const resource = component.resources.find(({ kind }) => kind !== "external");
		for (const output of component.outputs) {
			const destination = resolveContainedPath(home, output.destination);
			await mkdir(dirname(destination), { recursive: true });
			if (output.strategy === "copy") {
				await cp(resolveSource(sourceRoot, resource!.path), destination, { recursive: true });
			} else if (output.strategy === "owned-json") {
				const source = JSON.parse(
					await readFile(resolveSource(sourceRoot, resource!.path), "utf8"),
				) as Record<string, unknown>;
				const target = jsonDestinations.get(destination) ?? {};
				for (const pointer of output.pointers)
					setPointer(target, pointer, getPointer(source, pointer));
				jsonDestinations.set(destination, target);
			} else if (output.strategy === "managed-block") {
				const instructions = (
					await readFile(resolveSource(sourceRoot, resource!.path), "utf8")
				).trim();
				const content =
					output.content === "{{resource:pi/AGENTS.md}}" ? instructions : output.content;
				await writeFile(destination, `${output.beginMarker}\n${content}\n${output.endMarker}\n`);
			}
		}
	}

	for (const [path, value] of jsonDestinations) await writeJson(path, value);
	const settingsPath = resolveContainedPath(home, ".pi/agent/settings.json");
	const settings = jsonDestinations.get(settingsPath) ?? {};
	settings.packages = [
		"npm:pi-mcp-adapter@2.15.0",
		{
			source: resolve(sourceRoot),
			extensions: components
				.flatMap(({ outputs }) => outputs)
				.filter(
					(output): output is Extract<OutputDefinition, { strategy: "pi-package-filter" }> =>
						output.strategy === "pi-package-filter" && output.resourceKind === "extensions",
				)
				.map(({ filter }) => filter),
			skills: [],
			prompts: ["+pi/prompts/orchestrate.md"],
			themes: ["+pi/themes/claude-code.json"],
		},
	];
	await writeJson(settingsPath, settings);
}

async function snapshot(path: string): Promise<string[]> {
	const result: string[] = [];
	async function visit(current: string, prefix: string): Promise<void> {
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const child = join(current, entry.name);
			const name = `${prefix}${entry.name}`;
			if (entry.isDirectory()) {
				result.push(`${name}/`);
				await visit(child, `${name}/`);
			} else {
				result.push(`${name}:${(await readFile(child)).toString("base64")}`);
			}
		}
	}
	await visit(path, "");
	return result;
}

describe("read-only system status", () => {
	it("reports available when outputs do not exist", async () => {
		const home = await fixtureHome();
		const result = await inspectSystem({ home, sourceRoot });
		expect(find(result, "skill:foreman-plan")).toMatchObject({
			status: "available",
			managed: false,
		});
		expect(result.receipt.schemaState).toBe("absent");
	});

	it("reports every component installed from exact outputs", async () => {
		const home = await fixtureHome();
		await materializeAll(home);
		const result = await inspectSystem({ home, sourceRoot });
		expect(result.components).toHaveLength(components.length);
		expect(result.components.map(({ status }) => status)).toEqual(
			Array.from({ length: components.length }, () => "installed"),
		);
	});

	it("distinguishes changed copies, changed owned JSON, partial, and unavailable", async () => {
		const home = await fixtureHome();
		const skill = components.find(({ id }) => id === "skill:foreman-plan")!;
		await installCopy(home, skill);
		await writeFile(join(home, ".agents/skills/foreman-plan/SKILL.md"), "changed");
		expect(find(await inspectSystem({ home, sourceRoot }), "skill:foreman-plan").status).toBe(
			"drifted",
		);

		await mkdir(join(home, ".claude"), { recursive: true });
		await cp(join(sourceRoot, "pi/AGENTS.md"), join(home, ".claude/AGENTS.md"), {
			recursive: true,
		});
		expect(find(await inspectSystem({ home, sourceRoot }), "instructions:shared").status).toBe(
			"partial",
		);
	});

	it("recognizes filtered local Pi resources", async () => {
		const home = await fixtureHome();
		await writeJson(join(home, ".pi/agent/settings.json"), {
			packages: [
				{
					source: sourceRoot,
					extensions: ["+pi/extensions/question.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			],
		});
		expect(find(await inspectSystem({ home, sourceRoot }), "pi-extension:question").status).toBe(
			"installed",
		);
		expect(find(await inspectSystem({ home, sourceRoot }), "pi-extension:branch").status).toBe(
			"available",
		);
	});

	it("detects exact legacy direct extensions before a receipt", async () => {
		const home = await fixtureHome();
		const component = components.find(({ id }) => id === "pi-extension:question")!;
		const legacy = join(home, ".pi/agent/extensions/question.ts");
		await mkdir(dirname(legacy), { recursive: true });
		await cp(join(sourceRoot, "pi/extensions/question.ts"), legacy);
		const inspection = find(await inspectSystem({ home, sourceRoot }), component.id);
		expect(inspection).toMatchObject({ status: "installed", managed: false });
		expect(inspection.outputs).toContainEqual(
			expect.objectContaining({ strategy: "legacy-copy", state: "legacy" }),
		);
	});

	it("derives managed ownership only from a valid current receipt", async () => {
		const home = await fixtureHome();
		await writeJson(join(home, ".agents/anjulgarg-agents.json"), {
			schemaVersion: 1,
			source: { kind: "local", root: sourceRoot, revision: null },
			components: {
				"skill:foreman-plan": {
					installedAt: "2026-01-01T00:00:00Z",
					sourceDigest: "x",
					outputs: [],
				},
			},
		});
		expect(find(await inspectSystem({ home, sourceRoot }), "skill:foreman-plan").managed).toBe(
			true,
		);

		await writeJson(join(home, ".agents/anjulgarg-agents.json"), {
			schemaVersion: 2,
			secretFutureValue: "must-not-leak",
		});
		const future = await inspectSystem({ home, sourceRoot });
		expect(future.receipt.schemaState).toBe("future");
		expect(future.components.every(({ managed }) => !managed)).toBe(true);
		expect(JSON.stringify(future)).not.toContain("must-not-leak");

		await writeFile(join(home, ".agents/anjulgarg-agents.json"), "{");
		const malformed = await readReceipt(home);
		expect(malformed.schemaState).toBe("malformed");
		expect(malformed.managedComponents.size).toBe(0);
	});

	it("reports only unknown skill directories as unmanaged", async () => {
		const home = await fixtureHome();
		await mkdir(join(home, ".agents/skills/my-skill"), { recursive: true });
		await mkdir(join(home, ".agents/skills/foreman-plan"), { recursive: true });
		await writeFile(join(home, ".agents/skills/not-a-directory"), "x");
		const result = await inspectSystem({ home, sourceRoot });
		expect(result.unmanagedSkills).toEqual([
			{ name: "my-skill", path: join(home, ".agents/skills/my-skill") },
		]);
		expect(result.components.map(({ id }) => id)).not.toContain("skill:my-skill");
	});

	it("does not access protected state, use network, or mutate the fixture", async () => {
		const home = await fixtureHome();
		await mkdir(join(home, ".pi/agent/sessions/private"), { recursive: true });
		await writeFile(join(home, ".pi/agent/sessions/private/token"), "secret");
		await mkdir(join(home, ".npm/cache"), { recursive: true });
		const before = await snapshot(home);
		const accessed: string[] = [];
		const fs: ReadOnlyFileSystem = {
			async readFile(path) {
				accessed.push(path);
				if (inspectionPathIsProtected(path, home)) throw new Error(`protected read: ${path}`);
				return readFile(path);
			},
			async readdir(path) {
				accessed.push(path);
				if (inspectionPathIsProtected(path, home)) throw new Error(`protected read: ${path}`);
				return readdir(path, { withFileTypes: true });
			},
			async lstat(path) {
				accessed.push(path);
				if (inspectionPathIsProtected(path, home)) throw new Error(`protected read: ${path}`);
				return lstat(path);
			},
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("network forbidden"));
		await expect(inspectSystem({ home, sourceRoot, fs })).resolves.toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
		expect(accessed.some((path) => inspectionPathIsProtected(path, home))).toBe(false);
		expect(await snapshot(home)).toEqual(before);
	});
});
