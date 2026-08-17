import {
	MAX_COMPLETION_OUTPUT_TOKENS,
	PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT,
	createGhostTextState,
	createIdleRequestMarker,
	createPromptAutocompleteProvider,
	default as promptAutocompleteExtension,
	enableIdlePromptSuggestions,
	insertTextAtCursor,
	isBuiltInCompletionInput,
	normalizePromptCompletion,
} from "../prompt-autocomplete.ts";
import {
	CURSOR_MARKER,
	visibleWidth,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const activeModel = {
	id: "active-model",
	name: "Active model",
	api: "openai-responses",
	provider: "active-provider",
	baseUrl: "https://active.example.test",
	reasoning: true,
	thinkingLevelMap: { off: "off", medium: "medium" },
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4_096,
};

const utilityModel = {
	id: "utility-model",
	name: "Utility model",
	api: "openai-responses",
	provider: "utility-provider",
	baseUrl: "https://utility.example.test",
	reasoning: true,
	thinkingLevelMap: { off: "off", high: "high" },
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4_096,
};

const models = [activeModel, utilityModel];
const modelRegistry = {
	find(provider: string, id: string) {
		return models.find((model) => model.provider === provider && model.id === id);
	},
	getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
	getProviderAuth: async () => undefined,
	getRegisteredProviderConfig: () => undefined,
};

const context = {
	model: activeModel,
	thinkingLevel: "medium",
	modelRegistry,
} as any;

const utilityStore = {
	read: () => ({
		status: "configured",
		model: { provider: utilityModel.provider, id: utilityModel.id, thinkingLevel: "high" },
	}),
};

function assistant(text: string, stopReason = "stop"): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "utility-provider",
		model: "utility-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function currentProvider(suggestions: AutocompleteSuggestions | null): {
	provider: AutocompleteProvider;
	getCalls: () => number;
	applyCalls: () => number;
} {
	let getCount = 0;
	let applyCount = 0;
	return {
		provider: {
			async getSuggestions() {
				getCount += 1;
				return suggestions;
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				applyCount += 1;
				return {
					lines: [...lines, `${item.value}:${prefix}`],
					cursorLine,
					cursorCol,
				};
			},
			shouldTriggerFileCompletion: () => false,
		},
		getCalls: () => getCount,
		applyCalls: () => applyCount,
	};
}

function dependencies(complete: (...args: any[]) => Promise<any>): any {
	return { complete, store: utilityStore };
}

async function testCurrentSuggestionsWin(): Promise<void> {
	const builtIn: AutocompleteItem = { value: "@file", label: "@file" };
	const current = currentProvider({ items: [builtIn], prefix: "@" });
	let modelCalls = 0;
	const provider = createPromptAutocompleteProvider(
		current.provider,
		context,
		dependencies(async () => {
			modelCalls += 1;
			return assistant("unused");
		}),
	);
	const result = await provider.getSuggestions(["read @f"], 0, 7, {
		signal: new AbortController().signal,
		force: true,
	});
	assert(
		"built-in suggestions take priority and remain unchanged",
		result?.items[0] === builtIn && result?.prefix === "@" && modelCalls === 0,
		JSON.stringify({ result, modelCalls }),
	);
}

async function testEligibilityGates(): Promise<void> {
	let modelCalls = 0;
	const provider = createPromptAutocompleteProvider(
		currentProvider(null).provider,
		context,
		dependencies(async () => {
			modelCalls += 1;
			return assistant("unused");
		}),
	);
	const signal = new AbortController().signal;
	const regular = await provider.getSuggestions(["ordinary prompt"], 0, 15, { signal });
	const whitespace = await provider.getSuggestions(["   "], 0, 3, { signal, force: true });
	const slash = await provider.getSuggestions(["/utility-model"], 0, 13, { signal, force: true });
	const ordinaryTrigger = provider.shouldTriggerFileCompletion?.(["ordinary prompt"], 0, 15);
	const slashTrigger = provider.shouldTriggerFileCompletion?.(["/utility-model"], 0, 13);
	assert(
		"non-forced, whitespace-only, and slash-command drafts do not call the model",
		regular === null && whitespace === null && slash === null && modelCalls === 0,
		JSON.stringify({ regular, whitespace, slash, modelCalls }),
	);
	assert(
		"Tab trigger gating remains entirely delegated to the current provider",
		ordinaryTrigger === false && slashTrigger === false,
		JSON.stringify({ ordinaryTrigger, slashTrigger }),
	);
	assert(
		"idle ghost generation excludes slash, attachment, issue, and path completion contexts",
		isBuiltInCompletionInput("/model") &&
			isBuiltInCompletionInput("read @src/ind") &&
			isBuiltInCompletionInput("fix #123") &&
			isBuiltInCompletionInput("open src/index") &&
			!isBuiltInCompletionInput("What should we work"),
		"built-in context classification",
	);
}

async function testTabRemainsBuiltIn(): Promise<void> {
	let modelCalls = 0;
	const provider = createPromptAutocompleteProvider(
		currentProvider(null).provider,
		context,
		dependencies(async () => {
			modelCalls += 1;
			return assistant("unused");
		}),
	);
	const result = await provider.getSuggestions(["Implement this now"], 0, 15, {
		signal: new AbortController().signal,
		force: true,
	});
	assert(
		"forced Tab completion remains owned by the current provider",
		result === null && modelCalls === 0,
		JSON.stringify({ result, modelCalls }),
	);
}

async function testIdleModelRequest(): Promise<void> {
	let captured: { model?: unknown; context?: any; options?: any } = {};
	let ghostValue: string | undefined;
	const marker = createIdleRequestMarker();
	const lines = ["What should we work"];
	const randomDropdown = currentProvider({
		items: [{ value: "workspace/", label: "workspace/" }],
		prefix: "work",
	});
	marker.mark(lines, 0, lines[0]!.length);
	const provider = createPromptAutocompleteProvider(randomDropdown.provider, context, {
		...dependencies(async (model, requestContext, options) => {
			captured = { model, context: requestContext, options };
			return assistant("on next");
		}),
		consumeIdleRequest: marker.consume,
		onIdleSuggestion: (_lines, _cursorLine, _cursorCol, value) => {
			ghostValue = value;
		},
	});
	const result = await provider.getSuggestions(lines, 0, lines[0]!.length, {
		signal: new AbortController().signal,
		force: false,
	});
	const second = await provider.getSuggestions(lines, 0, lines[0]!.length, {
		signal: new AbortController().signal,
		force: false,
	});
	const text = captured.context?.messages?.[0]?.content?.[0]?.text ?? "";
	assert(
		"a marked idle request produces a one-shot ghost suffix with bounded model options",
		result === null &&
			second?.items[0]?.value === "workspace/" &&
			randomDropdown.getCalls() === 1 &&
			ghostValue === " on next" &&
			captured.model === utilityModel &&
			captured.options?.maxTokens === MAX_COMPLETION_OUTPUT_TOKENS &&
			captured.options?.maxTokens <= 96 &&
			captured.options?.reasoning === "high" &&
			captured.context?.systemPrompt === PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT &&
			!("tools" in (captured.context ?? {})) &&
			text.includes("What should we work"),
		JSON.stringify({
			result,
			second,
			currentProviderCalls: randomDropdown.getCalls(),
			ghostValue,
			captured,
		}),
	);
}

async function testIdleRequestSnapshotsDraft(): Promise<void> {
	let releaseCurrent: (() => void) | undefined;
	let requestText = "";
	const lines = ["Initial prompt"];
	const marker = createIdleRequestMarker();
	marker.mark(lines, 0, lines[0]!.length);
	const current: AutocompleteProvider = {
		async getSuggestions() {
			await new Promise<void>((resolve) => {
				releaseCurrent = resolve;
			});
			return null;
		},
		applyCompletion: (nextLines, cursorLine, cursorCol) => ({
			lines: nextLines,
			cursorLine,
			cursorCol,
		}),
	};
	const provider = createPromptAutocompleteProvider(current, context, {
		...dependencies(async (_model, requestContext) => {
			requestText = requestContext.messages[0]?.content[0]?.text ?? "";
			return assistant("safely");
		}),
		consumeIdleRequest: marker.consume,
	});
	const pending = provider.getSuggestions(lines, 0, lines[0]!.length, {
		signal: new AbortController().signal,
		force: false,
	});
	lines[0] = "Mutated prompt";
	releaseCurrent?.();
	await pending;
	assert(
		"idle requests snapshot draft lines before awaiting existing providers",
		requestText.includes("Initial prompt") && !requestText.includes("Mutated prompt"),
		requestText,
	);
}

async function testIdleCancellation(): Promise<void> {
	const marker = createIdleRequestMarker();
	const lines = ["Cancel idle completion"];
	marker.mark(lines, 0, lines[0]!.length);
	let resolveStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	let requestSignal: AbortSignal | undefined;
	const provider = createPromptAutocompleteProvider(currentProvider(null).provider, context, {
		...dependencies(
			async (_model, _requestContext, options) =>
				new Promise((_resolve, reject) => {
					requestSignal = options.signal;
					resolveStarted?.();
					options.signal?.addEventListener(
						"abort",
						() => reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })),
						{ once: true },
					);
				}),
		),
		consumeIdleRequest: marker.consume,
	});
	const pending = provider.getSuggestions(lines, 0, lines[0]!.length, {
		signal: new AbortController().signal,
		force: false,
	});
	await started;
	marker.clear();
	const result = await pending;
	assert(
		"clearing an active idle marker aborts the in-flight model request",
		requestSignal?.aborted === true && result === null,
		JSON.stringify({ aborted: requestSignal?.aborted, result }),
	);
}

async function testFallbackModel(): Promise<void> {
	const selected: unknown[] = [];
	let ghostValue: string | undefined;
	const lines = ["Finish the task"];
	const marker = createIdleRequestMarker();
	marker.mark(lines, 0, lines[0]!.length);
	const provider = createPromptAutocompleteProvider(currentProvider(null).provider, context, {
		...dependencies(async (model) => {
			selected.push(model);
			if (model === utilityModel) throw new Error("preferred unavailable");
			return assistant("safely");
		}),
		consumeIdleRequest: marker.consume,
		onIdleSuggestion: (_lines, _cursorLine, _cursorCol, value) => {
			ghostValue = value;
		},
	});
	const result = await provider.getSuggestions(lines, 0, lines[0]!.length, {
		signal: new AbortController().signal,
		force: false,
	});
	assert(
		"preferred model failure falls back to the distinct active model",
		selected[0] === utilityModel &&
			selected[1] === activeModel &&
			result === null &&
			ghostValue === " safely",
		JSON.stringify({ selected, result, ghostValue }),
	);
}

async function testCancellation(): Promise<void> {
	const controller = new AbortController();
	const marker = createIdleRequestMarker();
	const lines = ["Cancel this"];
	marker.mark(lines, 0, lines[0]!.length);
	let rejectRequest: ((error: unknown) => void) | undefined;
	const provider = createPromptAutocompleteProvider(currentProvider(null).provider, context, {
		...dependencies(
			async (_model, _requestContext, options) =>
				new Promise((resolve, reject) => {
					rejectRequest = reject;
					options.signal?.addEventListener(
						"abort",
						() => reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })),
						{ once: true },
					);
					void resolve;
				}),
		),
		consumeIdleRequest: marker.consume,
	});
	const pending = provider.getSuggestions(lines, 0, lines[0]!.length, {
		signal: controller.signal,
		force: false,
	});
	controller.abort();
	rejectRequest?.(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
	const result = await pending;
	assert("cancellation produces no suggestions", result === null, JSON.stringify(result));
}

async function testOutputNormalization(): Promise<void> {
	const normalized = normalizePromptCompletion('```\n"continue\n\there"\n```', "Draft ", " next");
	const trailing = normalizePromptCompletion("continue", "Draft ", "next");
	const repeated = normalizePromptCompletion("Draft text", "Draft text", "");
	const repeatedAfter = normalizePromptCompletion("next", "Draft ", "next");
	const malformed = normalizePromptCompletion({ text: "not textual" }, "Draft", "");
	assert(
		"normalization removes wrappers, flattens lines, preserves boundaries, and rejects repeats",
		normalized === "continue here" &&
			trailing === "continue " &&
			repeated === undefined &&
			repeatedAfter === undefined &&
			malformed === undefined,
		JSON.stringify({ normalized, trailing, repeated, repeatedAfter, malformed }),
	);
}

async function testMalformedOutput(): Promise<void> {
	const outputs: unknown[] = [
		[{ type: "thinking", thinking: "no text" }],
		[{ type: "text", text: "Repeat this draft" }],
	];
	const results: Array<AutocompleteSuggestions | null> = [];
	for (const output of outputs) {
		const lines = ["Repeat this draft"];
		const marker = createIdleRequestMarker();
		marker.mark(lines, 0, lines[0]!.length);
		const provider = createPromptAutocompleteProvider(currentProvider(null).provider, context, {
			...dependencies(async () => ({ ...assistant("unused"), content: output })),
			consumeIdleRequest: marker.consume,
		});
		results.push(
			await provider.getSuggestions(lines, 0, lines[0]!.length, {
				signal: new AbortController().signal,
				force: false,
			}),
		);
	}
	assert(
		"malformed and repetitive model output is rejected",
		results.every((result) => result === null),
		JSON.stringify(results),
	);
}

async function testInsertionAndDelegation(): Promise<void> {
	const current = currentProvider(null);
	const provider = createPromptAutocompleteProvider(
		current.provider,
		context,
		dependencies(async () => assistant("unused")),
	);
	const delegatedItem: AutocompleteItem = { value: "builtin", label: "builtin" };
	const delegated = provider.applyCompletion(["x"], 0, 1, delegatedItem, "x");
	const pure = insertTextAtCursor(["left right"], 0, 4, " +");
	assert(
		"pure insertion uses the exact cursor and preserves following text",
		pure.lines[0] === "left + right" && pure.cursorCol === 6,
		JSON.stringify({ pure }),
	);
	assert(
		"all provider completion items delegate to Pi's current provider",
		current.applyCalls() === 1 && delegated.lines[0] === "x" && delegated.lines[1] === "builtin:x",
		JSON.stringify({ delegated, applyCalls: current.applyCalls() }),
	);
}

async function testIdleEditorDebounce(): Promise<void> {
	let text = "Implement";
	let triggerCalls = 0;
	let tabCalls = 0;
	const editor = {
		focused: true,
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
		handleInput(data: string) {
			if (data === "\x1b[C") text += " moved";
			else if (data === "\t") tabCalls += 1;
			else text += data;
		},
		insertTextAtCursor(value: string) {
			text += value;
		},
		getLines: () => [text],
		getCursor: () => ({ line: 0, col: text.length }),
		isShowingAutocomplete: () => false,
		tryTriggerAutocomplete: () => {
			triggerCalls += 1;
		},
		render: (width: number) => [
			`${CURSOR_MARKER}\x1b[7m \x1b[0m${" ".repeat(Math.max(0, width - 1))}`,
		],
		invalidate: () => undefined,
	} as any;
	const keybindings = {
		matches: (data: string, action: string) =>
			(action === "tui.editor.cursorRight" && data === "\x1b[C") ||
			(action === "tui.input.tab" && data === "\t") ||
			(action === "tui.select.confirm" && data === "\r"),
	};
	const marker = createIdleRequestMarker();
	const ghostText = createGhostTextState();
	const dispose = enableIdlePromptSuggestions(
		editor,
		keybindings as any,
		marker,
		ghostText,
		(value) => value,
		5,
	);

	editor.handleInput(" ");
	editor.handleInput("a");
	editor.handleInput("b");
	await new Promise((resolve) => setTimeout(resolve, 20));
	const lines = editor.getLines();
	const cursor = editor.getCursor();
	const marked = marker.consume(lines, cursor.line, cursor.col);
	assert(
		"idle editor changes debounce into one autocomplete request for the latest draft",
		triggerCalls === 1 && Boolean(marked),
		JSON.stringify({ triggerCalls, marked: Boolean(marked), text }),
	);

	editor.handleInput("c");
	assert(
		"editing after an idle request aborts its model signal",
		marked?.aborted === true,
		JSON.stringify({ aborted: marked?.aborted, text }),
	);

	let currentLines = editor.getLines();
	let currentCursor = editor.getCursor();
	ghostText.set(currentLines, currentCursor.line, currentCursor.col, " on next");
	const rendered = editor.render(40)[0] ?? "";
	assert(
		"ghost text renders inline at the end cursor without exceeding editor width",
		rendered.includes("on next") && visibleWidth(rendered) === 40,
		JSON.stringify({ rendered, width: visibleWidth(rendered) }),
	);

	editor.handleInput("\x1b[C");
	assert(
		"Right Arrow accepts the entire ghost suffix before normal cursor movement",
		text.endsWith(" on next") && !text.endsWith(" moved"),
		JSON.stringify({ text }),
	);

	currentLines = editor.getLines();
	currentCursor = editor.getCursor();
	ghostText.set(currentLines, currentCursor.line, currentCursor.col, " ignored ghost");
	marker.mark(currentLines, currentCursor.line, currentCursor.col);
	editor.handleInput("\t");
	const markerAfterTab = marker.consume(currentLines, currentCursor.line, currentCursor.col);
	assert(
		"Tab delegates to the existing editor and clears queued idle model work",
		tabCalls === 1 &&
			!text.endsWith(" ignored ghost") &&
			markerAfterTab === undefined &&
			ghostText.get(currentLines, currentCursor.line, currentCursor.col) === undefined,
		JSON.stringify({ text, tabCalls, markerAfterTab: Boolean(markerAfterTab) }),
	);

	currentLines = editor.getLines();
	currentCursor = editor.getCursor();
	ghostText.set(currentLines, currentCursor.line, currentCursor.col, " stale replacement");
	editor.setText("Replaced prompt");
	assert(
		"programmatic text replacement clears stale ghost state",
		ghostText.get(currentLines, currentCursor.line, currentCursor.col) === undefined,
		JSON.stringify({ text }),
	);

	currentLines = editor.getLines();
	currentCursor = editor.getCursor();
	ghostText.set(currentLines, currentCursor.line, currentCursor.col, " stale insertion");
	editor.insertTextAtCursor(" directly");
	assert(
		"programmatic insertion clears stale ghost state",
		ghostText.get(currentLines, currentCursor.line, currentCursor.col) === undefined,
		JSON.stringify({ text }),
	);

	editor.handleInput("d");
	editor.focused = false;
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert(
		"focus loss cancels pending hidden-editor suggestions",
		triggerCalls === 1,
		JSON.stringify({ triggerCalls, text }),
	);

	dispose();
}

async function testRegistration(): Promise<void> {
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
	let registrations = 0;
	let editorRegistrations = 0;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers.set(event, handler);
		},
	};
	promptAutocompleteExtension(
		pi as any,
		dependencies(async () => assistant("unused")),
	);
	const handler = handlers.get("session_start");
	if (!handler) throw new Error("session_start handler missing");
	const nonTuiContext = {
		mode: "rpc",
		...context,
		ui: { addAutocompleteProvider: () => registrations++ },
	};
	await handler({}, nonTuiContext);
	const tuiContext = {
		mode: "tui",
		...context,
		ui: {
			addAutocompleteProvider: () => registrations++,
			getEditorComponent: () => () => ({}) as any,
			setEditorComponent: () => editorRegistrations++,
		},
	};
	await handler({}, tuiContext);
	await handler({}, tuiContext);
	assert(
		"non-TUI sessions do not register and repeated session starts stay idempotent",
		registrations === 1 && editorRegistrations === 1,
		JSON.stringify({ registrations, editorRegistrations }),
	);
}

await testCurrentSuggestionsWin();
await testEligibilityGates();
await testTabRemainsBuiltIn();
await testIdleModelRequest();
await testIdleRequestSnapshotsDraft();
await testIdleCancellation();
await testFallbackModel();
await testCancellation();
await testOutputNormalization();
await testMalformedOutput();
await testInsertionAndDelegation();
await testIdleEditorDebounce();
await testRegistration();
console.log("All prompt-autocomplete tests passed.");
