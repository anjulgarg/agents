import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentsUiServices } from "../../src/cli/services.ts";
import { runCli } from "../../src/cli/run.ts";
import type { AgentsUiServices } from "../../src/ui/contracts.ts";

export const sourceRoot = resolve(".");
const temporaryRoots: string[] = [];

export async function fixtureHome(): Promise<{ root: string; home: string }> {
	const root = await mkdtemp(join(tmpdir(), "agents-e2e-"));
	temporaryRoots.push(root);
	return { root, home: join(root, "home") };
}

export async function cleanupFixtures(): Promise<void> {
	await Promise.all(
		temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
}

export async function runAgents(
	home: string,
	args: readonly string[],
	services: AgentsUiServices = createAgentsUiServices(),
): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runCli(
		[...args, "--home", home],
		{ services, sourceRoot },
		{
			stdout: { columns: 100, isTTY: false, write: (value) => stdout.push(value) },
			stderr: { write: (value) => stderr.push(value) },
		},
	);
	return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

export async function inventory(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	async function visit(directory: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else result[path.slice(root.length + 1)] = (await readFile(path)).toString("base64");
		}
	}
	await visit(root);
	return result;
}
