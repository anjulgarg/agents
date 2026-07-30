import { isAbsolute, relative, resolve } from "node:path";
import type { OutputDefinition } from "../domain/contracts.ts";

export class UnsafeDestinationError extends Error {
	constructor(destination: string) {
		super(`Destination must remain inside the explicit home: ${destination}`);
		this.name = "UnsafeDestinationError";
	}
}

export function resolveContainedPath(root: string, relativePath: string): string {
	if (isAbsolute(relativePath)) throw new UnsafeDestinationError(relativePath);
	const normalizedRoot = resolve(root);
	const path = resolve(normalizedRoot, relativePath);
	const rel = relative(normalizedRoot, path);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new UnsafeDestinationError(relativePath);
	}
	return path;
}

export function resolveDestination(home: string, output: OutputDefinition): string {
	return resolveContainedPath(home, output.destination);
}

export function resolveSource(sourceRoot: string, resourcePath: string): string {
	return resolveContainedPath(sourceRoot, resourcePath);
}
