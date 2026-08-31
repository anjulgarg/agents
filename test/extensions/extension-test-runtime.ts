import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LIVE_EXTENSION_TESTS = new Set([
	"pi/extensions/subagent/rpc-client.smoke.ts",
	"pi/extensions/subagent/supervisor.e2e.ts",
]);

const SERIAL_EXTENSION_TESTS = new Set(["pi/extensions/tests/git-checkpoint.test.ts"]);
const DEFAULT_TEST_TIMEOUT_MS = 120_000;

export interface ExtensionTestResult {
	readonly display: string;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export function resolveExtensionTestTimeoutMs(
	value: string | undefined,
	defaultMs = DEFAULT_TEST_TIMEOUT_MS,
): number {
	if (value === undefined) return defaultMs;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error("EXTENSION_TEST_TIMEOUT_MS must be a positive integer");
	}
	return parsed;
}

export function isSerialExtensionTest(display: string): boolean {
	return SERIAL_EXTENSION_TESTS.has(display);
}

export function collectExtensionTests(root: string): string[] {
	const tests: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
				const display = relative(root, path).replaceAll("\\", "/");
				if (!LIVE_EXTENSION_TESTS.has(display) && !/\.(?:smoke|e2e)\.ts$/.test(display)) {
					tests.push(path);
				}
			}
		}
	};
	visit(resolve(root, "pi/extensions"));
	return tests.sort();
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

export async function runExtensionTest(
	testPath: string,
	root: string,
	timeoutMs: number,
): Promise<ExtensionTestResult> {
	const display = relative(root, testPath).replaceAll("\\", "/");
	const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
	const tsxLoader = pathToFileURL(resolve(root, "node_modules/tsx/dist/loader.mjs")).href;
	return await new Promise((resolveResult) => {
		const child = spawn(process.execPath, [tsxCli, testPath], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			env: extensionTestEnvironment(tsxLoader),
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (exitCode: number, note = ""): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ display, exitCode, stdout, stderr: stderr + note });
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", (error) => (stderr += `${error.message}\n`));
		child.on("close", (exitCode) => finish(exitCode ?? 1));
		const timer = setTimeout(() => {
			if (child.pid === undefined) return finish(1, `Timed out after ${timeoutMs} ms.\n`);
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch {
				// Process group already exited.
			}
			finish(1, `Timed out after ${timeoutMs} ms.\n`);
		}, timeoutMs);
		timer.unref?.();
	});
}
