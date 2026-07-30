import * as fs from "node:fs";
import * as path from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	resolveModelScopeWithDiagnostics,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export function modelKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function readSettings(pathname: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("settings must be a JSON object");
		}
		return value as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read subagent model scope from ${pathname}: ${message}`);
	}
}

function enabledModelPatterns(ctx: ExtensionContext): string[] {
	const globalPath = path.join(getAgentDir(), "settings.json");
	const globalSettings = readSettings(globalPath);
	let configured = globalSettings?.enabledModels;
	let source = globalPath;

	if (ctx.isProjectTrusted()) {
		const projectPath = path.join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
		const projectSettings = readSettings(projectPath);
		if (projectSettings && Object.hasOwn(projectSettings, "enabledModels")) {
			configured = projectSettings.enabledModels;
			source = projectPath;
		}
	}

	if (
		!Array.isArray(configured) ||
		configured.length === 0 ||
		configured.some((item) => typeof item !== "string" || !item.trim())
	) {
		throw new Error(`Subagent execution requires a non-empty enabledModels list in ${source}`);
	}
	return configured as string[];
}

export async function getScopedSubagentModels(ctx: ExtensionContext): Promise<Model<any>[]> {
	const patterns = enabledModelPatterns(ctx);
	const { scopedModels: resolved, diagnostics } = await resolveModelScopeWithDiagnostics(
		patterns,
		ctx.modelRegistry,
	);
	if (resolved.length === 0) {
		const details = diagnostics
			.map((diagnostic: { message: string }) => diagnostic.message)
			.join("; ");
		throw new Error(
			`No enabledModels entries resolve to available subagent models${details ? `: ${details}` : ""}`,
		);
	}
	return resolved.map((item: { model: Model<any> }) => item.model);
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
