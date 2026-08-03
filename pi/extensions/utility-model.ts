import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	createGlobalUtilityModelStore,
	formatModelPreference,
	modelPreferenceCompletions,
	parseModelPreferenceCommand,
	type ModelPreferenceState,
	type ModelPreferenceStore,
} from "./model-preference.ts";

export { GLOBAL_UTILITY_MODEL_PATH, createGlobalUtilityModelStore } from "./model-preference.ts";

function restoreConfiguredModel(
	store: ModelPreferenceStore,
	ctx: ExtensionContext,
): ModelPreferenceState | undefined {
	try {
		const result = store.read();
		if (result.status === "configured") return result.model ?? undefined;
		if (result.status === "invalid") {
			ctx.ui.notify(
				"Global utility model state is invalid or from a newer version; preserving it unchanged.",
				"warning",
			);
		}
	} catch {
		ctx.ui.notify("Could not read global utility model state; using the active model.", "warning");
	}
	return undefined;
}

export default function utilityModelExtension(
	pi: ExtensionAPI,
	globalStore: ModelPreferenceStore = createGlobalUtilityModelStore(),
): void {
	let configured: ModelPreferenceState | undefined;
	let availableModels: Model<Api>[] = [];
	let modelRegistry: ExtensionContext["modelRegistry"] | undefined;

	const refreshModels = (ctx: ExtensionContext): void => {
		modelRegistry = ctx.modelRegistry;
		try {
			availableModels = ctx.modelRegistry.getAvailable();
		} catch {
			availableModels = [];
		}
	};

	const restore = (ctx: ExtensionContext): void => {
		refreshModels(ctx);
		configured = restoreConfiguredModel(globalStore, ctx);
	};

	pi.registerCommand("utility-model", {
		description: "Set the fast, low-cost model used for utility tasks",
		getArgumentCompletions: (prefix) => {
			let models = availableModels;
			try {
				models = modelRegistry?.getAvailable() ?? availableModels;
			} catch {
				// Keep the last successful catalog for autocomplete.
			}
			return modelPreferenceCompletions(models, prefix, configured);
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			refreshModels(ctx);
			const parsed = parseModelPreferenceCommand(args);
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /utility-model provider/model [off|minimal|low|medium|high|xhigh|max]",
					"error",
				);
				return;
			}
			if ("clear" in parsed) {
				try {
					globalStore.write(null);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not save global utility model: ${message}`, "error");
					return;
				}
				configured = undefined;
				ctx.ui.notify(
					"Utility model cleared globally. Using the active conversation model.",
					"info",
				);
				return;
			}

			const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
			if (!model) {
				ctx.ui.notify(`Utility model unavailable: ${parsed.provider}/${parsed.id}`, "error");
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
			const thinkingLevel = clampThinkingLevel(model, requestedLevel ?? ctx.thinkingLevel ?? "off");
			const nextConfigured: ModelPreferenceState = {
				provider: parsed.provider,
				id: parsed.id,
				thinkingLevel,
			};
			try {
				globalStore.write(nextConfigured);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save global utility model: ${message}`, "error");
				return;
			}
			configured = nextConfigured;
			ctx.ui.notify(`Utility model set to ${formatModelPreference(model, thinkingLevel)}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
}
