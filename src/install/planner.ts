import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ComponentDefinition, ComponentId, OutputDefinition } from "../domain/contracts.ts";
import { components } from "../registry/catalog.ts";
import { resolveContainedPath } from "../registry/destinations.ts";
import {
	getComponent,
	resolveSelection,
	validateRegistry,
	RegistryError,
} from "../registry/registry.ts";
import { readReceipt } from "../status/receipt.ts";
import {
	AgentsError,
	type InstallStateV1,
	type OperationContext,
	type OperationPlan,
	type PlannedChange,
} from "./contracts.ts";
import { validateDestination, validateSafeRoots } from "./safety.ts";

export type Snapshot =
	| { kind: "absent" }
	| { kind: "file"; data: Buffer; mode: number }
	| { kind: "directory"; files: ReadonlyMap<string, { data: Buffer; mode: number }>; mode: number };

interface InternalPlan {
	home: string;
	sourceRoot: string;
	desired: ReadonlyMap<string, Snapshot>;
	before: ReadonlyMap<string, Snapshot>;
	receiptPath: string;
}

const internals = new WeakMap<OperationPlan, InternalPlan>();
const receiptRelative = ".agents/anjulgarg-agents.json";

function hash(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function json(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function snapshot(path: string): Promise<Snapshot> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		throw error;
	}
	if (info.isSymbolicLink()) throw new AgentsError("unsafe-path", "Managed paths cannot be links.");
	if (info.isFile()) return { kind: "file", data: await readFile(path), mode: info.mode };
	if (!info.isDirectory())
		throw new AgentsError("unsafe-path", "Managed paths must be files or directories.");
	const files = new Map<string, { data: Buffer; mode: number }>();
	const visit = async (directory: string): Promise<void> => {
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const child = join(directory, entry.name);
			if (entry.isSymbolicLink())
				throw new AgentsError("unsafe-path", "Managed trees cannot contain links.");
			if (entry.isDirectory()) await visit(child);
			else if (entry.isFile()) {
				const childInfo = await lstat(child);
				files.set(relative(path, child).split(sep).join("/"), {
					data: await readFile(child),
					mode: childInfo.mode,
				});
			} else throw new AgentsError("unsafe-path", "Managed trees contain an unsupported entry.");
		}
	};
	await visit(path);
	return { kind: "directory", files, mode: info.mode };
}

function snapshotHash(value: Snapshot): string | null {
	if (value.kind === "absent") return null;
	if (value.kind === "file") return hash(value.data);
	const digest = createHash("sha256");
	for (const [name, file] of value.files)
		digest.update(name).update("\0").update(file.data).update("\0");
	return digest.digest("hex");
}
function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
	return a.kind === b.kind && snapshotHash(a) === snapshotHash(b);
}

async function parseObject(path: string, allowMissing = true): Promise<Record<string, unknown>> {
	let data: Buffer;
	try {
		data = await readFile(path);
	} catch (error) {
		if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	try {
		const value: unknown = JSON.parse(data.toString("utf8"));
		if (!isRecord(value)) throw new Error("not an object");
		return value;
	} catch (error) {
		throw new AgentsError(
			"malformed-config",
			`Cannot merge non-object or malformed JSON at ${path}.`,
			undefined,
			{ cause: error },
		);
	}
}
function decodePointer(pointer: string): string[] {
	return pointer
		.slice(1)
		.split("/")
		.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}
function pointerGet(root: Record<string, unknown>, pointer: string): unknown {
	let value: unknown = root;
	for (const key of decodePointer(pointer)) {
		if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
		value = value[key];
	}
	return value;
}
function pointerSet(root: Record<string, unknown>, pointer: string, value: unknown): void {
	const parts = decodePointer(pointer);
	let current = root;
	for (const key of parts.slice(0, -1)) {
		const child = current[key];
		current = isRecord(child) ? child : (current[key] = {});
	}
	current[parts.at(-1)!] = structuredClone(value);
}
function pointerDelete(root: Record<string, unknown>, pointer: string): void {
	const parts = decodePointer(pointer);
	const parents: [Record<string, unknown>, string][] = [];
	let current = root;
	for (const key of parts.slice(0, -1)) {
		if (!isRecord(current[key])) return;
		parents.push([current, key]);
		current = current[key] as Record<string, unknown>;
	}
	delete current[parts.at(-1)!];
	for (const [parent, key] of parents.reverse())
		if (isRecord(parent[key]) && Object.keys(parent[key] as object).length === 0)
			delete parent[key];
}

async function loadState(home: string): Promise<InstallStateV1 | undefined> {
	const inspected = await readReceipt(home);
	if (inspected.schemaState === "future")
		throw new AgentsError(
			"unsupported-state",
			"Install receipt uses an unsupported future schema.",
		);
	if (inspected.schemaState === "malformed")
		throw new AgentsError("unsupported-state", "Install receipt is malformed.");
	if (inspected.schemaState === "absent") return undefined;
	const value = await parseObject(inspected.path, false);
	return value as unknown as InstallStateV1;
}

function managedBlock(
	existing: string,
	output: Extract<OutputDefinition, { strategy: "managed-block" }>,
	body: string,
	remove: boolean,
): string {
	const start = existing.indexOf(output.beginMarker);
	const end = existing.indexOf(output.endMarker);
	if ((start === -1) !== (end === -1) || (start !== -1 && end < start))
		throw new AgentsError("malformed-config", "Managed block markers are malformed.");
	const suffix =
		end === -1 ? "" : existing.slice(end + output.endMarker.length).replace(/^\r?\n/, "");
	const without = start === -1 ? existing : existing.slice(0, start) + suffix;
	if (remove) return without.replace(/\s+$/, existing.endsWith("\n") ? "\n" : "");
	const content = output.content === "{{resource:pi/AGENTS.md}}" ? body.trim() : output.content;
	const block = `${output.beginMarker}\n${content}\n${output.endMarker}\n`;
	return without.trim() ? `${without.trimEnd()}\n\n${block}` : block;
}

function sourceFor(component: ComponentDefinition, sourceRoot: string): string | undefined {
	const resource = component.resources.find((item) => item.kind !== "external");
	return resource ? resolveContainedPath(sourceRoot, resource.path) : undefined;
}

async function desiredSettings(
	home: string,
	sourceRoot: string,
	managed: ReadonlySet<ComponentId>,
	operation: "install" | "remove",
	selected: ReadonlySet<ComponentId>,
): Promise<Buffer | undefined> {
	const path = resolveContainedPath(home, ".pi/agent/settings.json");
	const relevant = components.some(
		(component) =>
			component.outputs.some((output) => output.destination === ".pi/agent/settings.json") &&
			selected.has(component.id),
	);
	if (!relevant) return undefined;
	const settings = await parseObject(path);
	for (const component of components.filter((item) => selected.has(item.id))) {
		const source = sourceFor(component, sourceRoot);
		for (const output of component.outputs)
			if (output.strategy === "owned-json" && output.destination === ".pi/agent/settings.json") {
				const sourceJson = await parseObject(source!, false);
				for (const pointer of output.pointers) {
					if (operation === "install")
						pointerSet(settings, pointer, pointerGet(sourceJson, pointer));
					else pointerDelete(settings, pointer);
				}
			}
	}
	const packages = settings.packages;
	if (packages !== undefined && !Array.isArray(packages))
		throw new AgentsError("malformed-config", "Pi packages must be an array.");
	const entries = [...(packages ?? [])];
	const normalizedSource = await realpath(sourceRoot);
	const managesAdapter =
		selected.has("pi-package:mcp-adapter") || managed.has("pi-package:mcp-adapter");
	const legacyAdapterSources = new Set(["./packages/pi-mcp-adapter", "packages/pi-mcp-adapter"]);
	const unrelated = entries.filter((entry) => {
		if (entry === "npm:pi-mcp-adapter@2.15.0") return !managesAdapter;
		if (typeof entry === "string") {
			return !managesAdapter || !legacyAdapterSources.has(entry.replaceAll("\\", "/"));
		}
		if (!isRecord(entry) || typeof entry.source !== "string") return true;
		return !isAbsolute(entry.source) || resolve(entry.source) !== normalizedSource;
	});
	const filters = { extensions: [] as string[], prompts: [] as string[], themes: [] as string[] };
	for (const id of managed)
		for (const output of getComponent(id).outputs)
			if (output.strategy === "pi-package-filter") filters[output.resourceKind].push(output.filter);
	const hasFilters = Object.values(filters).some((items) => items.length > 0);
	if (hasFilters)
		unrelated.push({
			source: normalizedSource,
			extensions: [...new Set(filters.extensions)].sort(),
			skills: [],
			prompts: [...new Set(filters.prompts)].sort(),
			themes: [...new Set(filters.themes)].sort(),
		});
	if (managed.has("pi-package:mcp-adapter")) unrelated.push("npm:pi-mcp-adapter@2.15.0");
	if (unrelated.length > 0) settings.packages = unrelated;
	else delete settings.packages;
	return json(settings);
}

async function buildPlan(
	context: OperationContext,
	ids: readonly ComponentId[],
	operation: "install" | "remove",
): Promise<OperationPlan> {
	if (ids.length === 0)
		throw new AgentsError("invalid-component", "At least one component is required.");
	let resolved: readonly ComponentId[];
	try {
		resolved = resolveSelection(ids);
	} catch (error) {
		if (error instanceof RegistryError)
			throw new AgentsError("invalid-component", error.message, undefined, { cause: error });
		throw error;
	}
	const roots = await validateSafeRoots(context.home, context.sourceRoot);
	await validateRegistry(components, roots.sourceRoot).catch((error) => {
		throw new AgentsError("unsafe-path", "Registry resources are invalid.", undefined, {
			cause: error,
		});
	});
	const state = await loadState(roots.home);
	const existing = new Set<ComponentId>(Object.keys(state?.components ?? {}) as ComponentId[]);
	const selected = new Set(resolved);
	const managed = new Set(existing);
	for (const id of resolved) {
		if (operation === "install") managed.add(id);
		else managed.delete(id);
	}
	const desired = new Map<string, Snapshot>();
	const owners = new Map<string, Set<ComponentId>>();
	const setDesired = (path: string, value: Snapshot, id: ComponentId): void => {
		desired.set(path, value);
		const set = owners.get(path) ?? new Set();
		set.add(id);
		owners.set(path, set);
	};
	for (const component of components.filter((item) => selected.has(item.id))) {
		const source = sourceFor(component, roots.sourceRoot);
		for (const output of component.outputs) {
			const path = resolveContainedPath(roots.home, output.destination);
			await validateDestination(roots.home, path, roots.sourceRoot);
			if (output.destination === ".pi/agent/settings.json") continue;
			if (output.strategy === "copy")
				setDesired(
					path,
					operation === "install" ? await snapshot(source!) : { kind: "absent" },
					component.id,
				);
			else if (output.strategy === "owned-json") {
				const target = desired.get(path);
				const current =
					target?.kind === "file"
						? (JSON.parse(target.data.toString()) as Record<string, unknown>)
						: await parseObject(path);
				const sourceJson = await parseObject(source!, false);
				for (const pointer of output.pointers) {
					if (operation === "install")
						pointerSet(current, pointer, pointerGet(sourceJson, pointer));
					else pointerDelete(current, pointer);
				}
				setDesired(path, { kind: "file", data: json(current), mode: 0o600 }, component.id);
			} else if (output.strategy === "managed-block") {
				let existingText = "";
				try {
					existingText = (await readFile(path)).toString("utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const body = (await readFile(source!)).toString("utf8");
				const result = managedBlock(existingText, output, body, operation === "remove");
				setDesired(
					path,
					result ? { kind: "file", data: Buffer.from(result), mode: 0o644 } : { kind: "absent" },
					component.id,
				);
			} else if (output.strategy === "cursor-hook") {
				const config = await parseObject(path);
				const hooks = config.hooks ?? (config.hooks = {});
				if (!isRecord(hooks))
					throw new AgentsError("malformed-config", "Cursor hooks must be an object.");
				const entries = hooks[output.event] ?? [];
				if (!Array.isArray(entries))
					throw new AgentsError("malformed-config", "Cursor hook event must be an array.");
				const command = `node ${JSON.stringify(resolveContainedPath(roots.home, output.scriptDestination))}`;
				const legacyScripts = (output.legacyScriptDestinations ?? []).map((destination) =>
					resolveContainedPath(roots.home, destination),
				);
				const kept = entries.filter((entry) => {
					if (!isRecord(entry) || typeof entry.command !== "string") return true;
					const entryCommand = entry.command;
					return (
						entryCommand !== command &&
						!legacyScripts.some((script) => entryCommand.includes(script))
					);
				});
				if (operation === "install") kept.push({ command });
				if (kept.length) hooks[output.event] = kept;
				else delete hooks[output.event];
				setDesired(path, { kind: "file", data: json(config), mode: 0o600 }, component.id);
			}
		}
		for (const legacy of component.legacyPaths ?? [])
			setDesired(resolveContainedPath(roots.home, legacy), { kind: "absent" }, component.id);
	}
	const settings = await desiredSettings(
		roots.home,
		roots.sourceRoot,
		managed,
		operation,
		selected,
	);
	if (settings)
		setDesired(
			resolveContainedPath(roots.home, ".pi/agent/settings.json"),
			{ kind: "file", data: settings, mode: 0o600 },
			resolved[0]!,
		);
	const now = (context.now?.() ?? new Date()).toISOString();
	const entries: InstallStateV1["components"] = {} as InstallStateV1["components"];
	for (const id of [...managed].sort()) {
		const component = getComponent(id);
		const resourceDigests: string[] = [];
		for (const resource of component.resources)
			if (resource.kind !== "external")
				resourceDigests.push(
					snapshotHash(await snapshot(resolveContainedPath(roots.sourceRoot, resource.path)))!,
				);
		const outputs = await Promise.all(
			component.outputs.map(async (output) => {
				const path = resolveContainedPath(roots.home, output.destination);
				const value = desired.get(path) ?? (await snapshot(path));
				return {
					path: relative(roots.home, path).split(sep).join("/"),
					strategy: output.strategy,
					sha256: snapshotHash(value),
				};
			}),
		);
		entries[id] = {
			installedAt: state?.components[id]?.installedAt ?? now,
			sourceDigest: hash(
				Buffer.from(
					resourceDigests.join("\0") || component.resources.map((r) => r.path).join("\0"),
				),
			),
			outputs,
		};
	}
	const receiptPath = resolveContainedPath(roots.home, receiptRelative);
	setDesired(
		receiptPath,
		{
			kind: "file",
			data: json({
				schemaVersion: 1,
				source: { kind: "local", root: roots.sourceRoot, revision: null },
				components: entries,
			}),
			mode: 0o600,
		},
		resolved[0]!,
	);
	const before = new Map<string, Snapshot>();
	const changes: PlannedChange[] = [];
	for (const [path, wanted] of [...desired].sort(([a], [b]) => a.localeCompare(b))) {
		const actual = await snapshot(path);
		before.set(path, actual);
		if (snapshotsEqual(actual, wanted)) continue;
		changes.push({
			path,
			action: wanted.kind === "absent" ? "delete" : actual.kind === "absent" ? "create" : "update",
			strategy: path === receiptPath ? "receipt" : "composite",
			componentIds: [...(owners.get(path) ?? selected)].sort(),
			beforeSha256: snapshotHash(actual),
			afterSha256: snapshotHash(wanted),
		});
	}
	const plan: OperationPlan = Object.freeze({
		operation,
		requested: Object.freeze([...ids]),
		resolved: Object.freeze([...resolved]),
		changes: Object.freeze(changes),
		warnings: Object.freeze([]),
	});
	internals.set(plan, { ...roots, desired, before, receiptPath });
	context.emit?.({
		name: "agents.plan",
		operationId: context.operationId?.() ?? randomUUID(),
		componentIds: resolved,
		count: changes.length,
		durationMs: 0,
	});
	return plan;
}

export function getPlanInternal(plan: OperationPlan): InternalPlan | undefined {
	return internals.get(plan);
}
export function assertSnapshotEqual(a: Snapshot, b: Snapshot): boolean {
	return snapshotsEqual(a, b);
}
export async function readSnapshot(path: string): Promise<Snapshot> {
	return snapshot(path);
}
export async function planInstall(
	context: OperationContext,
	ids: readonly ComponentId[],
): Promise<OperationPlan> {
	return buildPlan(context, ids, "install");
}
export async function planRemove(
	context: OperationContext,
	ids: readonly ComponentId[],
): Promise<OperationPlan> {
	return buildPlan(context, ids, "remove");
}
