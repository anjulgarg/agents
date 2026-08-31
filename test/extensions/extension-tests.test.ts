import { relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
	collectExtensionTests,
	isSerialExtensionTest,
	LIVE_EXTENSION_TESTS,
	resolveExtensionTestTimeoutMs,
	runExtensionTest,
} from "./extension-test-runtime.ts";

const root = process.cwd();
const timeoutMs = resolveExtensionTestTimeoutMs(process.env.EXTENSION_TEST_TIMEOUT_MS);
const tests = collectExtensionTests(root);
const display = (path: string): string => relative(root, path).replaceAll("\\", "/");
const parallelTests = tests.filter((path) => !isSerialExtensionTest(display(path)));
const serialTests = tests.filter((path) => isSerialExtensionTest(display(path)));
let pendingParallelTests = parallelTests.length;
let releaseSerialTests: () => void = () => undefined;
const parallelTestsComplete = new Promise<void>((resolve) => {
	releaseSerialTests = resolve;
});

async function expectExtensionTestToPass(path: string): Promise<void> {
	const result = await runExtensionTest(path, root, timeoutMs);
	if (process.env.EXTENSION_TEST_VERBOSE === "1" && result.stdout)
		process.stdout.write(result.stdout);
	expect(result.exitCode, `${result.display}\n${result.stdout}${result.stderr}`).toBe(0);
}

describe.concurrent("extension tests", () => {
	for (const path of parallelTests) {
		it(
			display(path),
			async () => {
				try {
					await expectExtensionTestToPass(path);
				} finally {
					pendingParallelTests -= 1;
					if (pendingParallelTests === 0) releaseSerialTests();
				}
			},
			timeoutMs + 1_000,
		);
	}
});

describe.sequential("serial extension tests", () => {
	for (const path of serialTests) {
		it(
			display(path),
			async () => {
				await parallelTestsComplete;
				await expectExtensionTestToPass(path);
			},
			(parallelTests.length + 1) * timeoutMs,
		);
	}
});

describe("extension test inventory", () => {
	it("discovers retained tests and explicitly excludes live model tests", () => {
		expect(tests.length).toBeGreaterThan(0);
		expect(LIVE_EXTENSION_TESTS).toEqual(
			new Set([
				"pi/extensions/subagent/rpc-client.smoke.ts",
				"pi/extensions/subagent/supervisor.e2e.ts",
			]),
		);
	});
});
