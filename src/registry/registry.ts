import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { COMPONENT_CATEGORIES } from "../domain/contracts.ts";
import type {
	ComponentDefinition,
	ComponentId,
	OutputDefinition,
	ProfileDefinition,
} from "../domain/contracts.ts";
import { components, piComponentIds, skillIds } from "./catalog.ts";

export type RegistryErrorCode =
	| "duplicate-id"
	| "missing-dependency"
	| "dependency-cycle"
	| "duplicate-output"
	| "missing-resource"
	| "unknown-component";

export class RegistryError extends Error {
	constructor(
		public readonly code: RegistryErrorCode,
		message: string,
		public readonly componentId?: ComponentId,
	) {
		super(message);
		this.name = "RegistryError";
	}
}

export const profiles: readonly ProfileDefinition[] = [
	{
		id: "default",
		label: "Default",
		description: "Complete available agent configuration.",
		components: components.map(({ id }) => id),
	},
	{
		id: "pi",
		label: "Pi",
		description: "All Pi resources and required shared instructions.",
		components: [...piComponentIds, "instructions:shared"],
	},
	{
		id: "skills",
		label: "Skills",
		description: "The eight retained cross-harness skills.",
		components: skillIds,
	},
];

function idIsValid(component: ComponentDefinition): boolean {
	const [category, slug, ...rest] = component.id.split(":");
	return (
		rest.length === 0 &&
		component.category === category &&
		COMPONENT_CATEGORIES.includes(category as (typeof COMPONENT_CATEGORIES)[number]) &&
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? "")
	);
}

function outputKeys(output: OutputDefinition): readonly string[] {
	switch (output.strategy) {
		case "copy":
			return [`path:${output.destination}`];
		case "managed-block":
			return [`block:${output.destination}:${output.beginMarker}`];
		case "owned-json":
			return output.pointers.map((pointer) => `json:${output.destination}:${pointer}`);
		case "pi-package-filter":
			return [`filter:${output.destination}:${output.resourceKind}:${output.filter}`];
		case "pi-package-setting":
			return [`package:${output.destination}:${output.source}`];
		case "cursor-hook":
			return [`hook:${output.destination}:${output.event}:${output.scriptDestination}`];
	}
}

function containedPath(root: string, resource: string): string | undefined {
	if (isAbsolute(resource)) return undefined;
	const path = resolve(root, resource);
	const rel = relative(resolve(root), path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? path : undefined;
}

export async function validateRegistry(
	definitions: readonly ComponentDefinition[],
	sourceRoot?: string,
): Promise<void> {
	const byId = new Map<ComponentId, ComponentDefinition>();
	for (const component of definitions) {
		if (!idIsValid(component) || byId.has(component.id)) {
			throw new RegistryError(
				"duplicate-id",
				`Duplicate or invalid component ID: ${component.id}`,
				component.id,
			);
		}
		byId.set(component.id, component);
	}

	for (const component of definitions) {
		for (const dependency of component.dependsOn) {
			if (!byId.has(dependency)) {
				throw new RegistryError(
					"missing-dependency",
					`${component.id} depends on missing ${dependency}`,
					component.id,
				);
			}
		}
	}

	const visiting = new Set<ComponentId>();
	const visited = new Set<ComponentId>();
	const visit = (id: ComponentId, chain: readonly ComponentId[]): void => {
		if (visiting.has(id)) {
			throw new RegistryError(
				"dependency-cycle",
				`Dependency cycle: ${[...chain, id].join(" -> ")}`,
				id,
			);
		}
		if (visited.has(id)) return;
		visiting.add(id);
		const component = byId.get(id)!;
		for (const dependency of component.dependsOn) visit(dependency, [...chain, id]);
		visiting.delete(id);
		visited.add(id);
	};
	for (const component of definitions) visit(component.id, []);

	const owners = new Map<string, ComponentId>();
	for (const component of definitions) {
		for (const output of component.outputs) {
			for (const key of outputKeys(output)) {
				const owner = owners.get(key);
				if (owner && owner !== component.id) {
					throw new RegistryError(
						"duplicate-output",
						`${key} is owned by both ${owner} and ${component.id}`,
						component.id,
					);
				}
				owners.set(key, component.id);
			}
		}
	}

	if (!sourceRoot) return;
	for (const component of definitions) {
		for (const resource of component.resources) {
			if (resource.kind === "external") continue;
			const path = containedPath(sourceRoot, resource.path);
			if (!path) {
				throw new RegistryError(
					"missing-resource",
					`Unsafe resource path for ${component.id}: ${resource.path}`,
					component.id,
				);
			}
			try {
				const info = await lstat(path);
				const validType =
					!info.isSymbolicLink() && (resource.kind === "file" ? info.isFile() : info.isDirectory());
				if (!validType) throw new Error("wrong resource type");
			} catch {
				throw new RegistryError(
					"missing-resource",
					`Missing or unsafe resource for ${component.id}: ${resource.path}`,
					component.id,
				);
			}
		}
	}
}

function compareComponents(a: ComponentDefinition, b: ComponentDefinition): number {
	return (
		a.category.localeCompare(b.category) ||
		a.label.localeCompare(b.label) ||
		a.id.localeCompare(b.id)
	);
}

export function createResolver(definitions: readonly ComponentDefinition[]) {
	const byId = new Map(definitions.map((component) => [component.id, component]));
	return (ids: readonly ComponentId[]): readonly ComponentId[] => {
		const selected = new Set<ComponentId>();
		const visit = (id: ComponentId): void => {
			const component = byId.get(id);
			if (!component) {
				throw new RegistryError("unknown-component", `Unknown component: ${id}`, id);
			}
			if (selected.has(id)) return;
			selected.add(id);
			for (const dependency of component.dependsOn) visit(dependency);
		};
		for (const id of ids) visit(id);
		return [...selected]
			.map((id) => byId.get(id)!)
			.sort(compareComponents)
			.map(({ id }) => id);
	};
}

export const resolveSelection = createResolver(components);

export function resolveProfile(id: string): readonly ComponentId[] {
	const profile = profiles.find((candidate) => candidate.id === id);
	if (!profile) {
		throw new RegistryError("unknown-component", `Unknown profile: ${id}`);
	}
	return resolveSelection(profile.components);
}

export function getComponent(id: ComponentId): ComponentDefinition {
	const component = components.find((candidate) => candidate.id === id);
	if (!component) throw new RegistryError("unknown-component", `Unknown component: ${id}`, id);
	return component;
}
