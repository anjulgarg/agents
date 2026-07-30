/**
 * End-to-end smoke test for RpcChild against a real `pi --mode rpc` child.
 * Makes one real LLM call.
 *
 * Run: npx tsx pi/extensions/subagent/rpc-client.smoke.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RpcChild, type RpcEvent } from "./rpc-client.ts";

const MODEL = "openai-codex/gpt-5.6-luna";
const TIMEOUT_MS = 120_000;

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-rpc-smoke-"));
	const promptFile = path.join(dir, "system.md");
	await fs.promises.writeFile(promptFile, "You are a terse test subagent.", "utf8");

	const seen: string[] = [];
	const child = new RpcChild({
		cwd: dir,
		model: MODEL,
		thinking: "low",
		tools: ["read", "ls"],
		systemPromptFile: promptFile,
		projectTrusted: false,
		piBin: "pi",
		onEvent: (event: RpcEvent) => seen.push(event.type),
	});

	const timer = setTimeout(
		() => fail(`timed out after ${TIMEOUT_MS}ms; events=${seen.join(",")}`),
		TIMEOUT_MS,
	);
	timer.unref();

	try {
		const accepted = await child.prompt(
			"Reply with exactly the word READY and nothing else. Do not use tools.",
		);
		console.log(`prompt response: ${JSON.stringify(accepted)}`);

		await child.settled();
		console.log(`events: ${seen.join(", ")}`);
		console.log(`usage: ${JSON.stringify(child.usage)}`);

		const output = child.output();
		console.log(`final output: ${JSON.stringify(output)}`);

		if (!seen.includes("agent_settled")) fail(`no agent_settled event; got ${seen.join(",")}`);
		if (!output.toUpperCase().includes("READY"))
			fail(`final output missing READY: ${JSON.stringify(output)}`);
		if (child.usage.turns < 1) fail("no assistant turns recorded");
		if (child.exited)
			fail("child exited before cleanup; RPC mode should remain alive until reaped");

		const reaped = await child.terminate();
		const code = await child.waitForExit();
		if (!reaped || !child.exited)
			fail(`cleanup was not confirmed; reaped=${reaped} exited=${child.exited}`);
		console.log(`exit code after confirmed cleanup: ${code}`);

		console.log("PASS");
	} catch (error) {
		fail(`${error instanceof Error ? error.message : String(error)}\nstderr: ${child.stderr}`);
	} finally {
		child.kill();
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
}

void main();
