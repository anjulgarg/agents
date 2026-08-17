import type { ComponentDefinition, ResourceDefinition } from "./contracts.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeJsonPointer(pointer: string): string[] {
	return pointer
		.slice(1)
		.split("/")
		.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function primaryResource(component: ComponentDefinition): ResourceDefinition | undefined {
	return component.resources.find((resource) => resource.kind !== "external");
}
