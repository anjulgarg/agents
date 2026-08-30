import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	clampThinkingLevel,
	createAssistantMessageEventStream,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { join } from "node:path";

import {
	compact as runCompaction,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
	activeModelThinkingLevel,
	createModelPreferenceStore,
	formatModelPreference,
	isModelPreferenceState,
	modelPreferenceCompletions,
	MODEL_PREFERENCE_LEVELS,
	parseModelPreferenceCommand,
	type ModelPreferenceState,
	type ModelPreferenceStore,
	type ModelPreferenceStoreReadResult,
	type ParsedModelPreferenceCommand,
} from "./model-preference.ts";

export const COMPACTION_MODEL_ENTRY_TYPE = "compaction-model";
export const GLOBAL_COMPACTION_MODEL_PATH = join(getAgentDir(), "state", "compaction-model.json");
export const COMPACTION_MODEL_LEVELS = MODEL_PREFERENCE_LEVELS;
export const COMPACTION_TIMER_STATUS_KEY = "compaction-timer";
export const COMPACTION_TIMER_INTERVAL_MS = 250;
export const COMPACTION_DURATION_ENTRY_TYPE = "compaction-duration";
export const COMPACTION_NOTICE_ENTRY_TYPE = "compaction-notice";

export interface CompactionNoticeEntry {
	readonly reason: string;
	readonly tokensBefore?: number;
	readonly model?: string;
}

type CompactionTimerHandle = ReturnType<typeof setInterval>;

export type CompactionClock = () => number;

export interface CompactionModelExtensionOptions {
	clock?: CompactionClock;
	setInterval?: (callback: () => void, intervalMs: number) => CompactionTimerHandle;
	clearInterval?: (timer: CompactionTimerHandle) => void;
}

export function formatCompactionDuration(durationMs: number): string {
	return `${(Math.max(0, durationMs) / 1000).toFixed(1)}s`;
}

interface CompactionDurationEntry {
	durationMs: number;
}

type SessionCustomEntry = {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
};

export type CompactionModelState = ModelPreferenceState;
export type ParsedCompactionModelCommand = ParsedModelPreferenceCommand;
export type CompactionModelStoreReadResult = ModelPreferenceStoreReadResult;
export type CompactionModelStore = ModelPreferenceStore;

export function createGlobalCompactionModelStore(
	path = GLOBAL_COMPACTION_MODEL_PATH,
): CompactionModelStore {
	return createModelPreferenceStore(path);
}

export const isCompactionModelState = isModelPreferenceState;

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

export const parseCompactionModelCommand = parseModelPreferenceCommand;
export const formatCompactionModel = formatModelPreference;
export const modelCompletions = modelPreferenceCompletions;
export const activeThinkingLevel = activeModelThinkingLevel;

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

export function safeCompactionFailureReason(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const sanitized = raw
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
		.replace(
			/((?:api[-_]?key|token|authorization|cookie|secret|credential)\s*[:=]\s*)[^\s,;&]+/gi,
			"$1[REDACTED]",
		)
		.replace(
			/([?&](?:token|api[-_]?key|password|secret|signature|authorization)=)[^&\s]+/gi,
			"$1[REDACTED]",
		)
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const bounded = sanitized || "unknown failure";
	return bounded.length > 300 ? `${bounded.slice(0, 297)}...` : bounded;
}

export function formatFallbackNotice(
	configured: CompactionModelState,
	fallback: Pick<Model<Api>, "provider" | "id"> | undefined,
	fallbackThinkingLevel: ModelThinkingLevel,
	reason?: string,
): string {
	const requested = `${configured.provider}/${configured.id} ${configured.thinkingLevel}`;
	const fallbackText = fallback
		? formatCompactionModel(fallback, fallbackThinkingLevel)
		: "the active conversation model";
	const reasonText = reason ? `\nReason: ${safeCompactionFailureReason(reason)}` : "";
	return `Compaction model unavailable: ${requested}${reasonText}\nFalling back to ${fallbackText}`;
}

export default function compactionModelExtension(
	pi: ExtensionAPI,
	globalStore: CompactionModelStore = createGlobalCompactionModelStore(),
	options: CompactionModelExtensionOptions = {},
): void {
	const clock = options.clock ?? (() => performance.now());
	const scheduleTimer =
		options.setInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
	const cancelTimer = options.clearInterval ?? ((timer) => clearInterval(timer));
	let compactionStartedAt: number | undefined;
	let compactionTimer: CompactionTimerHandle | undefined;

	const setCompactionStatus = (ctx: ExtensionContext): void => {
		if (compactionStartedAt === undefined) return;
		const elapsed = formatCompactionDuration(clock() - compactionStartedAt);
		ctx.ui.setStatus(
			COMPACTION_TIMER_STATUS_KEY,
			ctx.ui.theme.fg("accent", `Compacting ${elapsed}`),
		);
	};

	const stopCompactionTimer = (ctx: ExtensionContext): number | undefined => {
		if (compactionTimer !== undefined) {
			cancelTimer(compactionTimer);
			compactionTimer = undefined;
		}
		const startedAt = compactionStartedAt;
		compactionStartedAt = undefined;
		ctx.ui.setStatus(COMPACTION_TIMER_STATUS_KEY, undefined);
		return startedAt === undefined ? undefined : Math.max(0, clock() - startedAt);
	};

	const startCompactionTimer = (event: { signal: AbortSignal }, ctx: ExtensionContext): void => {
		if (compactionStartedAt === undefined) {
			compactionStartedAt = clock();
			compactionTimer = scheduleTimer(() => setCompactionStatus(ctx), COMPACTION_TIMER_INTERVAL_MS);
		}
		setCompactionStatus(ctx);
		event.signal.addEventListener("abort", () => stopCompactionTimer(ctx), { once: true });
	};
	let configured: CompactionModelState | undefined;
	let modelRegistry: ExtensionContext["modelRegistry"] | undefined;
	let availableModels: Model<Api>[] = [];
	let lastFallbackKey: string | undefined;
	let lastCompactionModel: CompactionModelState | undefined;
	let lastCompactionDuration: number | undefined;

	pi.registerEntryRenderer<CompactionNoticeEntry>(
		COMPACTION_NOTICE_ENTRY_TYPE,
		(entry, _options, theme) => {
			const reason = entry.data?.reason;
			if (typeof reason !== "string") return undefined;
			const tokensBefore = entry.data?.tokensBefore;
			const tokenText =
				typeof tokensBefore === "number" && Number.isFinite(tokensBefore)
					? ` · ≈${Math.round(tokensBefore / 1_000)}k tokens`
					: "";
			const modelText = typeof entry.data?.model === "string" ? ` · using ${entry.data.model}` : "";
			return new Text(
				theme.fg("muted", `Context compacted · ${reason}${tokenText}${modelText}`),
				1,
				0,
			);
		},
	);
	pi.registerEntryRenderer<CompactionDurationEntry>(
		COMPACTION_DURATION_ENTRY_TYPE,
		(entry, _options, theme) => {
			const durationMs = entry.data?.durationMs;
			if (typeof durationMs !== "number") return undefined;
			return new Text(
				theme.fg("muted", `Compaction took ${formatCompactionDuration(durationMs)}`),
				1,
				0,
			);
		},
	);

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

	const notifyFallback = (ctx: ExtensionContext, reason: string): void => {
		lastCompactionModel = activeCompactionModel(ctx);
		if (!configured) return;
		const fallback = ctx.model;
		const fallbackThinkingLevel = activeThinkingLevel(ctx);
		const safeReason = safeCompactionFailureReason(reason);
		const key = `${configured.provider}/${configured.id} ${configured.thinkingLevel}|${
			fallback ? `${fallback.provider}/${fallback.id}` : "none"
		}|${fallbackThinkingLevel}|${safeReason}`;
		if (key === lastFallbackKey) return;
		lastFallbackKey = key;
		ctx.ui.notify(
			formatFallbackNotice(configured, fallback, fallbackThinkingLevel, safeReason),
			"warning",
		);
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
				try {
					globalStore.write(null);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not save global compaction model: ${message}`, "error");
					return;
				}
				configured = undefined;
				lastFallbackKey = undefined;
				lastCompactionModel = undefined;
				ctx.ui.notify(
					"Compaction model cleared globally. Using the active conversation model.",
					"info",
				);
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

			const nextConfigured: CompactionModelState = {
				provider: parsed.provider,
				id: parsed.id,
				thinkingLevel,
			};
			try {
				globalStore.write(nextConfigured);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save global compaction model: ${message}`, "error");
				return;
			}
			configured = nextConfigured;
			lastFallbackKey = undefined;
			ctx.ui.notify(
				`Compaction model set to ${formatCompactionModel(model, thinkingLevel)}`,
				"info",
			);
		},
	});

	const restore = (ctx: ExtensionContext): void => {
		refreshModels(ctx);
		let globalState: CompactionModelStoreReadResult;
		try {
			globalState = globalStore.read();
		} catch {
			globalState = { status: "invalid" };
		}

		if (globalState.status === "configured") {
			configured = globalState.model ?? undefined;
		} else if (globalState.status === "missing") {
			// Migrate selections written by older versions only when no global
			// state exists. Never overwrite malformed or newer-version state.
			configured = restoreCompactionModelState(
				ctx.sessionManager.getBranch() as SessionCustomEntry[],
			);
			if (configured) {
				try {
					globalStore.write(configured);
				} catch {
					// Keep the legacy session fallback if global migration is unavailable.
				}
			}
		} else {
			configured = undefined;
			ctx.ui.notify(
				"Global compaction model state is invalid or from a newer version; preserving it unchanged.",
				"warning",
			);
		}
		lastFallbackKey = undefined;
		lastCompactionModel = undefined;
		lastCompactionDuration = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stopCompactionTimer(ctx);
		restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		stopCompactionTimer(ctx);
		restore(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopCompactionTimer(ctx);
	});
	pi.on("session_before_compact", async (event, ctx) => {
		lastCompactionModel = activeCompactionModel(ctx);
		lastCompactionDuration = undefined;
		if (!configured) return;

		const model = configuredModel(ctx);
		if (!model) {
			notifyFallback(ctx, "model not found in the current registry");
			return;
		}

		let auth: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
		try {
			auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		} catch (error) {
			notifyFallback(ctx, `authentication lookup failed: ${safeCompactionFailureReason(error)}`);
			return;
		}
		if (!auth.ok) {
			notifyFallback(ctx, `authentication unavailable: ${auth.error}`);
			return;
		}

		let provider: ReturnType<typeof ctx.modelRegistry.getProvider>;
		try {
			provider = ctx.modelRegistry.getProvider(model.provider);
		} catch (error) {
			notifyFallback(ctx, `provider lookup failed: ${safeCompactionFailureReason(error)}`);
			return;
		}
		if (!provider) {
			notifyFallback(ctx, `provider ${model.provider} is not registered`);
			return;
		}

		lastCompactionModel = {
			provider: model.provider,
			id: model.id,
			thinkingLevel: clampThinkingLevel(model, configured.thinkingLevel),
		};

		startCompactionTimer(event, ctx);
		try {
			const streamFn: StreamFn = async (requestModel, requestContext, requestOptions) => {
				const response = await ctx.modelRegistry.complete(
					requestModel,
					requestContext,
					requestOptions,
				);
				const stream = createAssistantMessageEventStream();
				stream.end(response);
				return stream;
			};
			const result = await runCompaction(
				event.preparation,
				model,
				undefined,
				undefined,
				event.customInstructions,
				event.signal,
				clampThinkingLevel(model, configured.thinkingLevel),
				streamFn,
				undefined,
				retrySettings(ctx),
			);
			lastCompactionDuration = stopCompactionTimer(ctx);
			markCompactionModelHealthy();
			return { compaction: result };
		} catch (error) {
			stopCompactionTimer(ctx);
			if (event.signal.aborted || isAbortError(error)) return;
			// Returning no result deliberately hands the same preparation back to
			// core, which then uses the active conversation model and its existing
			// retry/auth path without changing the normal conversation model.
			notifyFallback(ctx, `compaction request failed: ${safeCompactionFailureReason(error)}`);
			return;
		}
	});

	pi.on("session_compact_failed", (_event, ctx) => {
		stopCompactionTimer(ctx);
		lastCompactionModel = undefined;
		lastCompactionDuration = undefined;
	});

	pi.on("session_compact", (event, ctx) => {
		const duration = lastCompactionDuration ?? stopCompactionTimer(ctx);
		const model = lastCompactionModel ?? activeCompactionModel(ctx);
		const tokensBefore = event.compactionEntry?.tokensBefore;
		pi.appendEntry<CompactionNoticeEntry>(COMPACTION_NOTICE_ENTRY_TYPE, {
			reason: event.reason,
			...(typeof tokensBefore === "number" ? { tokensBefore } : {}),
			...(model ? { model: formatCompactionModel(model, model.thinkingLevel) } : {}),
		});
		lastCompactionModel = undefined;
		lastCompactionDuration = undefined;
		if (duration !== undefined) {
			pi.appendEntry<CompactionDurationEntry>(COMPACTION_DURATION_ENTRY_TYPE, {
				durationMs: duration,
			});
		}
		if (!model) {
			if (duration !== undefined)
				ctx.ui.notify(`Compaction took ${formatCompactionDuration(duration)}`, "info");
			return;
		}
		const durationText =
			duration === undefined ? "" : ` · Took ${formatCompactionDuration(duration)}`;
		ctx.ui.notify(
			`Compaction model: ${formatCompactionModel(model, model.thinkingLevel)}${durationText}`,
			"info",
		);
	});
}
