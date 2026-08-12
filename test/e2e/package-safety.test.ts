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
			"pi/extensions/team/index.ts",
			"pi/AGENTS.md",
			"pi/prompts/orchestrate.md",
			"skills/foreman-plan/SKILL.md",
			"pi/teams/product.json",
			"pi/themes/claude-code.json",
		]) {
			expect(files, `missing packed runtime file ${required}`).toContain(required);
		}
		expect(files).not.toContainEqual(
			expect.stringMatching(/^(?:test|src|scripts|docs\/plans)(?:\/|$)/),
		);
		for (const privateConfig of ["pi/config/settings.json", "pi/config/mcp.json"]) {
			expect(files).not.toContain(privateConfig);
		}
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
			JSON.stringify({ custom: { keep: true }, packages: ["npm:other@1"] }),
		);

		const result = await runAgents(home, ["install", "--profile", "pi", "--yes", "--json"]);
		expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
		const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
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
		expect(settings.custom).toEqual({ keep: true });
		expect(settings.packages).toContain("npm:other@1");
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
		const runner = await readFile(join(sourceRoot, "scripts/run-extension-tests.ts"), "utf8");
		expect(runner).toContain("rpc-client.smoke.ts");
		expect(runner).toContain("supervisor.e2e.ts");
		expect(runner).toContain("!LIVE_TESTS.has(display)");
	});
});
