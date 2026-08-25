/**
 * Ephemeral /btw sidechannel chat tests.
 *
 * Run: npm run test:extensions
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function ensurePiModulePath(): void {
	if (process.env.PI_BTW_TEST_READY === "1") return;
	const candidates: string[] = [];
	const piBin = spawnSync("which", ["pi"], { encoding: "utf8" }).stdout?.trim();
	if (piBin) {
		try {
			candidates.push(path.resolve(path.dirname(fs.realpathSync(piBin)), ".."));
		} catch {}
	}
	try {
		const require = createRequire(import.meta.url);
		candidates.push(path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")));
	} catch {}
	const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout?.trim();
	if (npmRoot) candidates.push(path.join(npmRoot, "@earendil-works/pi-coding-agent"));
	const piRoot = candidates.find((candidate) =>
		fs.existsSync(path.join(candidate, "node_modules", "@earendil-works", "pi-ai")),
	);
	if (!piRoot) throw new Error("Cannot locate @earendil-works/pi-coding-agent");
	const nodePath = [
		path.join(piRoot, "node_modules"),
		path.dirname(path.dirname(piRoot)),
		process.env.NODE_PATH,
	]
		.filter(Boolean)
		.join(path.delimiter);
	const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
		stdio: "inherit",
		env: { ...process.env, NODE_PATH: nodePath, PI_BTW_TEST_READY: "1" },
	});
	process.exit(result.status ?? 1);
}

ensurePiModulePath();

const sharedEvidence = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../lib/session-evidence.ts",
);
const sharedDirect = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../lib/direct-completion.ts",
);
if (!fs.existsSync(sharedEvidence) || !fs.existsSync(sharedDirect)) {
	console.error(
		"BLOCKED: shared modules missing " +
			`(${path.basename(sharedEvidence)}, ${path.basename(sharedDirect)}). ` +
			"Parent integration required before executable BTW tests.",
	);
	process.exit(2);
}

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");

const {
	answerBtw,
	boundBtwHistory,
	boundBtwState,
	buildBtwState,
	buildBtwUserPrompt,
	BtwChatOverlay,
	formatBtwUsage,
	default: btwExtension,
} = await import("../btw.ts");

type SessionEntry = import("@earendil-works/pi-coding-agent").SessionEntry;
const { visibleWidth } = await import("@earendil-works/pi-tui");

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function customEntry(
	id: string,
	customType: string,
	data: unknown,
	parentId: string | null = null,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		customType,
		data,
	} as SessionEntry;
}

function messageEntry(
	id: string,
	role: "user" | "assistant",
	text: string,
	extra: Record<string, unknown> = {},
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role,
			content: [{ type: "text", text }],
			timestamp: Date.now(),
			...(role === "assistant"
				? {
						api: "openai-responses",
						provider: "openai",
						model: "test",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						...extra,
					}
				: {}),
		},
	} as SessionEntry;
}

function testExtensionStateSummary(): void {
	const entries = [
		customEntry("todo-1", "todo", {
			todos: [{ id: 1, text: "ignore this custom entry", done: false }],
		}),
		customEntry("sub-1", "subagent-state", {
			run: {
				runId: "run-1",
				tasks: [{ index: 0, task: "inspect", status: "running" }],
			},
		}),
	];
	const state = buildBtwState(entries);
	assert(
		"BTW ignores todo entries while summarizing hidden session state",
		!state.includes("ignore this custom entry") &&
			!state.includes("Todos") &&
			state.includes("running: inspect"),
		state,
	);
	assert(
		"BTW state is capped for model context",
		boundBtwState("x".repeat(5_000), 4_000).length <= 4_000,
		boundBtwState("x".repeat(5_000), 4_000).length.toString(),
	);
}

function testBoundedFollowUpHistory(): void {
	const turns = Array.from({ length: 40 }, (_, index) => ({
		question: `question-${index}-${"q".repeat(200)}`,
		answer: `answer-${index}-${"a".repeat(200)}`,
	}));
	const bounded = boundBtwHistory(turns, 12_000);
	const omittedMatch = bounded.match(/\[(\d+) earlier Q&A turns omitted for input limit\]/);
	const omitted = omittedMatch ? Number(omittedMatch[1]) : 0;
	assert(
		"BTW bounds follow-up Q&A with an omission marker",
		bounded.length <= 12_000 &&
			omitted > 0 &&
			bounded.startsWith("[") &&
			!bounded.includes("Q1:") &&
			bounded.includes("Q40:") &&
			bounded.includes("A40:") &&
			!bounded.includes("question-5-") &&
			boundBtwHistory([{ question: "q".repeat(100), answer: "a".repeat(100) }], 7).length <= 7,
		JSON.stringify({
			length: bounded.length,
			omitted,
			head: bounded.slice(0, 120),
			tail: bounded.slice(-120),
		}),
	);
}

function testUntrustedPromptShape(): void {
	const prompt = buildBtwUserPrompt(
		"What is pending?",
		"USER: earlier work",
		"Subagents:\n- #1 running: inspect",
		"Q1: prior\nA1: reply",
	);
	assert(
		"BTW wraps evidence and history as untrusted data without tools or full session dump",
		prompt.includes("<session_evidence>") &&
			prompt.includes("<extension_state>") &&
			prompt.includes("<prior_qa>") &&
			prompt.includes("<btw_question>") &&
			prompt.includes("What is pending?") &&
			!prompt.includes("toolChoice") &&
			!prompt.includes("EXACT SYSTEM PROMPT"),
		prompt,
	);
}

async function testNoQuestionRequiredAndAutoSubmit(): Promise<void> {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let opened = 0;
	let autoSubmitted = 0;
	let guarded = 0;
	let emptyOpened = false;
	let active = false;

	btwExtension({
		on() {},
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: unknown) => Promise<void> },
		) {
			commands.set(name, command);
		},
	} as never);

	const command = commands.get("btw");
	if (!command) throw new Error("btw command was not registered");

	const makeCtx = (argsLabel: string) => {
		let leaf = "leaf-a";
		const branch = [
			messageEntry("u1", "user", `branch-${argsLabel}`),
			messageEntry("a1", "assistant", "done"),
		];
		return {
			mode: "tui",
			model: {
				id: "test-model",
				name: "Test",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://example.test",
				reasoning: true,
				input: ["text"],
				cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
				contextWindow: 100_000,
				maxTokens: 4_096,
			},
			modelRegistry: {
				// Fail auth quickly so auto-submit does not touch the network.
				getApiKeyAndHeaders: async () => ({ ok: false, error: "test-auth-skip" }),
				getRegisteredProviderConfig: () => undefined,
			},
			sessionManager: {
				getLeafId: () => leaf,
				getBranch: () => branch,
				getEntries: () => branch,
				getSessionId: () => "session-id",
				advance() {
					leaf = "leaf-b";
				},
			},
			ui: {
				notify(message: string) {
					if (message.includes("already open")) guarded++;
				},
				async custom(factory: any) {
					opened++;
					active = true;
					const overlay = factory(
						{ terminal: { rows: 24 }, requestRender() {} },
						{
							fg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						},
						{},
						() => {
							active = false;
						},
					);
					overlay.focused = true;
					if (argsLabel === "empty") {
						emptyOpened = overlay.getTurns().length === 0 && !overlay.isGenerating();
						overlay.close();
						return;
					}
					for (let attempt = 0; attempt < 20 && overlay.getTurns().length === 0; attempt++) {
						await new Promise((resolve) => setTimeout(resolve, 5));
					}
					if (overlay.getTurns().length >= 1) autoSubmitted++;
					overlay.close();
				},
			},
			appendEntry() {
				throw new Error("appendEntry must not be called");
			},
			sendMessage() {
				throw new Error("sendMessage must not be called");
			},
		};
	};

	await command.handler("", makeCtx("empty"));
	await command.handler("What is pending?", makeCtx("auto"));
	await command.handler("again", {
		...makeCtx("guard"),
		ui: {
			notify(message: string) {
				if (message.includes("sidechannel chat") && message.includes("already open")) guarded++;
			},
			async custom() {
				opened++;
			},
		},
	});
	let overlapGuarded = false;
	const overlapPi = {
		on() {},
		registerCommand(
			name: string,
			commandSpec: { handler: (args: string, ctx: unknown) => Promise<void> },
		) {
			commands.set(`overlap-${name}`, commandSpec);
		},
	};
	btwExtension(overlapPi as never);
	const overlapCommand = commands.get("overlap-btw");
	if (!overlapCommand) throw new Error("overlap command missing");
	const overlapCtx: any = {
		mode: "tui",
		model: makeCtx("overlap").model,
		modelRegistry: makeCtx("overlap").modelRegistry,
		sessionManager: makeCtx("overlap").sessionManager,
		ui: {
			notify(message: string) {
				if (message === "A BTW sidechannel chat is already open") overlapGuarded = true;
			},
			async custom(factory: any) {
				const overlay = factory(
					{ terminal: { rows: 20 }, requestRender() {} },
					{ fg: (_c: string, t: string) => t, bold: (t: string) => t },
					{},
					() => {},
				);
				await overlapCommand.handler("second", overlapCtx);
				overlay.close();
			},
		},
	};
	await overlapCommand.handler("first", overlapCtx);

	assert(
		"BTW opens without a question and auto-submits an initial question",
		emptyOpened && opened >= 2 && autoSubmitted >= 1 && overlapGuarded,
		JSON.stringify({ emptyOpened, opened, autoSubmitted, guarded, overlapGuarded, active }),
	);
}

async function testAnswerUsesDedicatedPromptWithoutToolsOrMutation(): Promise<void> {
	let captured: { context?: any; options?: any } = {};
	let mutations = 0;
	let evidenceSnapshots: string[] = [];
	const selectedModels: unknown[] = [];
	const model = {
		id: "test-model",
		name: "Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 100_000,
		maxTokens: 4_096,
	};
	const utilityModel = {
		id: "utility-fast",
		name: "Utility Fast",
		api: "openai-responses",
		provider: "utility",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0.1 },
		contextWindow: 100_000,
		maxTokens: 4_096,
	};
	let leaf: string | null = "leaf-1";
	let branch: SessionEntry[] = [
		messageEntry("u1", "user", "first snapshot evidence"),
		messageEntry("a1", "assistant", "worked"),
		customEntry("sub-1", "subagent-state", {
			run: { runId: "run-1", tasks: [{ index: 0, task: "inspect", status: "running" }] },
		}),
	];
	const ctx = {
		model,
		getSystemPrompt: () => "EXACT SYSTEM PROMPT",
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "secret",
				headers: { authorization: "x" },
				env: { TEST: "1" },
			}),
			getProviderAuth: async () => undefined,
			find: (provider: string, id: string) =>
				provider === utilityModel.provider && id === utilityModel.id ? utilityModel : undefined,
			getRegisteredProviderConfig: () => undefined,
		},
		sessionManager: {
			getLeafId: () => leaf,
			getBranch: () => branch,
			getEntries: () => branch,
			getSessionId: () => "session-cache-key",
		},
		appendEntry: () => {
			mutations++;
		},
		sendMessage: () => {
			mutations++;
		},
		sendUserMessage: () => {
			mutations++;
		},
	};

	const completeFn = async (requestModel: unknown, context: unknown, options: unknown) => {
		selectedModels.push(requestModel);
		captured = { context, options };
		const prompt = JSON.stringify(context);
		evidenceSnapshots.push(prompt);
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: `Answer for ${evidenceSnapshots.length}` }],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 900,
				cacheWrite: 0,
				totalTokens: 1_020,
				cost: { input: 0.0001, output: 0.0002, cacheRead: 0.00009, cacheWrite: 0, total: 0.00039 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
	};

	const first = await answerBtw(
		ctx as never,
		"What is pending?",
		[],
		new AbortController().signal,
		{ complete: completeFn as never },
	);

	branch = [
		messageEntry("u2", "user", "second snapshot evidence UNIQUE"),
		messageEntry("a2", "assistant", "more work"),
	];
	leaf = "leaf-2";
	const second = await answerBtw(
		ctx as never,
		`And now? ${"q".repeat(5_000)} ending`,
		[{ question: "What is pending?", answer: first.text }],
		new AbortController().signal,
		{ complete: completeFn as never },
	);

	const firstContext = captured.context;
	const secondPrompt = captured.context.messages[0].content[0].text as string;
	const boundedQuestion =
		secondPrompt.match(/<btw_question>\n([\s\S]*?)\n<\/btw_question>/)?.[1] ?? "";
	assert(
		"BTW uses a dedicated Q&A prompt with no tools, full system prompt, or session cache identity",
		typeof firstContext.systemPrompt === "string" &&
			firstContext.systemPrompt.includes("sidechannel") &&
			!firstContext.systemPrompt.includes("EXACT SYSTEM PROMPT") &&
			!("tools" in firstContext) &&
			captured.options.maxTokens === 500 &&
			captured.options.reasoningEffort === undefined &&
			captured.options.sessionId === undefined &&
			captured.options.toolChoice === undefined &&
			first.usage.effort === "off" &&
			mutations === 0,
		JSON.stringify({ context: firstContext, options: captured.options, first, mutations }),
	);
	assert(
		"BTW refreshes evidence each question and includes bounded prior Q&A",
		evidenceSnapshots[0]?.includes("first snapshot evidence") &&
			evidenceSnapshots[1]?.includes("second snapshot evidence UNIQUE") &&
			evidenceSnapshots[1]?.includes("What is pending?") &&
			evidenceSnapshots[1]?.includes("Answer for 1") &&
			boundedQuestion.length <= 4_000 &&
			boundedQuestion.endsWith("ending") &&
			second.text === "Answer for 2" &&
			formatBtwUsage(second.usage).includes("Cache hit"),
		JSON.stringify({ evidenceSnapshots, second }),
	);

	const utilityStore = {
		read: () => ({
			status: "configured",
			model: { provider: utilityModel.provider, id: utilityModel.id, thinkingLevel: "off" },
		}),
	} as any;
	await answerBtw(
		ctx as never,
		"Use the configured utility model",
		[],
		new AbortController().signal,
		{ complete: completeFn as never, store: utilityStore },
	);
	assert(
		"BTW uses the configured utility model",
		selectedModels.at(-1) === utilityModel,
		JSON.stringify({ selectedModels }),
	);
}

async function testCancellationCloseAndBoundedRendering(): Promise<void> {
	let leaf: string | null = "leaf-1";
	const branch: SessionEntry[] = [
		messageEntry("u1", "user", "hello"),
		messageEntry("a1", "assistant", "hi"),
	];
	let resolveAnswer: ((value: any) => void) | undefined;
	const ctx = {
		model: {
			id: "test-model",
			name: "Test",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 100_000,
			maxTokens: 4_096,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers: {}, env: {} }),
			getProviderAuth: async () => undefined,
			getRegisteredProviderConfig: () => undefined,
		},
		sessionManager: {
			getLeafId: () => leaf,
			getBranch: () => branch,
			getSessionId: () => "session",
		},
	};

	let closed = false;
	const overlay = new BtwChatOverlay(
		{ terminal: { rows: 20 }, requestRender() {} } as never,
		{
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		ctx as never,
		() => {
			closed = true;
		},
		"openai/test-model",
		(async (_model: any, _context: any, options: any) => {
			await new Promise((resolve, reject) => {
				resolveAnswer = resolve;
				options.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
					once: true,
				});
			});
			return {
				role: "assistant",
				content: [{ type: "text", text: "late" }],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		}) as never,
	);

	try {
		overlay.focused = true;
		const submitPromise = overlay.submitQuestion("first question");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert(
			"BTW prevents duplicate submit while generating",
			overlay.isGenerating(),
			"not generating",
		);
		void overlay.submitQuestion("duplicate");
		assert(
			"BTW keeps a single in-flight turn while generating",
			overlay.getTurns().length === 1,
			JSON.stringify(overlay.getTurns()),
		);

		const loading = overlay.render(52);
		assert(
			"BTW chat stays full-screen and width-bounded while generating",
			loading.length === 20 &&
				loading.every((line: string) => visibleWidth(line) === 52) &&
				loading.join("\n").includes("sidechannel chat") &&
				loading.join("\n").includes("Answering sidechannel question"),
			JSON.stringify(loading),
		);

		overlay.handleInput("\x1b");
		await submitPromise;
		assert(
			"Escape cancels an in-flight answer but keeps the chat open",
			!closed && !overlay.isGenerating() && overlay.getTurns()[0]?.cancelled === true,
			JSON.stringify({ closed, turns: overlay.getTurns() }),
		);

		const answered = new BtwChatOverlay(
			{ terminal: { rows: 20 }, requestRender() {} } as never,
			{ fg: (_c: string, t: string) => t, bold: (t: string) => t } as never,
			{
				...ctx,
				sessionManager: {
					getLeafId: () => leaf,
					getBranch: () => branch,
					getSessionId: () => "session",
				},
			} as never,
			() => {
				closed = true;
			},
			"openai/test-model",
			(async () => ({
				role: "assistant",
				content: [
					{
						type: "text",
						text:
							"## Done\n\n" + Array.from({ length: 40 }, (_, i) => `Answer line ${i}`).join("\n"),
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 90,
					cacheWrite: 0,
					totalTokens: 105,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			})) as never,
		);
		try {
			closed = false;
			leaf = "leaf-1";
			const answerPromise = answered.submitQuestion("What is done?");
			leaf = "leaf-advanced";
			await answerPromise;
			answered.handleInput("\x1b[H");
			const topLines = answered.render(52);
			answered.handleInput("\x1b[F");
			const endLines = answered.render(52);
			assert(
				"BTW renders stale snapshot guidance inside a bounded scrollable transcript",
				topLines.length === 20 &&
					endLines.length === 20 &&
					topLines.every((line: string) => visibleWidth(line) === 52) &&
					endLines.every((line: string) => visibleWidth(line) === 52) &&
					topLines.join("\n").includes("Session advanced") &&
					endLines.join("\n").includes("Answer line 39") &&
					answered.getTurns()[0]?.stale === true,
				JSON.stringify({ topLines, endLines, turn: answered.getTurns()[0] }),
			);
			answered.handleInput("\x1b");
			assert("Escape closes the idle sidechannel chat", closed, "overlay stayed open");
		} finally {
			answered.dispose();
		}

		closed = false;
		const closing = new BtwChatOverlay(
			{ terminal: { rows: 12 }, requestRender() {} } as never,
			{ fg: (_c: string, t: string) => t, bold: (t: string) => t } as never,
			ctx as never,
			() => {
				closed = true;
			},
		);
		try {
			closing.handleInput("\x03");
			assert("Ctrl+C closes the sidechannel chat", closed, "Ctrl+C did not close");
		} finally {
			closing.dispose();
		}
	} finally {
		resolveAnswer?.({
			role: "assistant",
			content: [{ type: "text", text: "unused" }],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		overlay.dispose();
	}
}

testExtensionStateSummary();
testBoundedFollowUpHistory();
testUntrustedPromptShape();
await testNoQuestionRequiredAndAutoSubmit();
await testAnswerUsesDedicatedPromptWithoutToolsOrMutation();
await testCancellationCloseAndBoundedRendering();
console.log("All BTW tests passed.");
