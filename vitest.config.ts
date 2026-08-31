import process from "node:process";

const DEFAULT_EXTENSION_TEST_CONCURRENCY = 4;

export function resolveExtensionTestConcurrency(value: string | undefined): number {
	if (value === undefined) return DEFAULT_EXTENSION_TEST_CONCURRENCY;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error("EXTENSION_TEST_CONCURRENCY must be a positive integer");
	}
	return parsed;
}

export default {
	test: {
		include: ["test/**/*.test.ts"],
		fileParallelism: false,
		maxConcurrency: resolveExtensionTestConcurrency(process.env.EXTENSION_TEST_CONCURRENCY),
	},
};
