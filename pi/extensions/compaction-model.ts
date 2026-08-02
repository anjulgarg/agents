import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	compact as runCompaction,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export const COMPACTION_MODEL_ENTRY_TYPE = "compaction-model";
export const COMPACTION_MODEL_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const MAX_MODEL_COMPLETIONS = 100;

type SessionCustomEntry = {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
};

export interface CompactionModelState {
	provider: string;
	id: string;
	thinkingLevel: ModelThinkingLevel;
}

export interface ParsedCompactionModelCommand {
	provider: string;
	id: string;
	thinkingLevel?: ModelThinkingLevel;
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return (
		typeof value === "string" && (COMPACTION_MODEL_LEVELS as readonly string[]).includes(value)
	);
}

export function isCompactionModelState(value: unknown): value is CompactionModelState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<CompactionModelState>;
	return (
		typeof state.provider === "string" &&
		state.provider.length > 0 &&
		typeof state.id === "string" &&
		state.id.length > 0 &&
		isThinkingLevel(state.thinkingLevel)
	);
}

export function restoreCompactionModelState(
	entries: readonly SessionCustomEntry[],
): CompactionModelState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== COMPACTION_MODEL_ENTRY_TYPE) continue;
		if (isCompactionModelState(entry.data)) return entry.data;
		if (entry.data === null || (entry.data as { clear?: unknown } | undefined)?.clear === true) {
			return undefined;
		}
	}
	return undefined;
}

export function parseCompactionModelCommand(
	args: string,
): ParsedCompactionModelCommand | { clear: true } | undefined {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return undefined;
	if (tokens[0]?.toLowerCase() === "clear") {
		return tokens.length === 1 ? { clear: true } : undefined;
	}
	if (tokens.length > 2) return undefined;

	const reference = tokens[0]!;
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) return undefined;

	const thinkingLevel = tokens[1]?.toLowerCase();
	if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) return undefined;
	return {
		provider: reference.slice(0, separator),
		id: reference.slice(separator + 1),
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

export function formatCompactionModel(
	model: Pick<Model<Api>, "provider" | "id">,
	thinkingLevel: ModelThinkingLevel,
): string {
	return `${model.provider}/${model.id} ${thinkingLevel}`;
}

function modelReference(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function modelFromReference(
	models: readonly Model<Api>[],
	reference: string,
): Model<Api> | undefined {
	return models.find((model) => modelReference(model) === reference);
}

export function modelCompletions(
	models: readonly Model<Api>[],
	prefix: string,
	selected: CompactionModelState | undefined,
): AutocompleteItem[] | null {
	const hasSecondToken = /\s/.test(prefix);
	const tokens = prefix.trim().split(/\s+/).filter(Boolean);
	if (hasSecondToken) {
		const reference = tokens[0];
		const model = reference ? modelFromReference(models, reference) : undefined;
		if (!model) return null;
		const levelPrefix = tokens.slice(1).join(" ").toLowerCase();
		const levels = getSupportedThinkingLevels(model).filter((level) =>
			level.startsWith(levelPrefix),
		);
		if (levels.length === 0) return null;
		return levels.map((level) => ({
			value: `${reference} ${level}`,
			label: level,
			description:
				selected?.provider === model.provider &&
				selected.id === model.id &&
				selected.thinkingLevel === level
					? "current"
					: undefined,
		}));
	}

	const query = prefix.trim().toLowerCase();
	const sortedModels = [...models].sort((left, right) =>
		modelReference(left).localeCompare(modelReference(right)),
	);
	const items = sortedModels
		.filter((model) => !query || modelReference(model).toLowerCase().includes(query))
		.slice(0, MAX_MODEL_COMPLETIONS)
		.map((model) => {
			const reference = modelReference(model);
			const isCurrent = selected?.provider === model.provider && selected.id === model.id;
			return {
				value: reference,
				label: reference,
				description:
					[
						model.name !== model.id ? model.name : undefined,
						isCurrent ? `current · ${selected.thinkingLevel}` : undefined,
					]
						.filter(Boolean)
						.join(" · ") || undefined,
			};
		});

	if (!query || "clear".startsWith(query)) {
		items.push({
			value: "clear",
			label: "clear",
			description: "Use the active conversation model",
		});
	}
	return items.length > 0 ? items : null;
}

export function activeThinkingLevel(ctx: ExtensionContext): ModelThinkingLevel {
	if (!ctx.model) return "off";
	return clampThinkingLevel(ctx.model, ctx.thinkingLevel ?? "off");
}

function retrySettings(
	ctx: ExtensionContext,
): ReturnType<SettingsManager["getRetrySettings"]> | undefined {
	try {
		return SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		}).getRetrySettings();
	} catch {
		return undefined;
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export function formatFallbackNotice(
	configured: CompactionModelState,
	fallback: Pick<Model<Api>, "provider" | "id"> | undefined,
	fallbackThinkingLevel: ModelThinkingLevel,
): string {
	const requested = `${configured.provider}/${configured.id} ${configured.thinkingLevel}`;
	const fallbackText = fallback
		? formatCompactionModel(fallback, fallbackThinkingLevel)
		: "the active conversation model";
	return `Compaction model unavailable: ${requested}\nFalling back to ${fallbackText}`;
}

export default function compactionModelExtension(pi: ExtensionAPI): void {
	let configured: CompactionModelState | undefined;
	let modelRegistry: ExtensionContext["modelRegistry"] | undefined;
	let availableModels: Model<Api>[] = [];
	let lastFallbackKey: string | undefined;
	let lastCompactionModel: CompactionModelState | undefined;

	const refreshModels = (ctx: ExtensionContext): void => {
		modelRegistry = ctx.modelRegistry;
		try {
			availableModels = ctx.modelRegistry.getAvailable();
		} catch {
			availableModels = [];
		}
	};

	const configuredModel = (ctx: ExtensionContext): Model<Api> | undefined => {
		if (!configured) return undefined;
		// Resolve by identifier for every compaction. Model objects and auth
		// availability can change after a login, logout, reload, or catalog refresh.
		return ctx.modelRegistry.find(configured.provider, configured.id);
	};

	const activeCompactionModel = (ctx: ExtensionContext): CompactionModelState | undefined => {
		if (!ctx.model) return undefined;
		return {
			provider: ctx.model.provider,
			id: ctx.model.id,
			thinkingLevel: activeThinkingLevel(ctx),
		};
	};

	const notifyFallback = (ctx: ExtensionContext): void => {
		lastCompactionModel = activeCompactionModel(ctx);
		if (!configured) return;
		const fallback = ctx.model;
		const fallbackThinkingLevel = activeThinkingLevel(ctx);
		const key = `${configured.provider}/${configured.id} ${configured.thinkingLevel}|${
			fallback ? modelReference(fallback) : "none"
		}|${fallbackThinkingLevel}`;
		if (key === lastFallbackKey) return;
		lastFallbackKey = key;
		ctx.ui.notify(formatFallbackNotice(configured, fallback, fallbackThinkingLevel), "warning");
	};

	const markCompactionModelHealthy = (): void => {
		lastFallbackKey = undefined;
	};

	pi.registerCommand("compaction-model", {
		description: "Set the model and thinking level used for compaction",
		getArgumentCompletions: (prefix) => {
			let models = availableModels;
			try {
				models = modelRegistry?.getAvailable() ?? availableModels;
			} catch {
				// Keep the last successful catalog for autocomplete.
			}
			return modelCompletions(models, prefix, configured);
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			refreshModels(ctx);
			const parsed = parseCompactionModelCommand(args);
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /compaction-model provider/model [off|minimal|low|medium|high|xhigh|max]",
					"error",
				);
				return;
			}
			if ("clear" in parsed) {
				configured = undefined;
				lastFallbackKey = undefined;
				lastCompactionModel = undefined;
				pi.appendEntry(COMPACTION_MODEL_ENTRY_TYPE, { clear: true });
				ctx.ui.notify("Compaction model cleared. Using the active conversation model.", "info");
				return;
			}

			const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
			if (!model) {
				ctx.ui.notify(`Compaction model unavailable: ${parsed.provider}/${parsed.id}`, "error");
				return;
			}

			const supportedLevels = getSupportedThinkingLevels(model);
			const requestedLevel = parsed.thinkingLevel;
			if (requestedLevel !== undefined && !supportedLevels.includes(requestedLevel)) {
				ctx.ui.notify(
					`Unsupported thinking level: ${requestedLevel} for ${parsed.provider}/${parsed.id}`,
					"error",
				);
				return;
			}
			const thinkingLevel = clampThinkingLevel(model, requestedLevel ?? activeThinkingLevel(ctx));

			configured = {
				provider: parsed.provider,
				id: parsed.id,
				thinkingLevel,
			};
			lastFallbackKey = undefined;
			// Persist only identifiers and the requested level. The model is resolved
			// again when this session resumes and before each compaction.
			pi.appendEntry(COMPACTION_MODEL_ENTRY_TYPE, configured);
			ctx.ui.notify(
				`Compaction model set to ${formatCompactionModel(model, thinkingLevel)}`,
				"info",
			);
		},
	});

	const restore = (ctx: ExtensionContext): void => {
		refreshModels(ctx);
		configured = restoreCompactionModelState(
			ctx.sessionManager.getBranch() as SessionCustomEntry[],
		);
		lastFallbackKey = undefined;
		lastCompactionModel = undefined;
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("session_before_compact", async (event, ctx) => {
		lastCompactionModel = activeCompactionModel(ctx);
		if (!configured) return;

		const model = configuredModel(ctx);
		if (!model) {
			notifyFallback(ctx);
			return;
		}

		let auth: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
		try {
			auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		} catch {
			notifyFallback(ctx);
			return;
		}
		if (!auth.ok) {
			notifyFallback(ctx);
			return;
		}

		let provider: ReturnType<typeof ctx.modelRegistry.getProvider>;
		try {
			provider = ctx.modelRegistry.getProvider(model.provider);
		} catch {
			provider = undefined;
		}
		if (!provider) {
			notifyFallback(ctx);
			return;
		}

		lastCompactionModel = {
			provider: model.provider,
			id: model.id,
			thinkingLevel: clampThinkingLevel(model, configured.thinkingLevel),
		};

		try {
			const streamFn = (
				requestModel: Model<Api>,
				requestContext: Parameters<typeof provider.streamSimple>[1],
				options?: Parameters<typeof provider.streamSimple>[2],
			) => provider.streamSimple(requestModel, requestContext, options);
			const result = await runCompaction(
				event.preparation,
				model,
				auth.apiKey,
				auth.headers,
				event.customInstructions,
				event.signal,
				clampThinkingLevel(model, configured.thinkingLevel),
				streamFn,
				auth.env,
				retrySettings(ctx),
			);
			markCompactionModelHealthy();
			return { compaction: result };
		} catch (error) {
			if (event.signal.aborted || isAbortError(error)) return;
			// Returning no result deliberately hands the same preparation back to
			// core, which then uses the active conversation model and its existing
			// retry/auth path without changing the normal conversation model.
			notifyFallback(ctx);
			return;
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		const model = lastCompactionModel ?? activeCompactionModel(ctx);
		lastCompactionModel = undefined;
		if (!model) return;
		ctx.ui.notify(`Compaction model: ${formatCompactionModel(model, model.thinkingLevel)}`, "info");
	});
}
