import { createHash } from "node:crypto";
import { open, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface HookPaths {
	guidelines: string;
	stateDirectory: string;
}

export function defaultPaths(home = homedir()): HookPaths {
	const cursorDirectory = join(home, ".cursor");
	return {
		guidelines: join(cursorDirectory, "AGENTS.md"),
		stateDirectory: join(cursorDirectory, ".agents-injected"),
	};
}

export function markerName(conversationId: string): string {
	return /^[A-Za-z0-9_-]{1,64}$/.test(conversationId)
		? conversationId
		: createHash("sha256").update(conversationId, "utf8").digest("hex");
}

async function prune(stateDirectory: string, now: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(stateDirectory);
	} catch {
		return;
	}
	await Promise.all(
		names.map(async (name) => {
			const marker = join(stateDirectory, name);
			try {
				if (now - (await stat(marker)).mtimeMs > STATE_TTL_MS) await unlink(marker);
			} catch {
				// Stale-marker cleanup must never block a prompt.
			}
		}),
	);
}

export async function injectAgents(
	input: string,
	paths = defaultPaths(),
	now = Date.now(),
): Promise<Record<string, string>> {
	try {
		const payload = JSON.parse(input) as Record<string, unknown>;
		const conversationId = String(payload.conversation_id ?? "").trim();
		if (!conversationId) return {};

		const text = (await readFile(paths.guidelines, "utf8")).trim();
		if (!text) return {};

		await mkdir(paths.stateDirectory, { recursive: true });
		const marker = join(paths.stateDirectory, markerName(conversationId));
		let handle;
		try {
			handle = await open(marker, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return {};
			throw error;
		}
		await handle.close();
		await prune(paths.stateDirectory, now);
		return { additional_context: text };
	} catch {
		return {};
	}
}

async function main(): Promise<void> {
	let input = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) input += chunk;
	process.stdout.write(JSON.stringify(await injectAgents(input)));
}

if (
	process.argv[1]?.endsWith("inject-agents.ts") ||
	process.argv[1]?.endsWith("inject-agents.js")
) {
	main().catch(() => process.stdout.write("{}"));
}
