import { describe, expect, it } from "vitest";
import {
	isSerialExtensionTest,
	resolveExtensionTestConcurrency,
	runWithConcurrency,
} from "../../scripts/run-extension-tests.ts";

describe("extension test runner", () => {
	it("keeps the Git checkpoint suite in the serial lane", () => {
		expect(isSerialExtensionTest("pi/extensions/tests/git-checkpoint.test.ts")).toBe(true);
		expect(isSerialExtensionTest("pi/extensions/tests/minimal-mode.test.ts")).toBe(false);
	});

	it("uses a bounded default and honors a valid override", () => {
		expect(resolveExtensionTestConcurrency(undefined, 20, 16)).toBe(4);
		expect(resolveExtensionTestConcurrency(undefined, 2, 16)).toBe(2);
		expect(resolveExtensionTestConcurrency(undefined, 20, 1)).toBe(1);
		expect(resolveExtensionTestConcurrency("8", 3, 16)).toBe(3);
		expect(resolveExtensionTestConcurrency(undefined, 0, 16)).toBe(0);
	});

	it.each(["0", "-1", "1.5", "abc"])("rejects invalid concurrency %s", (value) => {
		expect(() => resolveExtensionTestConcurrency(value, 10, 16)).toThrow(
			"EXTENSION_TEST_CONCURRENCY must be a positive integer",
		);
	});

	it("runs every item once without exceeding the worker limit", async () => {
		let active = 0;
		let peak = 0;
		const completed: number[] = [];
		const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			completed.push(item);
			active -= 1;
			return item * 2;
		});
		expect(peak).toBe(2);
		expect(completed.sort()).toEqual([1, 2, 3, 4, 5]);
		expect(results).toEqual([2, 4, 6, 8, 10]);
	});

	it("rejects an invalid worker limit", async () => {
		await expect(runWithConcurrency([1], 0, async (item) => item)).rejects.toThrow(
			"Concurrency must be a positive integer",
		);
	});
});
