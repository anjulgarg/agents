/**
 * TypeScript/JavaScript language-server detection and workspace-root discovery.
 * Does not auto-install; missing executables produce actionable errors.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const LANGUAGE_ID = "typescript";
export const SERVER_COMMAND = "typescript-language-server";
export const SERVER_ARGS = ["--stdio"] as const;
export const INSTALL_HINT = "npm install -g typescript-language-server typescript@5";

export const SUPPORTED_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
]);

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"] as const;
const PACKAGE_NAME = "package.json";

export interface ServerExecutable {
	/** Absolute realpath of the executable to spawn. */
	command: string;
	args: string[];
	resolvedPath: string;
}

export interface ServerLookupResult {
	available: boolean;
	executable?: ServerExecutable;
	error?: string;
}

/**
 * Locate typescript-language-server on PATH (no install).
 * Always returns an absolute realpath command so spawn cwd cannot redirect it.
 */
export function findTypescriptLanguageServer(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): ServerLookupResult {
	const pathEnv = env.PATH ?? env.Path ?? "";
	const parts = pathEnv.split(path.delimiter).filter(Boolean);
	const names =
		process.platform === "win32"
			? [`${SERVER_COMMAND}.cmd`, `${SERVER_COMMAND}.exe`, SERVER_COMMAND]
			: [SERVER_COMMAND];

	for (const dir of parts) {
		const absDir = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
		for (const name of names) {
			const candidate = path.join(absDir, name);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				const resolvedPath = fs.realpathSync(candidate);
				return {
					available: true,
					executable: {
						command: resolvedPath,
						args: [...SERVER_ARGS],
						resolvedPath,
					},
				};
			} catch {
				// try next
			}
		}
	}

	return {
		available: false,
		error:
			`Missing executable "${SERVER_COMMAND}" on PATH. ` +
			`Install with: ${INSTALL_HINT}. ` +
			`Fall back to grep/build/test for navigation until the server is available.`,
	};
}

export function languageIdForPath(filePath: string): string | undefined {
	const ext = path.extname(filePath).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.has(ext)) return undefined;
	if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
		return ext === ".tsx" ? "typescriptreact" : "typescript";
	}
	return ext === ".jsx" ? "javascriptreact" : "javascript";
}

export function isSupportedSourcePath(filePath: string): boolean {
	return languageIdForPath(filePath) !== undefined;
}

/**
 * Deterministic workspace root for a file or cwd.
 * Prefers nearest tsconfig/jsconfig, then package.json, then the start directory.
 */
export function discoverWorkspaceRoot(startPath: string, sessionCwd: string): string {
	const start = path.resolve(startPath);
	let dir: string;
	try {
		const stat = fs.statSync(start);
		dir = stat.isDirectory() ? start : path.dirname(start);
	} catch {
		dir = path.dirname(start);
	}

	const sessionRoot = path.resolve(sessionCwd);
	let current = dir;
	let packageRoot: string | undefined;

	for (;;) {
		for (const name of CONFIG_NAMES) {
			if (fs.existsSync(path.join(current, name))) {
				return current;
			}
		}
		if (!packageRoot && fs.existsSync(path.join(current, PACKAGE_NAME))) {
			packageRoot = current;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		if (
			isSubPath(sessionRoot, current) &&
			parent !== sessionRoot &&
			!isSubPath(sessionRoot, parent)
		) {
			break;
		}
		current = parent;
		if (current === sessionRoot) {
			for (const name of CONFIG_NAMES) {
				if (fs.existsSync(path.join(current, name))) return current;
			}
			if (!packageRoot && fs.existsSync(path.join(current, PACKAGE_NAME))) {
				packageRoot = current;
			}
			break;
		}
	}

	return packageRoot ?? (isSubPath(sessionRoot, dir) ? sessionRoot : dir);
}

export function workspaceKey(root: string): string {
	try {
		return fs.realpathSync(path.resolve(root));
	} catch {
		return path.resolve(root);
	}
}

function isSubPath(root: string, candidate: string): boolean {
	const rel = path.relative(path.resolve(root), path.resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function buildInitializeOptions(): Record<string, unknown> {
	return {
		hostInfo: "pi-coding-agent",
		preferences: {
			includeInlayParameterNameHints: "none",
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
		},
		tsserver: {
			logVerbosity: "off",
		},
	};
}
