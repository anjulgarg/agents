import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupFixtures, fixtureHome, runAgents, sourceRoot } from "./helpers.ts";

const execFileAsync = promisify(execFile);

afterEach(cleanupFixtures);

describe("package and repository safety", () => {
	it("T1 keeps required local operating and recovery instructions discoverable", async () => {
		await fixtureHome();
		const readme = await readFile(join(sourceRoot, "README.md"), "utf8");
		for (const expected of [
			"Node.js 22.19.0",
			"npm ci",
			"npm run build",
			"npm link",
			"--home",
			"--json",
			"agents doctor",
			"agents remove",
			"/reload",
		]) {
			expect(readme).toContain(expected);
		}
	});

	it("T3 validates dry-run package inventory and the 2.5 MiB budget", async () => {
		const { root } = await fixtureHome();
		const { stdout } = await execFileAsync(
			process.platform === "win32" ? "npm.cmd" : "npm",
			["pack", "--dry-run", "--json", "--ignore-scripts"],
			{
				cwd: sourceRoot,
				env: {
					...process.env,
					HOME: root,
					npm_config_cache: join(root, "npm-cache"),
					npm_config_userconfig: join(root, "empty-npmrc"),
					npm_config_offline: "true",
				},
			},
		);
		const packed = JSON.parse(stdout)[0] as {
			unpackedSize: number;
			files: { path: string }[];
		};
		const files = packed.files.map(({ path }) => path);
		for (const required of [
			"dist/cli.js",
			"pi/config/keybindings.json",
			"pi/extensions/question.ts",
			"pi/extensions/tool-loader.ts",
			"pi/AGENTS.md",
			"pi/prompts/orchestrate.md",
			"skills/foreman-plan/SKILL.md",
			"pi/themes/foreman.json",
		]) {
			expect(files, `missing packed runtime file ${required}`).toContain(required);
		}
		expect(files).not.toContainEqual(
			expect.stringMatching(/^(?:test|src|scripts|docs\/plans)(?:\/|$)/),
		);
		for (const privateConfig of [
			"pi/config/settings.json",
			"pi/config/mcp.json",
			"pi/config/models.json",
			"pi/config/models-store.json",
		]) {
			expect(files).not.toContain(privateConfig);
		}
		const { stdout: trackedModelFiles } = await execFileAsync(
			"git",
			["ls-files", "--", "pi/config/models.json", "pi/config/models-store.json"],
			{ cwd: sourceRoot },
		);
		expect(trackedModelFiles.trim()).toBe("");
		expect(files).not.toContainEqual(
			expect.stringMatching(
				/(?:^|\/)(?:sessions|state|npm|git|credentials|node_modules|__pycache__)(?:\/|$)/,
			),
		);
		expect(files).not.toContainEqual(expect.stringMatching(/\.(?:smoke|e2e|test)\.ts$/));
		expect(packed.unpackedSize).toBeLessThanOrEqual(2.5 * 1024 * 1024);
	});

	it("T6 installs the loader once and preserves unrelated Pi settings", async () => {
		const { home } = await fixtureHome();
		const settingsPath = join(home, ".pi/agent/settings.json");
		await mkdir(join(home, ".pi/agent"), { recursive: true });
		await writeFile(
			settingsPath,
			JSON.stringify({
				enabledModels: ["provider/model"],
				custom: { keep: true },
				packages: ["npm:other@1"],
			}),
		);
		await writeFile(join(home, ".pi/agent/models.json"), "custom-model-config\n");
		await writeFile(join(home, ".pi/agent/models-store.json"), "runtime-model-cache\n");

		const result = await runAgents(home, ["install", "--profile", "pi", "--yes", "--json"]);
		expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
		const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
			enabledModels?: string[];
			custom: { keep: boolean };
			packages: unknown[];
		};
		const localPackages = settings.packages.filter(
			(entry): entry is { source: string; extensions?: string[] } =>
				typeof entry === "object" && entry !== null && "source" in entry,
		);
		const loaderFilters = localPackages.flatMap((entry) =>
			(entry.extensions ?? []).filter((filter) => filter === "+pi/extensions/tool-loader.ts"),
		);
		expect(settings.enabledModels).toEqual(["provider/model"]);
		expect(settings.custom).toEqual({ keep: true });
		expect(settings.packages).toContain("npm:other@1");
		expect(await readFile(join(home, ".pi/agent/models.json"), "utf8")).toBe(
			"custom-model-config\n",
		);
		expect(await readFile(join(home, ".pi/agent/models-store.json"), "utf8")).toBe(
			"runtime-model-cache\n",
		);
		expect(localPackages).toHaveLength(1);
		expect(loaderFilters).toEqual(["+pi/extensions/tool-loader.ts"]);
	});

	it("T7 remains npm-private, unpublished, and excludes live model calls", async () => {
		const packageJson = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")) as {
			private?: boolean;
			scripts: Record<string, string>;
		};
		expect(packageJson.private).toBe(true);
		expect(Object.keys(packageJson.scripts)).not.toContain("publish");
		expect(Object.values(packageJson.scripts).join(" ")).not.toMatch(/npm\s+publish/);
		const extensionTests = await readFile(
			join(sourceRoot, "test/extensions/extension-test-runtime.ts"),
			"utf8",
		);
		expect(extensionTests).toContain("rpc-client.smoke.ts");
		expect(extensionTests).toContain("supervisor.e2e.ts");
		expect(extensionTests).toContain("!LIVE_EXTENSION_TESTS.has(display)");
	});
});
