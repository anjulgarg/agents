import { describe, expect, it } from "vitest";

import { resolveExtensionTestConcurrency } from "../../vitest.config.ts";
import {
	collectExtensionTests,
	isSerialExtensionTest,
	LIVE_EXTENSION_TESTS,
	resolveExtensionTestTimeoutMs,
} from "../extensions/extension-test-runtime.ts";

describe("extension test infrastructure", () => {
	it("keeps the Git checkpoint suite in the serial lane", () => {
		expect(isSerialExtensionTest("pi/extensions/tests/git-checkpoint.test.ts")).toBe(true);
		expect(isSerialExtensionTest("pi/extensions/tests/minimal-mode.test.ts")).toBe(false);
	});

	it("uses bounded Vitest concurrency and honors a valid override", () => {
		expect(resolveExtensionTestConcurrency(undefined)).toBe(4);
		expect(resolveExtensionTestConcurrency("8")).toBe(8);
	});

	it.each(["0", "-1", "1.5", "abc"])("rejects invalid concurrency %s", (value) => {
		expect(() => resolveExtensionTestConcurrency(value)).toThrow(
			"EXTENSION_TEST_CONCURRENCY must be a positive integer",
		);
	});

	it("uses a bounded per-file timeout and honors a valid override", () => {
		expect(resolveExtensionTestTimeoutMs(undefined)).toBe(120_000);
		expect(resolveExtensionTestTimeoutMs("30000")).toBe(30_000);
	});

	it.each(["0", "-1", "1.5", "abc"])("rejects invalid timeout %s", (value) => {
		expect(() => resolveExtensionTestTimeoutMs(value)).toThrow(
			"EXTENSION_TEST_TIMEOUT_MS must be a positive integer",
		);
	});

	it("discovers extension tests without live model tests", () => {
		const tests = collectExtensionTests(process.cwd());
		expect(tests).toHaveLength(59);
		for (const liveTest of LIVE_EXTENSION_TESTS) {
			expect(tests.some((path) => path.endsWith(liveTest))).toBe(false);
		}
	});
});
