import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { registerSubagentExtension } from "./index.ts";
import { emptyUsage, type RpcChildOptions } from "./rpc-client.ts";
import type { ChildHandle, Supervisor } from "./supervisor.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class FakeChild implements ChildHandle {
	readonly usage = emptyUsage();
	private text = "";

	constructor(private readonly options: RpcChildOptions) {}

	output(): string {
		return this.text;
	}

	prompt(): Promise<void> {
		return Promise.resolve();
	}

	steer(): Promise<void> {
		return Promise.resolve();
	}

	abort(): Promise<void> {
		return Promise.resolve();
	}

	kill(): void {}

	terminate(): Promise<boolean> {
		return Promise.resolve(true);
	}

	settle(text: string): void {
		this.text = text;
		this.usage.turns = 1;
		this.options.onEvent?.({ type: "agent_settled" });
	}
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: "toolUse" | "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function scriptedResponse(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
	});
	return stream;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for provider request");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function main(): Promise<void> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-session-"));
	const children: FakeChild[] = [];
	const contexts: Context[] = [];
	let providerCalls = 0;
	let supervisor: Supervisor | undefined;

	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	modelRuntime.registerProvider("test-provider", {
		api: "test-api",
		apiKey: "test-key",
		baseUrl: "http://test.invalid",
		models: [
			{
				id: "test-model",
				name: "Test model",
				api: "test-api",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10_000,
				maxTokens: 1_000,
			},
		],
		streamSimple: (_model: Model<any>, context: Context) => {
			providerCalls++;
			contexts.push(context);
			return scriptedResponse(
				providerCalls === 1
					? assistantMessage(
							[
								{
									type: "toolCall",
									id: "spawn-1",
									name: "subagent",
									arguments: { task: "inspect", access: "read-only" },
								},
							],
							"toolUse",
						)
					: assistantMessage([{ type: "text", text: "Completion wake handled." }], "stop"),
			);
		},
	});
	const model = modelRuntime.getModel("test-provider", "test-model");
	if (!model) throw new Error("scripted model was not registered");

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				supervisor = registerSubagentExtension(pi, {
					cleanupTickMs: 0,
					getModels: async () => [model],
					createChild: (options) => {
						const child = new FakeChild(options);
						children.push(child);
						return child;
					},
				});
			},
		],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		modelRuntime,
		model,
		thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(root),
		settingsManager,
		resourceLoader,
		tools: ["subagent", "read"],
	});

	try {
		await session.prompt("Delegate this task.");
		await new Promise((resolve) => setTimeout(resolve, 20));
		if (providerCalls !== 1 || children.length !== 1 || session.isStreaming) {
			throw new Error(
				`spawn did not settle cleanly: calls=${providerCalls} children=${children.length} streaming=${session.isStreaming}`,
			);
		}

		children[0].settle("done");
		await waitFor(() => providerCalls === 2);
		await session.agent.waitForIdle();

		const wakeContext = contexts[1]?.messages
			.map((message) => {
				if (message.role !== "user") return "";
				if (typeof message.content === "string") return message.content;
				return message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
			})
			.join("\n");
		if (providerCalls !== 2 || !wakeContext.includes("Subagent task 1 done: done")) {
			throw new Error(`completion wake mismatch: calls=${providerCalls} context=${wakeContext}`);
		}

		console.log(
			"PASS: real AgentSession stops after subagent spawn and resumes exactly once on completion",
		);
	} finally {
		session.dispose();
		supervisor?.dispose();
		await fs.promises.rm(root, { recursive: true, force: true });
	}
}

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
