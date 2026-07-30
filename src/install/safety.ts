import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { AgentsError } from "./contracts.ts";

function inside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function existingAncestor(path: string): Promise<string> {
	let current = resolve(path);
	for (;;) {
		try {
			return await realpath(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

async function rejectLinkPath(root: string, path: string, label: string): Promise<void> {
	const rel = relative(root, path);
	if (rel.startsWith("..") || isAbsolute(rel))
		throw new AgentsError("unsafe-path", `${label} escapes its root.`);
	let current = root;
	for (const part of rel.split(/[\\/]/).filter(Boolean)) {
		current = resolve(current, part);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new AgentsError("unsafe-path", `${label} contains a link.`);
			if (process.platform === "win32" && ((info as any).mode & 0xf000) === 0xa000) {
				throw new AgentsError("unsafe-path", `${label} contains a reparse point.`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

export interface SafeRoots {
	home: string;
	sourceRoot: string;
}

export async function validateSafeRoots(
	homeInput: string,
	sourceInput: string,
): Promise<SafeRoots> {
	if (!isAbsolute(homeInput) || !isAbsolute(sourceInput)) {
		throw new AgentsError("unsafe-path", "Home and source root must be absolute paths.");
	}
	const home = resolve(homeInput);
	const sourceRoot = resolve(sourceInput);
	let sourceReal: string;
	try {
		sourceReal = await realpath(sourceRoot);
	} catch (error) {
		throw new AgentsError("unsafe-path", "Source root is unavailable.", undefined, {
			cause: error,
		});
	}
	if (sourceReal !== sourceRoot)
		throw new AgentsError("unsafe-path", "Source root must be realpath-normalized.");
	const homeAncestor = await existingAncestor(home);
	if (inside(sourceReal, home)) {
		throw new AgentsError("unsafe-path", "Target home cannot be inside the source root.");
	}
	await rejectLinkPath(homeAncestor, home, "Target home");
	const sourceInfo = await lstat(sourceReal);
	if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
		throw new AgentsError("unsafe-path", "Source root must be a real directory.");
	}
	return { home, sourceRoot: sourceReal };
}

export async function validateDestination(
	home: string,
	path: string,
	sourceRoot?: string,
): Promise<void> {
	const destination = resolve(path);
	if (!inside(home, destination) || destination === home)
		throw new AgentsError("unsafe-path", "Destination escapes home.");
	if (sourceRoot && inside(resolve(sourceRoot), destination)) {
		throw new AgentsError("unsafe-path", "Destination overlaps the source root.");
	}
	await rejectLinkPath(home, destination, "Destination");
}
