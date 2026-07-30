import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIVE_TESTS = new Set([
	"pi/extensions/subagent/rpc-client.smoke.ts",
	"pi/extensions/subagent/supervisor.e2e.ts",
]);
const SERIAL_TESTS = new Set(["pi/extensions/tests/git-checkpoint.test.ts"]);
const DEFAULT_MAX_CONCURRENCY = 4;

interface ExtensionTestResult {
	readonly display: string;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
}

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

export function isSerialExtensionTest(display: string): boolean {
	return SERIAL_TESTS.has(display);
}

export function resolveExtensionTestConcurrency(
	value: string | undefined,
	testCount: number,
	parallelism = availableParallelism(),
): number {
	if (testCount < 1) return 0;
	if (value !== undefined) {
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < 1) {
			throw new Error("EXTENSION_TEST_CONCURRENCY must be a positive integer");
		}
		return Math.min(parsed, testCount);
	}
	return Math.min(DEFAULT_MAX_CONCURRENCY, Math.max(1, parallelism), testCount);
}

export async function runWithConcurrency<Item, Result>(
	items: readonly Item[],
	concurrency: number,
	run: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new Error("Concurrency must be a positive integer");
	}
	const results = new Array<Result>(items.length);
	let nextIndex = 0;
	async function worker(): Promise<void> {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await run(items[index]!, index);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => worker()),
	);
	return results;
}

function extensionTestEnvironment(tsxLoader: string): NodeJS.ProcessEnv {
	const nodeOptions = [process.env.NODE_OPTIONS, `--import=${tsxLoader}`].filter(Boolean).join(" ");
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		NODE_NO_WARNINGS: "1",
		NODE_OPTIONS: nodeOptions,
	};
	delete environment.PI_SUBAGENT_CHILD;
	delete environment.PI_SUBAGENT_OWNER_TOKEN;
	return environment;
}

async function runExtensionTest(
	test: string,
	root: string,
	tsxCli: string,
	tsxLoader: string,
): Promise<ExtensionTestResult> {
	const display = relative(root, test).replaceAll("\\", "/");
	const startedAt = performance.now();
	return new Promise((resolveResult) => {
		const child = spawn(process.execPath, [tsxCli, test], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			env: extensionTestEnvironment(tsxLoader),
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", (error) => (stderr += `${error.message}\n`));
		child.on("close", (exitCode) => {
			resolveResult({
				display,
				exitCode,
				stdout,
				stderr,
				durationMs: Math.round(performance.now() - startedAt),
			});
		});
	});
}

async function main(): Promise<void> {
	const root = process.cwd();
	const tests = await collectTests(resolve(root, "pi/extensions"), root);
	if (tests.length === 0) throw new Error("No retained extension tests found");
	const serialTests = tests.filter((test) =>
		isSerialExtensionTest(relative(root, test).replaceAll("\\", "/")),
	);
	const parallelTests = tests.filter((test) => !serialTests.includes(test));
	const concurrency = resolveExtensionTestConcurrency(
		process.env.EXTENSION_TEST_CONCURRENCY,
		parallelTests.length,
	);
	const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
	const tsxLoader = pathToFileURL(resolve(root, "node_modules/tsx/dist/loader.mjs")).href;
	const verbose = process.env.EXTENSION_TEST_VERBOSE === "1";
	process.stdout.write(
		`[extension-test] running ${parallelTests.length} parallel files with ${concurrency} workers and ${serialTests.length} serial files\n`,
	);
	const parallelResults = await runWithConcurrency(parallelTests, concurrency, (test) =>
		runExtensionTest(test, root, tsxCli, tsxLoader),
	);
	const serialResults = await runWithConcurrency(serialTests, 1, (test) =>
		runExtensionTest(test, root, tsxCli, tsxLoader),
	);
	const results = [...parallelResults, ...serialResults];
	const failures: string[] = [];
	for (const result of results) {
		const passed = result.exitCode === 0;
		process.stdout.write(
			`[extension-test] ${passed ? "PASS" : "FAIL"} ${result.display} (${result.durationMs} ms)\n`,
		);
		if (verbose || !passed) {
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
		}
		if (!passed) failures.push(result.display);
	}
	if (failures.length > 0) {
		throw new Error(`Extension tests failed (${failures.length}): ${failures.join(", ")}`);
	}
	process.stdout.write(
		`[extension-test] passed ${tests.length} files; excluded ${LIVE_TESTS.size} live files\n`,
	);
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryUrl === import.meta.url) {
	void main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
