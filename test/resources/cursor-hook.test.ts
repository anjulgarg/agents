import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	STATE_TTL_MS,
	injectAgents,
	markerName,
	type HookPaths,
} from "../../harnesses/cursor/inject-agents.ts";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ root: string; paths: HookPaths }> {
	const root = await mkdtemp(join(tmpdir(), "agents-cursor-hook-"));
	temporaryDirectories.push(root);
	const cursor = join(root, ".cursor");
	await mkdir(cursor, { recursive: true });
	return {
		root,
		paths: {
			guidelines: join(cursor, "AGENTS.md"),
			stateDirectory: join(cursor, ".agents-injected"),
		},
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("Cursor agent injection hook", () => {
	it("injects trimmed guidelines once without changing existing input fields", async () => {
		const { paths } = await fixture();
		await writeFile(paths.guidelines, "\nShared rules\n", "utf8");
		const input = JSON.stringify({ conversation_id: "conversation-1", prompt: "keep me" });
		expect(await injectAgents(input, paths)).toEqual({ additional_context: "Shared rules" });
		expect(await injectAgents(input, paths)).toEqual({});
		expect(JSON.parse(input)).toEqual({ conversation_id: "conversation-1", prompt: "keep me" });
	});

	it("fails silently for malformed input, missing ids, and missing guidelines", async () => {
		const { paths } = await fixture();
		expect(await injectAgents("not json", paths)).toEqual({});
		expect(await injectAgents("{}", paths)).toEqual({});
		expect(await injectAgents('{"conversation_id":"x"}', paths)).toEqual({});
	});

	it("hashes traversal-like and oversized conversation ids", () => {
		expect(markerName("../../outside")).toMatch(/^[a-f0-9]{64}$/);
		expect(markerName("x".repeat(65))).toMatch(/^[a-f0-9]{64}$/);
		expect(markerName("safe_ID-1")).toBe("safe_ID-1");
	});

	it("prunes expired markers after a successful claim", async () => {
		const { paths } = await fixture();
		await writeFile(paths.guidelines, "Rules", "utf8");
		await mkdir(paths.stateDirectory, { recursive: true });
		const stale = join(paths.stateDirectory, "stale");
		await writeFile(stale, "", "utf8");
		const now = Date.now();
		await utimes(stale, new Date(now - STATE_TTL_MS - 1_000), new Date(now - STATE_TTL_MS - 1_000));
		expect(await injectAgents('{"conversation_id":"fresh"}', paths, now)).toEqual({
			additional_context: "Rules",
		});
		await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
