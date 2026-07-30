import { createHash } from "node:crypto";
import {
	lstat as nodeLstat,
	readFile as nodeReadFile,
	readdir as nodeReaddir,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type {
	ComponentDefinition,
	ComponentInspection,
	InspectionContext,
	OutputDefinition,
	OutputInspection,
	ReadOnlyFileSystem,
	SystemInspection,
	UnmanagedSkillInspection,
} from "../domain/contracts.ts";
import { components } from "../registry/catalog.ts";
import {
	resolveContainedPath,
	resolveDestination,
	resolveSource,
} from "../registry/destinations.ts";
import { readReceipt } from "./receipt.ts";

function defaultFileSystem(): ReadOnlyFileSystem {
	return {
		readFile: nodeReadFile,
		readdir: (path) => nodeReaddir(path, { withFileTypes: true }),
		lstat: nodeLstat,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function jsonPointer(value: unknown, pointer: string): unknown {
	if (pointer === "") return value;
	let current = value;
	for (const encoded of pointer.slice(1).split("/")) {
		if (!isRecord(current)) return undefined;
		const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!Object.hasOwn(current, segment)) return undefined;
		current = current[segment];
	}
	return current;
}

function equalValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => equalValue(item, b[index]));
	}
	if (isRecord(a) && isRecord(b)) {
		const aKeys = Object.keys(a).sort();
		const bKeys = Object.keys(b).sort();
		return equalValue(aKeys, bKeys) && aKeys.every((key) => equalValue(a[key], b[key]));
	}
	return false;
}

async function pathKind(
	fs: ReadOnlyFileSystem,
	path: string,
): Promise<"file" | "directory" | "missing" | "unavailable"> {
	try {
		const info = await fs.lstat(path);
		if (info.isSymbolicLink()) return "unavailable";
		if (info.isFile()) return "file";
		if (info.isDirectory()) return "directory";
		return "unavailable";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
	}
}

async function treeDigest(
	fs: ReadOnlyFileSystem,
	path: string,
): Promise<{ digest?: string; state: "exact" | "missing" | "unavailable" }> {
	const kind = await pathKind(fs, path);
	if (kind === "missing") return { state: "missing" };
	if (kind === "unavailable") return { state: "unavailable" };
	const hash = createHash("sha256");
	if (kind === "file") {
		try {
			hash.update(await fs.readFile(path));
			return { state: "exact", digest: hash.digest("hex") };
		} catch {
			return { state: "unavailable" };
		}
	}
	let entries;
	try {
		entries = [...(await fs.readdir(path))].sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return { state: "unavailable" };
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) return { state: "unavailable" };
		const child = await treeDigest(fs, join(path, entry.name));
		if (child.state !== "exact") return child;
		hash.update(`${entry.name}\0${entry.isDirectory() ? "d" : "f"}\0${child.digest}\0`);
	}
	return { state: "exact", digest: hash.digest("hex") };
}

function outputResult(
	output: OutputDefinition,
	path: string,
	state: OutputInspection["state"],
	reason: string,
): OutputInspection {
	return { strategy: output.strategy, path, state, reason };
}

async function inspectCopy(
	fs: ReadOnlyFileSystem,
	source: string,
	path: string,
	output: OutputDefinition,
): Promise<OutputInspection> {
	const [expected, actual] = await Promise.all([treeDigest(fs, source), treeDigest(fs, path)]);
	if (expected.state !== "exact") {
		return outputResult(output, path, "unavailable", "Source resource is unreadable or unsafe.");
	}
	if (actual.state === "missing") return outputResult(output, path, "missing", "Output is absent.");
	if (actual.state === "unavailable") {
		return outputResult(output, path, "unavailable", "Output is unreadable or unsafe.");
	}
	return expected.digest === actual.digest
		? outputResult(output, path, "exact", "Output matches the source resource.")
		: outputResult(output, path, "drifted", "Output differs from the source resource.");
}

async function inspectJsonOutput(
	fs: ReadOnlyFileSystem,
	source: string,
	path: string,
	output: Extract<OutputDefinition, { strategy: "owned-json" }>,
): Promise<OutputInspection> {
	const destinationKind = await pathKind(fs, path);
	if (destinationKind === "missing")
		return outputResult(output, path, "missing", "Owned JSON values are absent.");
	if (destinationKind !== "file") {
		return outputResult(
			output,
			path,
			"unavailable",
			"Owned JSON destination is unreadable or unsafe.",
		);
	}
	try {
		const [sourceValue, destinationValue] = await Promise.all([
			fs.readFile(source).then(parseJson),
			fs.readFile(path).then(parseJson),
		]);
		if (!sourceValue) {
			return outputResult(output, path, "unavailable", "Source JSON is malformed.");
		}
		if (!destinationValue) {
			return outputResult(output, path, "unavailable", "Owned JSON destination is malformed.");
		}
		const exact = output.pointers.every((pointer) =>
			equalValue(jsonPointer(sourceValue, pointer), jsonPointer(destinationValue, pointer)),
		);
		return exact
			? outputResult(output, path, "exact", "Owned JSON values match.")
			: outputResult(output, path, "drifted", "One or more owned JSON values differ.");
	} catch {
		return outputResult(output, path, "unavailable", "Owned JSON values could not be read.");
	}
}

async function settingsObject(
	fs: ReadOnlyFileSystem,
	path: string,
): Promise<{ value?: Record<string, unknown>; state: "exact" | "missing" | "unavailable" }> {
	const kind = await pathKind(fs, path);
	if (kind === "missing") return { state: "missing" };
	if (kind !== "file") return { state: "unavailable" };
	try {
		const value = parseJson(await fs.readFile(path));
		return value ? { value, state: "exact" } : { state: "unavailable" };
	} catch {
		return { state: "unavailable" };
	}
}

function sameNormalizedPath(a: string, b: string): boolean {
	const normalize = (path: string): string => resolve(path).split(sep).join("/");
	return normalize(a) === normalize(b);
}

async function inspectPackageSetting(
	fs: ReadOnlyFileSystem,
	path: string,
	output: Extract<OutputDefinition, { strategy: "pi-package-setting" }>,
): Promise<OutputInspection> {
	const settings = await settingsObject(fs, path);
	if (settings.state === "missing")
		return outputResult(output, path, "missing", "Package setting is absent.");
	if (!settings.value)
		return outputResult(output, path, "unavailable", "Pi settings are malformed or unreadable.");
	const packages = settings.value.packages;
	if (!Array.isArray(packages))
		return outputResult(output, path, "drifted", "Pi packages is not an array.");
	return packages.includes(output.source)
		? outputResult(output, path, "exact", "Pinned package setting is present.")
		: outputResult(output, path, "missing", "Pinned package setting is absent.");
}

async function inspectPiFilter(
	fs: ReadOnlyFileSystem,
	path: string,
	sourceRoot: string,
	output: Extract<OutputDefinition, { strategy: "pi-package-filter" }>,
): Promise<OutputInspection> {
	const settings = await settingsObject(fs, path);
	if (settings.state === "missing")
		return outputResult(output, path, "missing", "Local Pi package filter is absent.");
	if (!settings.value)
		return outputResult(output, path, "unavailable", "Pi settings are malformed or unreadable.");
	const packages = settings.value.packages;
	if (!Array.isArray(packages))
		return outputResult(output, path, "drifted", "Pi packages is not an array.");
	const local = packages.find(
		(item): item is Record<string, unknown> =>
			isRecord(item) &&
			typeof item.source === "string" &&
			sameNormalizedPath(item.source, sourceRoot),
	);
	if (!local) return outputResult(output, path, "missing", "Local Pi package entry is absent.");
	const filters = local[output.resourceKind];
	const skills = local.skills;
	if (!Array.isArray(filters) || !Array.isArray(skills) || skills.length !== 0) {
		return outputResult(output, path, "drifted", "Local Pi package filters are malformed.");
	}
	return filters.includes(output.filter)
		? outputResult(output, path, "exact", "Local Pi package filter is present.")
		: outputResult(output, path, "missing", "Local Pi package filter is absent.");
}

function managedContent(
	output: Extract<OutputDefinition, { strategy: "managed-block" }>,
	instructions: string,
): string {
	const body =
		output.content === "{{resource:instructions/AGENTS.md}}" ? instructions.trim() : output.content;
	return `${output.beginMarker}\n${body}\n${output.endMarker}`;
}

async function inspectManagedBlock(
	fs: ReadOnlyFileSystem,
	path: string,
	source: string,
	output: Extract<OutputDefinition, { strategy: "managed-block" }>,
): Promise<OutputInspection> {
	const kind = await pathKind(fs, path);
	if (kind === "missing") return outputResult(output, path, "missing", "Managed block is absent.");
	if (kind !== "file")
		return outputResult(
			output,
			path,
			"unavailable",
			"Managed block destination is unreadable or unsafe.",
		);
	try {
		const [destination, instructions] = await Promise.all([
			fs.readFile(path).then((bytes) => Buffer.from(bytes).toString("utf8")),
			fs.readFile(source).then((bytes) => Buffer.from(bytes).toString("utf8")),
		]);
		const expected = managedContent(output, instructions);
		if (destination.includes(expected))
			return outputResult(output, path, "exact", "Managed block matches.");
		const hasMarker =
			destination.includes(output.beginMarker) || destination.includes(output.endMarker);
		return outputResult(
			output,
			path,
			hasMarker ? "drifted" : "missing",
			hasMarker ? "Managed block differs." : "Managed block is absent.",
		);
	} catch {
		return outputResult(output, path, "unavailable", "Managed block could not be read.");
	}
}

export function cursorHookCommand(scriptPath: string): string {
	return `node ${JSON.stringify(scriptPath)}`;
}

async function inspectCursorHook(
	fs: ReadOnlyFileSystem,
	home: string,
	path: string,
	output: Extract<OutputDefinition, { strategy: "cursor-hook" }>,
): Promise<OutputInspection> {
	const settings = await settingsObject(fs, path);
	if (settings.state === "missing")
		return outputResult(output, path, "missing", "Cursor hook registration is absent.");
	if (!settings.value)
		return outputResult(output, path, "unavailable", "Cursor hooks are malformed or unreadable.");
	const hooks = settings.value.hooks;
	if (!isRecord(hooks))
		return outputResult(output, path, "missing", "Cursor hook registration is absent.");
	const entries = hooks[output.event];
	if (!Array.isArray(entries))
		return outputResult(output, path, "missing", "Cursor hook registration is absent.");
	const script = resolveContainedPath(home, output.scriptDestination);
	const expected = cursorHookCommand(script);
	const matching = entries.filter((entry) => isRecord(entry) && entry.command === expected).length;
	const legacyScripts = (output.legacyScriptDestinations ?? []).map((destination) =>
		resolveContainedPath(home, destination),
	);
	const legacy = entries.filter((entry) => {
		if (!isRecord(entry) || typeof entry.command !== "string") return false;
		const entryCommand = entry.command;
		return legacyScripts.some((script) => entryCommand.includes(script));
	}).length;
	if (legacy > 0)
		return outputResult(output, path, "drifted", "Legacy Cursor hook registration is present.");
	if (matching === 1) return outputResult(output, path, "exact", "Cursor hook is registered once.");
	if (matching > 1)
		return outputResult(output, path, "drifted", "Cursor hook is registered more than once.");
	return outputResult(output, path, "missing", "Cursor hook registration is absent.");
}

async function inspectOutput(
	fs: ReadOnlyFileSystem,
	context: Required<Pick<InspectionContext, "home" | "sourceRoot">>,
	component: ComponentDefinition,
	output: OutputDefinition,
): Promise<OutputInspection> {
	const path = resolveDestination(context.home, output);
	const sourceResource = component.resources.find((resource) => resource.kind !== "external");
	const source = sourceResource ? resolveSource(context.sourceRoot, sourceResource.path) : "";
	switch (output.strategy) {
		case "copy":
			return inspectCopy(fs, source, path, output);
		case "owned-json":
			return inspectJsonOutput(fs, source, path, output);
		case "pi-package-filter":
			return inspectPiFilter(fs, path, context.sourceRoot, output);
		case "pi-package-setting":
			return inspectPackageSetting(fs, path, output);
		case "managed-block":
			return inspectManagedBlock(fs, path, source, output);
		case "cursor-hook":
			return inspectCursorHook(fs, context.home, path, output);
	}
}

async function inspectLegacy(
	fs: ReadOnlyFileSystem,
	context: Required<Pick<InspectionContext, "home" | "sourceRoot">>,
	component: ComponentDefinition,
): Promise<readonly OutputInspection[]> {
	if (!component.legacyPaths?.length) return [];
	const sourceResource = component.resources[0];
	if (!sourceResource || sourceResource.kind === "external") return [];
	const source = resolveSource(context.sourceRoot, sourceResource.path);
	const results: OutputInspection[] = [];
	for (const legacyPath of component.legacyPaths) {
		const path = resolveContainedPath(context.home, legacyPath);
		const inspected = await inspectCopy(fs, source, path, {
			strategy: "copy",
			destination: legacyPath,
		});
		if (inspected.state !== "missing") {
			results.push({
				...inspected,
				strategy: "legacy-copy",
				state: inspected.state === "exact" ? "legacy" : inspected.state,
				reason:
					inspected.state === "exact" ? "Legacy direct extension copy detected." : inspected.reason,
			});
		}
	}
	return results;
}

function summarize(outputs: readonly OutputInspection[]): ComponentInspection["status"] {
	const primary = outputs.filter(({ strategy }) => strategy !== "legacy-copy");
	const legacyExact = outputs.some(({ state }) => state === "legacy");
	if (primary.some(({ state }) => state === "unavailable")) return "unavailable";
	const exact = primary.filter(({ state }) => state === "exact").length;
	const drifted = primary.filter(({ state }) => state === "drifted").length;
	const missing = primary.filter(({ state }) => state === "missing").length;
	if (exact === primary.length && primary.length > 0) return "installed";
	if (exact === 0 && drifted === 0 && legacyExact) return "installed";
	if (exact > 0 && (missing > 0 || drifted > 0)) return "partial";
	if (drifted > 0 && missing > 0) return "partial";
	if (drifted > 0) return "drifted";
	return "available";
}

async function unmanagedSkills(
	fs: ReadOnlyFileSystem,
	home: string,
): Promise<{ skills: UnmanagedSkillInspection[]; warning?: string }> {
	const directory = resolveContainedPath(home, ".agents/skills");
	let entries;
	try {
		entries = await fs.readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { skills: [] };
		return {
			skills: [],
			warning: "Skills directory is unreadable; unmanaged skills were not inspected.",
		};
	}
	const known = new Set(
		components
			.filter(({ category }) => category === "skill")
			.map(({ id }) => id.slice("skill:".length)),
	);
	const skills = entries
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !known.has(entry.name))
		.map((entry) => ({ name: entry.name, path: join(directory, entry.name) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { skills };
}

export async function inspectSystem(context: InspectionContext): Promise<SystemInspection> {
	const home = resolve(context.home);
	const sourceRoot = resolve(context.sourceRoot);
	const fs = context.fs ?? defaultFileSystem();
	const receipt = await readReceipt(home, fs);
	const inspections = await Promise.all(
		components.map(async (component): Promise<ComponentInspection> => {
			let outputs: readonly OutputInspection[];
			try {
				outputs = [
					...(await Promise.all(
						component.outputs.map((output) =>
							inspectOutput(fs, { home, sourceRoot }, component, output),
						),
					)),
					...(await inspectLegacy(fs, { home, sourceRoot }, component)),
				];
			} catch {
				outputs = component.outputs.map((output) => ({
					strategy: output.strategy,
					path: resolveDestination(home, output),
					state: "unavailable" as const,
					reason: "Inspection failed safely.",
				}));
			}
			const status = summarize(outputs);
			const reasons = [...new Set(outputs.map(({ reason }) => reason))];
			return {
				id: component.id,
				status,
				managed: receipt.schemaState === "current" && receipt.managedComponents.has(component.id),
				reasons,
				outputs,
			};
		}),
	);
	const unmanaged = await unmanagedSkills(fs, home);
	const warnings = [receipt.warning, unmanaged.warning].filter((warning): warning is string =>
		Boolean(warning),
	);
	return {
		source: { kind: "local", root: sourceRoot, revision: null },
		receipt,
		components: inspections,
		unmanagedSkills: unmanaged.skills,
		warnings,
	};
}

export function inspectionPathIsProtected(path: string, home: string): boolean {
	const normalized = relative(resolve(home), resolve(path)).split(sep).join("/");
	const parts = normalized.split("/");
	const protectedNames = new Set([
		"auth.json",
		"credentials.json",
		"sessions",
		"session",
		"trust",
		"state",
		"npm",
		"git",
		".npm",
		".cache",
		"oauth",
	]);
	return parts.some((part) => protectedNames.has(part.toLowerCase()));
}
