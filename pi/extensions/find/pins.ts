import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PIN_STATE_VERSION = 1;
const LOCK_ATTEMPTS = 20;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;

export const GLOBAL_SESSION_PINS_PATH = join(getAgentDir(), "state", "session-pins.json");

interface PersistedPinState extends Record<string, unknown> {
	version: 1;
	pinned: string[];
}

export interface SessionPinStore {
	read(): Promise<ReadonlySet<string>>;
	setPinned(path: string, pinned: boolean): Promise<boolean>;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function normalizePinnedPath(path: string): string {
	return resolve(path);
}

async function readState(path: string): Promise<PersistedPinState | undefined> {
	let stats;
	try {
		stats = await lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`Refusing to read non-regular session pin state: ${path}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(
			`Invalid session pin state: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Invalid session pin state: expected an object");
	}
	const state = parsed as Partial<PersistedPinState>;
	if (state.version !== PIN_STATE_VERSION) {
		throw new Error(`Unsupported session pin state version: ${String(state.version)}`);
	}
	if (
		!Array.isArray(state.pinned) ||
		state.pinned.some((entry) => typeof entry !== "string" || !isAbsolute(entry))
	) {
		throw new Error("Invalid session pin state: pinned must contain absolute paths");
	}
	return state as PersistedPinState;
}

async function delay(durationMs: number): Promise<void> {
	await new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
	const lockPath = `${path}.lock`;
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			return async () => {
				try {
					await handle.close();
				} finally {
					await unlink(lockPath).catch(() => undefined);
				}
			};
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			try {
				const stats = await lstat(lockPath);
				if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
					await unlink(lockPath);
					continue;
				}
			} catch (lockError) {
				if (errorCode(lockError) === "ENOENT") continue;
			}
			if (attempt + 1 < LOCK_ATTEMPTS) await delay(LOCK_RETRY_MS);
		}
	}
	throw new Error("Session pin state is busy; try again");
}

async function writeState(path: string, state: PersistedPinState): Promise<void> {
	const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

export function createSessionPinStore(path = GLOBAL_SESSION_PINS_PATH): SessionPinStore {
	return {
		async read(): Promise<ReadonlySet<string>> {
			const state = await readState(path);
			return new Set((state?.pinned ?? []).map(normalizePinnedPath));
		},
		async setPinned(sessionPath: string, pinned: boolean): Promise<boolean> {
			const normalizedPath = normalizePinnedPath(sessionPath);
			const release = await acquireLock(path);
			try {
				const current = await readState(path);
				const pinnedPaths = new Set((current?.pinned ?? []).map(normalizePinnedPath));
				const changed = pinned ? !pinnedPaths.has(normalizedPath) : pinnedPaths.has(normalizedPath);
				if (!changed) return false;
				if (pinned) pinnedPaths.add(normalizedPath);
				else pinnedPaths.delete(normalizedPath);
				await writeState(path, {
					...(current ?? {}),
					version: PIN_STATE_VERSION,
					pinned: [...pinnedPaths].sort((left, right) => left.localeCompare(right)),
				});
				return true;
			} finally {
				await release();
			}
		},
	};
}
