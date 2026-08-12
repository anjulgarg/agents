import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function modelKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

export async function getScopedSubagentModels(ctx: ExtensionContext): Promise<Model<any>[]> {
	const models = (ctx.scopedModels ?? []).map(({ model }) => model);
	if (models.length === 0) {
		throw new Error(
			"Subagent execution requires an explicit Pi model scope. Start Pi with " +
				"--models <provider/model,...> or set Pi's native enabledModels setting, then restart. " +
				"Run /scoped-models to verify the active scope before using subagents.",
		);
	}
	return models;
}

function normalizeModelName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Fuzzy subagent model lookup; team policy validation remains in team/index.ts. */
export function resolveSubagentModel(
	requested: string | undefined,
	available: Model<any>[],
	fallback: Model<any> | undefined,
): Model<any> {
	if (!requested) {
		if (fallback && available.some((model) => modelKey(model) === modelKey(fallback)))
			return fallback;
		throw new Error("No subagent model was selected and the parent model is unavailable");
	}

	const exact = available.filter(
		(model) =>
			modelKey(model).toLowerCase() === requested.toLowerCase() ||
			model.id.toLowerCase() === requested.toLowerCase() ||
			model.name?.toLowerCase() === requested.toLowerCase(),
	);
	if (exact.length === 1) return exact[0];

	const normalized = normalizeModelName(requested);
	const normalizedMatches = available.filter((model) =>
		[modelKey(model), model.id, model.name ?? ""].some(
			(candidate) => normalizeModelName(candidate) === normalized,
		),
	);
	if (normalizedMatches.length === 1) return normalizedMatches[0];

	const partial = available.filter((model) =>
		[modelKey(model), model.id, model.name ?? ""].some((candidate) =>
			normalizeModelName(candidate).includes(normalized),
		),
	);
	if (partial.length === 1) return partial[0];
	if (partial.length > 1 || exact.length > 1 || normalizedMatches.length > 1) {
		throw new Error(`Ambiguous subagent model "${requested}"`);
	}

	const choices = available.map(modelKey).join(", ");
	throw new Error(`Unavailable subagent model "${requested}". Available: ${choices || "none"}`);
}

export async function modelCatalog(ctx: ExtensionContext): Promise<string> {
	return (await getScopedSubagentModels(ctx))
		.map((model) => `${modelKey(model)}${model.reasoning ? " [reasoning]" : ""}`)
		.join(", ");
}
