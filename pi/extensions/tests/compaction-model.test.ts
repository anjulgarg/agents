import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	COMPACTION_DURATION_ENTRY_TYPE,
	COMPACTION_NOTICE_ENTRY_TYPE,
	COMPACTION_MODEL_ENTRY_TYPE,
	COMPACTION_TIMER_STATUS_KEY,
	activeThinkingLevel,
	createGlobalCompactionModelStore,
	formatCompactionDuration,
	formatFallbackNotice,
	modelCompletions,
	parseCompactionModelCommand,
	restoreCompactionModelState,
	type CompactionModelState,
	type CompactionModelStore,
} from "../compaction-model.ts";
import compactionModelExtension from "../compaction-model.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function storedModel(store: CompactionModelStore): CompactionModelState | null | undefined {
	const result = store.read();
	return result.status === "configured" ? result.model : undefined;
}

const targetModel = {
	provider: "deepseek",
	id: "deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	reasoning: true,
	thinkingLevelMap: { max: "max" },
} as any;
const fallbackModel = {
	provider: "openai-codex",
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	reasoning: true,
} as any;
const plainModel = {
	provider: "openai",
	id: "gpt-4.1-mini",
	name: "GPT-4.1 mini",
	reasoning: false,
} as any;
const models = [targetModel, fallbackModel, plainModel];

assert(
	"parses model identifiers and thinking levels",
	JSON.stringify(parseCompactionModelCommand("deepseek/deepseek-v4-flash MAX")) ===
		JSON.stringify({
			provider: "deepseek",
			id: "deepseek-v4-flash",
			thinkingLevel: "max",
		}),
	JSON.stringify(parseCompactionModelCommand("deepseek/deepseek-v4-flash MAX")),
);
assert(
	"parses clear as a separate command",
	JSON.stringify(parseCompactionModelCommand(" CLEAR ")) === JSON.stringify({ clear: true }),
	JSON.stringify(parseCompactionModelCommand(" CLEAR ")),
);
assert(
	"rejects malformed model commands",
	parseCompactionModelCommand("deepseek") === undefined &&
		parseCompactionModelCommand("deepseek/model invalid") === undefined &&
		parseCompactionModelCommand("clear extra") === undefined,
	"malformed commands were accepted",
);
assert(
	"formats compaction durations like tool durations",
	formatCompactionDuration(1_250) === "1.3s" && formatCompactionDuration(-10) === "0.0s",
	formatCompactionDuration(1_250),
);

const configuredState: CompactionModelState = {
	provider: targetModel.provider,
	id: targetModel.id,
	thinkingLevel: "max",
};
const globalStateDir = mkdtempSync(join(tmpdir(), "pi-compaction-model-"));
const globalStore = createGlobalCompactionModelStore(join(globalStateDir, "compaction-model.json"));
assert(
	"global store starts unset",
	globalStore.read().status === "missing",
	JSON.stringify(globalStore.read()),
);
globalStore.write(configuredState);
assert(
	"global store persists the selected model",
	storedModel(globalStore)?.provider === configuredState.provider &&
		storedModel(globalStore)?.id === configuredState.id &&
		storedModel(globalStore)?.thinkingLevel === configuredState.thinkingLevel,
	readFileSync(join(globalStateDir, "compaction-model.json"), "utf8"),
);
globalStore.write(null);
assert(
	"global store persists an explicit clear",
	storedModel(globalStore) === null,
	readFileSync(join(globalStateDir, "compaction-model.json"), "utf8"),
);
const branch = [
	{ type: "custom", customType: COMPACTION_MODEL_ENTRY_TYPE, data: configuredState },
	{ type: "custom", customType: "other", data: { ignored: true } },
];
assert(
	"restores the latest persisted selection even when the model is stale",
	restoreCompactionModelState(branch)?.id === targetModel.id &&
		restoreCompactionModelState(branch)?.thinkingLevel === "max",
	JSON.stringify(restoreCompactionModelState(branch)),
);
assert(
	"a persisted clear marker removes an older selection",
	restoreCompactionModelState([
		...branch,
		{ type: "custom", customType: COMPACTION_MODEL_ENTRY_TYPE, data: { clear: true } },
	]) === undefined,
	JSON.stringify(
		restoreCompactionModelState([
			...branch,
			{ type: "custom", customType: COMPACTION_MODEL_ENTRY_TYPE, data: { clear: true } },
		]),
	),
);

const completionModels = modelCompletions(models, "", configuredState) ?? [];
assert(
	"offers sorted model and clear completions",
	completionModels.map((item) => item.value).join(",") ===
		"deepseek/deepseek-v4-flash,openai-codex/gpt-5.6-sol,openai/gpt-4.1-mini,clear",
	JSON.stringify(completionModels),
);
const levelCompletions =
	modelCompletions(models, "deepseek/deepseek-v4-flash h", configuredState) ?? [];
assert(
	"offers only supported thinking levels for the selected model",
	levelCompletions.some((item) => item.value === "deepseek/deepseek-v4-flash high") &&
		!levelCompletions.some((item) => item.value.endsWith(" off")),
	JSON.stringify(levelCompletions),
);
const plainLevelCompletions = modelCompletions(models, "openai/gpt-4.1-mini ", undefined) ?? [];
assert(
	"offers off for a non-reasoning model",
	plainLevelCompletions.length === 1 &&
		plainLevelCompletions[0]?.value === "openai/gpt-4.1-mini off",
	JSON.stringify(plainLevelCompletions),
);

const baseContext = {
	model: fallbackModel,
	thinkingLevel: "high",
} as any;
assert(
	"clamps the active thinking level to the active model",
	activeThinkingLevel({ ...baseContext, model: plainModel } as any) === "off" &&
		activeThinkingLevel(baseContext) === "high",
	"active thinking level was not clamped",
);
assert(
	"formats the agreed fallback wording",
	formatFallbackNotice(configuredState, fallbackModel, "medium") ===
		"Compaction model unavailable: deepseek/deepseek-v4-flash max\nFalling back to openai-codex/gpt-5.6-sol medium",
	formatFallbackNotice(configuredState, fallbackModel, "medium"),
);
assert(
	"formats a fallback notice without an active model",
	formatFallbackNotice(configuredState, undefined, "off").endsWith(
		"Falling back to the active conversation model",
	),
	formatFallbackNotice(configuredState, undefined, "off"),
);

const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
const commands = new Map<string, any>();
const entries: any[] = [];
const notices: Array<{ message: string; type?: string }> = [];
let durationRenderer: any;
let noticeRenderer: any;
let available = [...models];
const authByProvider: Record<string, boolean> = {
	deepseek: true,
	"openai-codex": true,
	openai: false,
};
let streamShouldFail = false;
const calls: Array<{ provider: string; model: string; options: any }> = [];
const statusCalls: Array<{ key: string; text: string | undefined }> = [];
let fakeNow = 10_000;
let timerCallback: (() => void) | undefined;
let onStreamResult: (() => void) | undefined;
const timerOptions = {
	clock: () => fakeNow,
	setInterval: (callback: () => void) => {
		timerCallback = callback;
		return {} as any;
	},
	clearInterval: () => {
		timerCallback = undefined;
	},
};

const provider = {
	id: targetModel.provider,
	name: targetModel.name,
	streamSimple: (model: any, _context: any, options: any) => {
		calls.push({ provider: model.provider, model: model.id, options });
		return {
			result: async () => {
				if (streamShouldFail) throw new Error("provider unavailable");
				onStreamResult?.();
				return {
					stopReason: "stop",
					content: [{ type: "text", text: "structured summary" }],
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			},
		};
	},
};
const registry = {
	getAvailable: () => available,
	find: (providerId: string, modelId: string) =>
		models.find((model) => model.provider === providerId && model.id === modelId),
	getApiKeyAndHeaders: async (model: any) =>
		authByProvider[model.provider]
			? { ok: true, apiKey: "test-key", headers: { "x-test": "yes" }, env: { TEST: "1" } }
			: { ok: false, error: `No auth for ${model.provider}` },
	getProvider: (providerId: string) => (providerId === targetModel.provider ? provider : undefined),
};
const sessionManager = { getBranch: () => entries };
const context = {
	cwd: "/tmp/compaction-model-extension-test",
	model: fallbackModel,
	modelRegistry: registry,
	thinkingLevel: "medium",
	isProjectTrusted: () => false,
	waitForIdle: async () => undefined,
	sessionManager,
	ui: {
		notify: (message: string, type?: string) => notices.push({ message, type }),
		setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
		theme: { fg: (_color: string, text: string) => text },
	},
};

const futureStatePath = join(globalStateDir, "future-compaction-model.json");
const futureStateSource = `${JSON.stringify({ version: 2, model: configuredState }, null, 2)}\n`;
writeFileSync(futureStatePath, futureStateSource, "utf8");
const futureStore = createGlobalCompactionModelStore(futureStatePath);
const futureHandlers = new Map<string, Array<(event: any, ctx: any) => any>>();
const futureNotices: Array<{ message: string; type?: string }> = [];
compactionModelExtension(
	{
		registerCommand: () => undefined,
		registerEntryRenderer: () => undefined,
		on: (event: string, handler: (event: any, ctx: any) => any) => {
			const list = futureHandlers.get(event) ?? [];
			list.push(handler);
			futureHandlers.set(event, list);
		},
	} as any,
	futureStore,
	timerOptions,
);
await futureHandlers.get("session_start")?.[0]?.(
	{},
	{
		...context,
		sessionManager: { getBranch: () => branch },
		ui: {
			...context.ui,
			notify: (message: string, type?: string) => futureNotices.push({ message, type }),
		},
	},
);
assert(
	"preserves future-version state instead of overwriting it during legacy migration",
	futureStore.read().status === "invalid" &&
		readFileSync(futureStatePath, "utf8") === futureStateSource &&
		futureNotices.at(-1)?.type === "warning",
	JSON.stringify({ state: futureStore.read(), notices: futureNotices }),
);

compactionModelExtension(
	{
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerEntryRenderer: (type: string, renderer: any) => {
			if (type === COMPACTION_DURATION_ENTRY_TYPE) durationRenderer = renderer;
			if (type === COMPACTION_NOTICE_ENTRY_TYPE) noticeRenderer = renderer;
		},
		on: (event: string, handler: (event: any, ctx: any) => any) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data }),
	} as any,
	globalStore,
	timerOptions,
);

const command = commands.get("compaction-model");
assert(
	"registers the compaction-model command",
	Boolean(command),
	JSON.stringify([...commands.keys()]),
);
await handlers.get("session_start")?.[0]?.({}, context);
const refreshedCompletions = (await command.getArgumentCompletions?.("")) as any[] | null;
assert(
	"refreshes available models for command autocomplete",
	refreshedCompletions?.some((item) => item.value === "deepseek/deepseek-v4-flash") === true,
	JSON.stringify(refreshedCompletions),
);

await command.handler("deepseek/deepseek-v4-flash max", context);
assert(
	"persists the selected model globally without adding session state",
	storedModel(globalStore)?.provider === "deepseek" &&
		storedModel(globalStore)?.id === "deepseek-v4-flash" &&
		storedModel(globalStore)?.thinkingLevel === "max" &&
		entries.length === 0 &&
		notices.at(-1)?.message === "Compaction model set to deepseek/deepseek-v4-flash max" &&
		notices.at(-1)?.type === "info",
	JSON.stringify({ global: globalStore.read(), entries, notice: notices.at(-1) }),
);

const restoredHandlers = new Map<string, Array<(event: any, ctx: any) => any>>();
const restoredCommands = new Map<string, any>();
compactionModelExtension(
	{
		registerCommand: (name: string, command: any) => restoredCommands.set(name, command),
		registerEntryRenderer: () => undefined,
		on: (event: string, handler: (event: any, ctx: any) => any) => {
			const list = restoredHandlers.get(event) ?? [];
			list.push(handler);
			restoredHandlers.set(event, list);
		},
	} as any,
	globalStore,
);
await restoredHandlers.get("session_start")?.[0]?.(
	{},
	{
		...context,
		sessionManager: { getBranch: () => [] },
	},
);
const restoredLevels = await restoredCommands
	.get("compaction-model")
	.getArgumentCompletions("deepseek/deepseek-v4-flash m");
assert(
	"restores the global selection in a new session",
	restoredLevels?.some(
		(item: any) => item.value.endsWith(" max") && item.description === "current",
	) === true,
	JSON.stringify(restoredLevels),
);
notices.length = 0;
await command.handler("openai/gpt-4.1-mini", context);
assert(
	"defaults an implicit level to one supported by the selected model",
	storedModel(globalStore)?.id === "gpt-4.1-mini" &&
		storedModel(globalStore)?.thinkingLevel === "off" &&
		entries.length === 0,
	JSON.stringify({ global: storedModel(globalStore), entries }),
);
await command.handler("clear", context);
assert(
	"persists clearing the global configured model",
	storedModel(globalStore) === null &&
		entries.length === 0 &&
		notices.at(-1)?.message ===
			"Compaction model cleared globally. Using the active conversation model.",
	JSON.stringify({ global: globalStore.read(), entries, notice: notices.at(-1) }),
);
notices.length = 0;

const preparation = {
	firstKeptEntryId: "kept-entry",
	messagesToSummarize: [{ role: "user", content: "old context", timestamp: 1 }],
	turnPrefixMessages: [],
	isSplitTurn: false,
	tokensBefore: 50_000,
	fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
	settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 20_000 },
};
const compactEvent = (reason: "manual" | "threshold" | "overflow") => ({
	preparation,
	branchEntries: [],
	customInstructions: "keep decisions",
	reason,
	willRetry: reason === "overflow",
	signal: new AbortController().signal,
});

await command.handler("deepseek/deepseek-v4-flash high", context);
notices.length = 0;
for (const reason of ["manual", "threshold", "overflow"] as const) {
	let liveStatus: { key: string; text: string | undefined } | undefined;
	onStreamResult = () => {
		fakeNow += 1_250;
		timerCallback?.();
		liveStatus = statusCalls.at(-1);
		fakeNow += 750;
	};
	const result = await handlers.get("session_before_compact")?.[0]?.(compactEvent(reason), context);
	const timerClearedAfterRequest =
		timerCallback === undefined && statusCalls.at(-1)?.text === undefined;
	await handlers.get("session_compact")?.[0]?.(
		{ reason, compactionEntry: { tokensBefore: preparation.tokensBefore } },
		context,
	);
	assert(
		`routes ${reason} compaction through the configured model and cleans up its timer`,
		result?.compaction?.summary === "structured summary" &&
			calls.at(-1)?.model === targetModel.id &&
			calls.at(-1)?.options.reasoning === "high" &&
			liveStatus?.key === COMPACTION_TIMER_STATUS_KEY &&
			liveStatus.text === "Compacting 1.3s" &&
			timerClearedAfterRequest,
		JSON.stringify({ result, call: calls.at(-1), liveStatus, statusCalls, notices }),
	);
}
onStreamResult = undefined;
const compactionEntries = entries.splice(0);
const noticeEntries = compactionEntries.filter(
	(entry) => entry.customType === COMPACTION_NOTICE_ENTRY_TYPE,
);
const durationEntries = compactionEntries.filter(
	(entry) => entry.customType === COMPACTION_DURATION_ENTRY_TYPE,
);
const renderedNotice = noticeRenderer?.(
	{
		data: {
			reason: "threshold",
			tokensBefore: 239_000,
			model: "openai-codex/gpt-5.6-sol high",
		},
	},
	{},
	{ fg: (_color: string, text: string) => text },
);
const renderedDuration = durationRenderer?.(
	{ data: { durationMs: 2_000 } },
	{},
	{ fg: (_color: string, text: string) => text },
);
assert(
	"persists visible compaction receipts and final durations as permanent thread entries",
	noticeEntries.length === 3 &&
		noticeEntries.every(
			(entry) =>
				["manual", "threshold", "overflow"].includes(entry.data?.reason) &&
				entry.data?.model === "deepseek/deepseek-v4-flash high",
		) &&
		durationEntries.length === 3 &&
		durationEntries.every(
			(entry) =>
				entry.customType === COMPACTION_DURATION_ENTRY_TYPE && entry.data?.durationMs === 2_000,
		) &&
		typeof noticeRenderer === "function" &&
		renderedNotice
			?.render(200)
			.join(" ")
			.includes(
				"Context compacted · threshold · ≈239k tokens · using openai-codex/gpt-5.6-sol high",
			) &&
		typeof durationRenderer === "function" &&
		renderedDuration?.render(80).join(" ").includes("Compaction took 2.0s"),
	JSON.stringify({
		compactionEntries,
		noticeRenderer: typeof noticeRenderer,
		durationRenderer: typeof durationRenderer,
	}),
);
assert(
	"notifies with the configured model and final compaction duration",
	notices.length === 3 &&
		notices.every(
			(notice) =>
				notice.message === "Compaction model: deepseek/deepseek-v4-flash high · Took 2.0s" &&
				notice.type === "info",
		),
	JSON.stringify(notices),
);

await command.handler("deepseek/deepseek-v4-flash max", context);
authByProvider.deepseek = false;
const unavailableResult = await handlers.get("session_before_compact")?.[0]?.(
	compactEvent("manual"),
	context,
);
assert(
	"falls back when selected-model auth is unavailable",
	unavailableResult === undefined &&
		timerCallback === undefined &&
		notices.at(-1)?.message ===
			"Compaction model unavailable: deepseek/deepseek-v4-flash max\nFalling back to openai-codex/gpt-5.6-sol medium",
	JSON.stringify({ unavailableResult, notices }),
);
const noticeCount = notices.length;
await handlers.get("session_before_compact")?.[0]?.(compactEvent("manual"), context);
assert(
	"deduplicates repeated fallback notices",
	notices.length === noticeCount,
	JSON.stringify(notices),
);

authByProvider.deepseek = true;
await command.handler("deepseek/deepseek-v4-flash max", context);
streamShouldFail = true;
notices.length = 0;
const failedResult = await handlers.get("session_before_compact")?.[0]?.(
	compactEvent("threshold"),
	context,
);
assert(
	"falls back when the selected-model request fails",
	failedResult === undefined &&
		timerCallback === undefined &&
		statusCalls.at(-1)?.text === undefined &&
		notices.length === 1 &&
		notices[0]?.message ===
			"Compaction model unavailable: deepseek/deepseek-v4-flash max\nFalling back to openai-codex/gpt-5.6-sol medium",
	JSON.stringify({ failedResult, notices, calls: calls.length }),
);
streamShouldFail = false;

available = [fallbackModel];
const staleCompletions = await command.getArgumentCompletions?.("");
assert(
	"keeps autocomplete availability separate from persisted stale state",
	!staleCompletions?.some((item: any) => item.value === "deepseek/deepseek-v4-flash") &&
		staleCompletions?.some((item: any) => item.value === "openai-codex/gpt-5.6-sol"),
	JSON.stringify(staleCompletions),
);

rmSync(globalStateDir, { recursive: true, force: true });
