/**
 * Session Cleanup Extension
 *
 * Provides /session:cleanup [days] for confirmed permanent deletion of old
 * persisted Pi sessions.
 */

import { lstat, realpath, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SessionScope {
	root: string;
	listAllProjects: boolean;
}

interface SessionCandidate {
	path: string;
	size: number;
}

interface DeleteSummary {
	deleted: number;
	skipped: number;
	failed: number;
}

function getDefaultSessionsRoot(): string {
	return resolve(getAgentDir(), "sessions");
}

function isWithin(root: string, candidate: string, allowRoot = false): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	if (rel === "") return allowRoot;
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function getSessionScope(sessionDir: string): SessionScope {
	const defaultRoot = getDefaultSessionsRoot();
	const resolvedDir = resolve(sessionDir);
	if (isWithin(defaultRoot, resolvedDir, true)) {
		return { root: defaultRoot, listAllProjects: true };
	}
	return { root: resolvedDir, listAllProjects: false };
}

function parseDays(args: string | undefined): number | undefined {
	const trimmed = args?.trim();
	if (!trimmed) return DEFAULT_RETENTION_DAYS;
	if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
	const value = Number(trimmed);
	return Number.isSafeInteger(value) ? value : undefined;
}

function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	if (bytes <= 0) return "0 B";
	const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** unit;
	return unit === 0 ? `${Math.round(value)} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
}

async function canonicalRoot(root: string): Promise<string> {
	try {
		return await realpath(root);
	} catch {
		return resolve(root);
	}
}

async function isSafeRegularFile(path: string, root: string): Promise<boolean> {
	const resolvedPath = resolve(path);
	if (!isWithin(root, resolvedPath)) return false;

	try {
		const [fileStats, parentPath, rootPath] = await Promise.all([
			lstat(resolvedPath),
			realpath(dirname(resolvedPath)),
			canonicalRoot(root),
		]);
		return fileStats.isFile() && isWithin(rootPath, parentPath, true);
	} catch {
		return false;
	}
}

async function collectCandidates(
	sessions: SessionInfo[],
	root: string,
	currentFile: string | undefined,
	cutoffMs: number,
): Promise<SessionCandidate[]> {
	const currentPath = currentFile ? resolve(currentFile) : undefined;
	const candidates: SessionCandidate[] = [];

	for (const session of sessions) {
		const path = resolve(session.path);
		if (path === currentPath || !(await isSafeRegularFile(path, root))) continue;
		try {
			const stats = await lstat(path);
			if (stats.mtimeMs < cutoffMs) candidates.push({ path, size: stats.size });
		} catch {
			// The session raced away after listing.
		}
	}

	return candidates;
}

async function deleteCandidates(
	candidates: SessionCandidate[],
	root: string,
	currentFile: string | undefined,
	cutoffMs: number,
): Promise<{ summary: DeleteSummary; parentDirs: Set<string> }> {
	const summary: DeleteSummary = { deleted: 0, skipped: 0, failed: 0 };
	const parentDirs = new Set<string>();
	const currentPath = currentFile ? resolve(currentFile) : undefined;

	for (const candidate of candidates) {
		if (candidate.path === currentPath || !(await isSafeRegularFile(candidate.path, root))) {
			summary.skipped++;
			continue;
		}

		try {
			const stats = await lstat(candidate.path);
			if (stats.mtimeMs >= cutoffMs) {
				summary.skipped++;
				continue;
			}
			await unlink(candidate.path);
			summary.deleted++;
			parentDirs.add(dirname(candidate.path));
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
			if (code === "ENOENT") summary.skipped++;
			else summary.failed++;
		}
	}

	return { summary, parentDirs };
}

async function cleanEmptyParents(startDir: string, root: string): Promise<void> {
	const resolvedRoot = resolve(root);
	let current = resolve(startDir);

	while (current !== resolvedRoot && isWithin(resolvedRoot, current)) {
		try {
			if ((await readdir(current)).length > 0) return;
			await rmdir(current);
		} catch {
			return;
		}
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

export default function sessionCleanupExtension(pi: ExtensionAPI): void {
	pi.registerCommand("session:cleanup", {
		description: "Permanently delete Pi sessions older than a number of days (default: 7)",
		handler: async (args, ctx) => {
			const days = parseDays(args);
			if (days === undefined) {
				ctx.ui.notify("Usage: /session:cleanup [positive-integer-days]", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Session cleanup requires interactive confirmation.", "error");
				return;
			}

			const scope = getSessionScope(ctx.sessionManager.getSessionDir());
			let sessions: SessionInfo[];
			try {
				sessions = scope.listAllProjects
					? await SessionManager.listAll()
					: await SessionManager.listAll(scope.root);
			} catch (error) {
				ctx.ui.notify(
					`Could not list Pi sessions: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			const cutoffMs = Date.now() - days * DAY_MS;
			const currentFile = ctx.sessionManager.getSessionFile();
			const candidates = await collectCandidates(sessions, scope.root, currentFile, cutoffMs);
			if (candidates.length === 0) {
				ctx.ui.notify(`No Pi sessions were last modified more than ${days} day(s) ago.`, "info");
				return;
			}

			const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.size, 0);
			const preview = [
				`${candidates.length} session(s), ${formatBytes(totalBytes)}`,
				`last modified more than ${days} day(s) ago. This cannot be undone.`,
			].join(", ");
			const confirmed = await ctx.ui.confirm("Permanently delete old Pi sessions?", preview);
			if (!confirmed) {
				ctx.ui.notify("Session cleanup cancelled.", "info");
				return;
			}

			const { summary, parentDirs } = await deleteCandidates(
				candidates,
				scope.root,
				currentFile,
				cutoffMs,
			);
			for (const parentDir of parentDirs) await cleanEmptyParents(parentDir, scope.root);

			const result = [
				`Deleted ${summary.deleted} session(s)`,
				`skipped ${summary.skipped}`,
				`failed ${summary.failed}.`,
			].join("; ");
			ctx.ui.notify(result, summary.failed > 0 ? "warning" : "info");
		},
	});
}

export {
	cleanEmptyParents,
	collectCandidates,
	deleteCandidates,
	formatBytes,
	getDefaultSessionsRoot,
	getSessionScope,
	isWithin,
	parseDays,
};
