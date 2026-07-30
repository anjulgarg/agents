import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIVE_TESTS = new Set([
	"pi/extensions/subagent/rpc-client.smoke.ts",
	"pi/extensions/subagent/supervisor.e2e.ts",
]);

async function collectTests(directory: string, root: string): Promise<string[]> {
	const tests: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) tests.push(...(await collectTests(path, root)));
		else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
			const display = relative(root, path).replaceAll("\\", "/");
			if (!LIVE_TESTS.has(display) && !/\.(?:smoke|e2e)\.ts$/.test(display)) tests.push(path);
		}
	}
	return tests.sort();
}

async function main(): Promise<void> {
	const root = process.cwd();
	const tests = await collectTests(resolve(root, "pi/extensions"), root);
	if (tests.length === 0) throw new Error("No retained extension tests found");
	const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
	const failures: string[] = [];
	for (const test of tests) {
		const display = relative(root, test).replaceAll("\\", "/");
		process.stdout.write(`\n[extension-test] ${display}\n`);
		const tsxLoader = pathToFileURL(resolve(root, "node_modules/tsx/dist/loader.mjs")).href;
		const nodeOptions = [process.env.NODE_OPTIONS, `--import=${tsxLoader}`]
			.filter(Boolean)
			.join(" ");
		const environment: NodeJS.ProcessEnv = {
			...process.env,
			NODE_NO_WARNINGS: "1",
			NODE_OPTIONS: nodeOptions,
		};
		delete environment.PI_SUBAGENT_CHILD;
		delete environment.PI_SUBAGENT_OWNER_TOKEN;
		const result = spawnSync(process.execPath, [tsxCli, test], {
			cwd: root,
			stdio: "inherit",
			env: environment,
		});
		if (result.status !== 0) failures.push(display);
	}
	if (failures.length > 0)
		throw new Error(`Extension tests failed (${failures.length}): ${failures.join(", ")}`);
	process.stdout.write(
		`\n[extension-test] passed ${tests.length} files; excluded ${LIVE_TESTS.size} live files\n`,
	);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
