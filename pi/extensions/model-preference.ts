import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export const MODEL_PREFERENCE_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
export const GLOBAL_UTILITY_MODEL_PATH = join(getAgentDir(), "state", "utility-model.json");

const MAX_MODEL_COMPLETIONS = 100;

export interface ModelPreferenceState {
	provider: string;
	id: string;
	thinkingLevel: ModelThinkingLevel;
}

export interface ParsedModelPreferenceCommand {
	provider: string;
	id: string;
	thinkingLevel?: ModelThinkingLevel;
}

export type ModelPreferenceStoreReadResult =
	| { status: "configured"; model: ModelPreferenceState | null }
	| { status: "missing" }
	| { status: "invalid" };

export interface ModelPreferenceStore {
	read(): ModelPreferenceStoreReadResult;
	write(state: ModelPreferenceState | null): void;
}

interface PersistedModelPreference {
	version: 1;
	model: ModelPreferenceState | null;
}

export interface ModelPreferenceChoice {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	source: "configured" | "active";
}

export interface ModelPreferenceResolution {
	configured?: ModelPreferenceState;
	preferred?: ModelPreferenceChoice;
	fallback?: ModelPreferenceChoice;
}

function isFileNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return (
		typeof value === "string" && (MODEL_PREFERENCE_LEVELS as readonly string[]).includes(value)
	);
}

export function isModelPreferenceState(value: unknown): value is ModelPreferenceState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<ModelPreferenceState>;
	return (
		typeof state.provider === "string" &&
		state.provider.length > 0 &&
		typeof state.id === "string" &&
		state.id.length > 0 &&
		isThinkingLevel(state.thinkingLevel)
	);
}

export function createModelPreferenceStore(path: string): ModelPreferenceStore {
	return {
		read(): ModelPreferenceStoreReadResult {
			let source: string;
			try {
				source = readFileSync(path, "utf8");
			} catch (error) {
				return isFileNotFoundError(error) ? { status: "missing" } : { status: "invalid" };
			}

			try {
				const persisted = JSON.parse(source) as Partial<PersistedModelPreference>;
				if (persisted.version !== 1 || !("model" in persisted)) return { status: "invalid" };
				if (persisted.model === null) return { status: "configured", model: null };
				return isModelPreferenceState(persisted.model)
					? { status: "configured", model: persisted.model }
					: { status: "invalid" };
			} catch {
				return { status: "invalid" };
			}
		},
		write(state: ModelPreferenceState | null): void {
			mkdirSync(dirname(path), { recursive: true });
			const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
			try {
				writeFileSync(
					temporary,
					`${JSON.stringify({ version: 1, model: state } satisfies PersistedModelPreference, null, 2)}\n`,
					{ encoding: "utf8", mode: 0o600 },
				);
				renameSync(temporary, path);
			} finally {
				rmSync(temporary, { force: true });
			}
		},
	};
}

export function createGlobalUtilityModelStore(
	path = GLOBAL_UTILITY_MODEL_PATH,
): ModelPreferenceStore {
	return createModelPreferenceStore(path);
}

export function parseModelPreferenceCommand(
	args: string,
): ParsedModelPreferenceCommand | { clear: true } | undefined {
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

function modelReference(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function modelFromReference(
	models: readonly Model<Api>[],
	reference: string,
): Model<Api> | undefined {
	return models.find((model) => modelReference(model) === reference);
}

export function formatModelPreference(
	model: Pick<Model<Api>, "provider" | "id">,
	thinkingLevel: ModelThinkingLevel,
): string {
	return `${model.provider}/${model.id} ${thinkingLevel}`;
}

export function modelPreferenceCompletions(
	models: readonly Model<Api>[],
	prefix: string,
	selected: ModelPreferenceState | undefined,
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

export function activeModelThinkingLevel(ctx: ExtensionContext): ModelThinkingLevel {
	if (!ctx.model) return "off";
	return clampThinkingLevel(ctx.model, ctx.thinkingLevel ?? "off");
}

function sameModel(
	left: Pick<Model<Api>, "provider" | "id">,
	right: Pick<Model<Api>, "provider" | "id">,
): boolean {
	return left.provider === right.provider && left.id === right.id;
}

export function resolvePreferredModel(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">,
	store: ModelPreferenceStore,
): ModelPreferenceResolution {
	let configured: ModelPreferenceState | undefined;
	try {
		const result = store.read();
		if (result.status === "configured" && result.model) configured = result.model;
	} catch {
		configured = undefined;
	}

	const active = ctx.model as Model<Api> | undefined;
	let activeLevel: ModelThinkingLevel = "off";
	if (active) {
		try {
			activeLevel = activeModelThinkingLevel(ctx as ExtensionContext);
		} catch {
			activeLevel = "off";
		}
	}
	const activeChoice = active
		? { model: active, thinkingLevel: activeLevel, source: "active" as const }
		: undefined;

	if (configured) {
		let configuredModel: Model<Api> | undefined;
		try {
			configuredModel = ctx.modelRegistry.find(configured.provider, configured.id);
		} catch {
			configuredModel = undefined;
		}
		if (configuredModel) {
			let thinkingLevel = configured.thinkingLevel;
			try {
				thinkingLevel = clampThinkingLevel(configuredModel, configured.thinkingLevel);
			} catch {
				// Keep the persisted level if a custom model implementation cannot be inspected.
			}
			const preferred: ModelPreferenceChoice = {
				model: configuredModel,
				thinkingLevel,
				source: "configured",
			};
			return {
				configured,
				preferred,
				fallback:
					activeChoice && !sameModel(preferred.model, activeChoice.model)
						? activeChoice
						: undefined,
			};
		}
	}
	return { configured, preferred: activeChoice };
}

export function resolvePreferredUtilityModel(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">,
	store: ModelPreferenceStore = createGlobalUtilityModelStore(),
): ModelPreferenceResolution {
	return resolvePreferredModel(ctx, store);
}
