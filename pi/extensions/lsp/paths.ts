/**
 * Trusted-workspace path and URI helpers for the LSP tool.
 * Canonical realpath containment; reject symlink escapes and unsafe URIs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export class PathSecurityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathSecurityError";
	}
}

export interface CanonicalPath {
	/** Lexical absolute path as resolved from input (may be a symlink path). */
	lexicalPath: string;
	/** realpath of an existing path, or lexical absolute when the target does not exist. */
	canonicalPath: string;
	/** true when lexicalPath is a symlink. */
	isSymlink: boolean;
	/** true when the canonical target exists as a regular file. */
	isRegularFile: boolean;
}

/** Strip leading @, unicode spaces, and expand ~ like Pi path tools. */
export function normalizeInputPath(input: string): string {
	let normalized = input.trim().replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return process.env.HOME ?? os.homedir();
	if (
		normalized.startsWith("~/") ||
		(process.platform === "win32" && normalized.startsWith("~\\"))
	) {
		return path.join(process.env.HOME ?? os.homedir(), normalized.slice(2));
	}
	return normalized;
}

export function toFileUri(absolutePath: string): string {
	return pathToFileURL(path.resolve(absolutePath)).href;
}

/** Parse a file: URI; reject authorities and non-file schemes. */
export function fromFileUri(uri: string): string {
	if (typeof uri !== "string" || !uri.startsWith("file:")) {
		throw new PathSecurityError(`Unsupported URI scheme (file: only): ${String(uri).slice(0, 64)}`);
	}
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		throw new PathSecurityError(`Malformed file URI: ${uri.slice(0, 120)}`);
	}
	if (parsed.protocol !== "file:") {
		throw new PathSecurityError(`Unsupported URI scheme: ${parsed.protocol}`);
	}
	if (parsed.hostname && parsed.hostname !== "localhost") {
		throw new PathSecurityError(`file URI authorities are not allowed: ${uri.slice(0, 120)}`);
	}
	if (parsed.username || parsed.password) {
		throw new PathSecurityError(`file URI userinfo is not allowed: ${uri.slice(0, 120)}`);
	}
	try {
		return fileURLToPath(parsed);
	} catch (error) {
		throw new PathSecurityError(
			`Invalid file URI path: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function canonicalizeExisting(absolutePath: string): CanonicalPath {
	const lexicalPath = path.resolve(absolutePath);
	let isSymlink = false;
	try {
		const lst = fs.lstatSync(lexicalPath);
		isSymlink = lst.isSymbolicLink();
		if (!lst.isFile() && !lst.isSymbolicLink() && !lst.isDirectory()) {
			throw new PathSecurityError(`Not a regular file or directory: ${lexicalPath}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				lexicalPath,
				canonicalPath: lexicalPath,
				isSymlink: false,
				isRegularFile: false,
			};
		}
		if (error instanceof PathSecurityError) throw error;
		throw new PathSecurityError(
			`Cannot stat path: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let canonicalPath: string;
	try {
		canonicalPath = fs.realpathSync(lexicalPath);
	} catch (error) {
		throw new PathSecurityError(
			`Cannot resolve real path: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let isRegularFile = false;
	try {
		isRegularFile = fs.statSync(canonicalPath).isFile();
	} catch {
		isRegularFile = false;
	}

	return { lexicalPath, canonicalPath, isSymlink, isRegularFile };
}

export function canonicalizeRoot(root: string): string {
	const resolved = path.resolve(root);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/** path.relative containment against a canonical root. */
export function isCanonicallyInside(canonicalPath: string, canonicalRoot: string): boolean {
	const rel = path.relative(canonicalRoot, canonicalPath);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function assertInsideTrustedRoot(canonicalPath: string, trustedRoot: string): void {
	const root = canonicalizeRoot(trustedRoot);
	if (!isCanonicallyInside(canonicalPath, root)) {
		throw new PathSecurityError(`Path escapes trusted workspace: ${toSafeDisplay(canonicalPath)}`);
	}
}

export function toProjectRelative(absolutePath: string, workspaceRoot: string): string {
	const root = canonicalizeRoot(workspaceRoot);
	let canonical: string;
	try {
		canonical = fs.realpathSync(path.resolve(absolutePath));
	} catch {
		canonical = path.resolve(absolutePath);
	}
	const rel = path.relative(root, canonical);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new PathSecurityError(`Path escapes trusted workspace: ${absolutePath}`);
	}
	return rel.split(path.sep).join("/") || ".";
}

export interface ResolvedWorkspacePath {
	absolutePath: string;
	canonicalPath: string;
	relativePath: string;
	uri: string;
	isSymlink: boolean;
}

export interface ResolvePathOptions {
	mustExist?: boolean;
	/** When true, reject symlinked paths (preferred for mutations). */
	rejectSymlinks?: boolean;
	/** When true, require a regular file at the canonical target. */
	requireRegularFile?: boolean;
}

/**
 * Resolve a project-relative path against the trusted workspace using realpath containment.
 */
export function resolveWorkspacePath(
	inputPath: string,
	workspaceRoot: string,
	options: ResolvePathOptions = {},
): ResolvedWorkspacePath {
	const normalized = normalizeInputPath(inputPath);
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized) && !normalized.startsWith("file:")) {
		throw new PathSecurityError(`Unsupported URI scheme in path: ${normalized.slice(0, 64)}`);
	}
	if (
		normalized.includes("%2e%2e") ||
		normalized.includes("%2E%2E") ||
		normalized.includes("%2e.") ||
		normalized.includes(".%2e")
	) {
		throw new PathSecurityError(
			`Encoded path traversal is not allowed: ${normalized.slice(0, 120)}`,
		);
	}

	const trustedRoot = canonicalizeRoot(workspaceRoot);
	let lexical: string;
	if (normalized.startsWith("file:")) {
		lexical = fromFileUri(normalized);
	} else {
		lexical = path.isAbsolute(normalized)
			? path.resolve(normalized)
			: path.resolve(workspaceRoot, normalized);
	}

	// Fast reject lexical escapes before touching the filesystem.
	const lexicalRel = path.relative(path.resolve(workspaceRoot), lexical);
	if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel)) {
		throw new PathSecurityError(
			`Path is outside the trusted workspace (${toSafeDisplay(lexical)}).`,
		);
	}

	const mustExist = options.mustExist !== false;
	if (!mustExist && !fs.existsSync(lexical)) {
		const relativePath =
			path.relative(trustedRoot, path.resolve(lexical)).split(path.sep).join("/") || ".";
		if (relativePath.startsWith("..")) {
			throw new PathSecurityError(`Path escapes trusted workspace: ${lexical}`);
		}
		return {
			absolutePath: path.resolve(lexical),
			canonicalPath: path.resolve(lexical),
			relativePath,
			uri: toFileUri(path.resolve(lexical)),
			isSymlink: false,
		};
	}

	const canon = canonicalizeExisting(lexical);
	assertInsideTrustedRoot(canon.canonicalPath, trustedRoot);

	if (options.rejectSymlinks && canon.isSymlink) {
		throw new PathSecurityError(
			`Symlinked paths are not allowed for this operation: ${toProjectRelative(canon.lexicalPath, trustedRoot)}`,
		);
	}

	if (mustExist || options.requireRegularFile) {
		if (!canon.isRegularFile) {
			throw new PathSecurityError(
				`Not a regular file: ${toProjectRelative(canon.lexicalPath, trustedRoot)}`,
			);
		}
	}

	const relativePath = toProjectRelative(canon.canonicalPath, trustedRoot);
	return {
		absolutePath: canon.lexicalPath,
		canonicalPath: canon.canonicalPath,
		relativePath,
		uri: toFileUri(canon.lexicalPath),
		isSymlink: canon.isSymlink,
	};
}

/**
 * Validate an LSP URI against the trusted root. Returns canonical absolute path.
 * Rejects non-file URIs, authorities, and symlink escapes.
 */
export function assertUriInWorkspace(
	uri: string,
	trustedRoot: string,
	options: { rejectSymlinks?: boolean; requireRegularFile?: boolean } = {},
): string {
	const lexical = fromFileUri(uri);
	const canon = canonicalizeExisting(lexical);
	assertInsideTrustedRoot(canon.canonicalPath, trustedRoot);
	if (options.rejectSymlinks && canon.isSymlink) {
		throw new PathSecurityError(`Symlinked URI rejected: ${uri.slice(0, 120)}`);
	}
	if (options.requireRegularFile && !canon.isRegularFile) {
		throw new PathSecurityError(`URI is not a regular file: ${uri.slice(0, 120)}`);
	}
	return canon.canonicalPath;
}

/** Re-check canonical path and inode identity under a held mutation lock before writing. */
export interface FileIdentity {
	canonicalPath: string;
	dev: number | bigint;
	ino: number | bigint;
	mode: number;
	nlink: number;
}

export function readFileIdentity(absolutePath: string): FileIdentity {
	const canon = canonicalizeExisting(absolutePath);
	if (canon.isSymlink) {
		throw new PathSecurityError(`Refusing to mutate through a symlink: ${absolutePath}`);
	}
	if (!canon.isRegularFile) {
		throw new PathSecurityError(`Mutation target is not a regular file: ${absolutePath}`);
	}
	const st = fs.statSync(canon.canonicalPath);
	if (!st.isFile()) {
		throw new PathSecurityError(`Mutation target is not a regular file: ${absolutePath}`);
	}
	return {
		canonicalPath: canon.canonicalPath,
		dev: st.dev,
		ino: st.ino,
		mode: st.mode,
		nlink: st.nlink,
	};
}

export function revalidateMutationTarget(
	absolutePath: string,
	expected: { canonicalPath: string; dev: number | bigint; ino: number | bigint },
	trustedRoot: string,
): FileIdentity {
	const identity = readFileIdentity(absolutePath);
	assertInsideTrustedRoot(identity.canonicalPath, trustedRoot);
	if (identity.canonicalPath !== expected.canonicalPath) {
		throw new PathSecurityError(
			`Canonical path changed under lock (possible TOCTOU): expected ${expected.canonicalPath}, got ${identity.canonicalPath}`,
		);
	}
	if (identity.dev !== expected.dev || identity.ino !== expected.ino) {
		throw new PathSecurityError(
			`Inode identity changed under lock for ${absolutePath} (possible replace/TOCTOU)`,
		);
	}
	return identity;
}

function toSafeDisplay(absolutePath: string): string {
	return absolutePath.length > 120 ? `${absolutePath.slice(0, 117)}...` : absolutePath;
}
