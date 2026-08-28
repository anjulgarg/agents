import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	MAX_SUBAGENT_TIMEOUT_MS,
	THINKING_LEVELS,
	type PersistentChildSession,
	PersistentExecutionContract,
	PersistentSessionState,
	PersistentSessionView,
	type WorktreeInfo,
} from "./contracts.ts";

export const PERSISTENT_SESSION_STATE_TYPE = "subagent-session-state" as const;
export const PERSISTENT_SESSION_STATE_VERSION = 1 as const;

export interface PersistentSessionSnapshot {
	type: typeof PERSISTENT_SESSION_STATE_TYPE;
	version: typeof PERSISTENT_SESSION_STATE_VERSION;
	revision?: number;
	ownerParentSessionId: string;
	/** Parent branch identity. Older records may use branchId instead. */
	parentBranchId?: string;
	branchId?: string;
	sessionId: string;
	state: PersistentSessionState;
	mode: "persistent";
	child: PersistentChildSession;
	execution: PersistentExecutionContract;
	latestRunId?: string;
	latestTaskId?: string;
	createdAt: number;
	updatedAt: number;
	error?: string;
}

export type PersistentSessionSnapshotInput = Omit<PersistentSessionSnapshot, "revision"> & {
	revision?: number;
};

export interface PersistentLockOwner {
	parentPid: number;
	childPid?: number;
	ownerToken?: string;
	ownerParentSessionId: string;
	sessionId: string;
	nonce: string;
	acquiredAt: number;
}

export interface PersistentSessionLock {
	sessionId: string;
	nonce: string;
	path: string;
}

export interface PersistentProcessHooks {
	/** Return whether a PID is definitely live. An exception is treated as unknown. */
	isProcessAlive?: (pid: number) => boolean;
	/** Confirm that every known child process/group owned by this lock is gone. */
	confirmCleanup?: (owner: PersistentLockOwner) => boolean;
	/** Optional cleanup action. Returning false blocks stale-lock recovery. */
	cleanupStaleOwner?: (owner: PersistentLockOwner) => boolean;
}

export interface PersistentSessionStoreOptions {
	/** Required injection point. Production integration supplies a derived Pi agent path. */
	stateRoot: string;
	ownerParentSessionId: string;
	activeBranchId?: string;
	now?: () => number;
	randomNonce?: () => string;
	processHooks?: PersistentProcessHooks;
	/** Parent custom entries or fixture records to reconstruct. */
	entries?: readonly unknown[];
	snapshots?: readonly unknown[];
	/** Wave B can append to parent custom entries instead of the local fixture log. */
	appendSnapshot?: (snapshot: PersistentSessionSnapshot) => void;
}

interface BlockedRecord {
	kind: "blocked";
	sessionId: string;
	ownerParentSessionId: string;
	parentBranchId?: string;
	state: "blocked";
	createdAt: number;
	updatedAt: number;
	error: string;
}

type SessionRecord = PersistentSessionSnapshot | BlockedRecord;

export class PersistentSessionError extends Error {
	readonly code:
		"INVALID" | "UNKNOWN" | "FOREIGN_OWNER" | "INACTIVE_BRANCH" | "BUSY" | "BLOCKED" | "CLOSED";

	constructor(code: PersistentSessionError["code"], message: string) {
		super(message);
		this.name = "PersistentSessionError";
		this.code = code;
	}
}

function validId(value: string, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 200 ||
		value === "." ||
		value === ".." ||
		/[\\/\0\r\n]/.test(value)
	) {
		throw new PersistentSessionError("INVALID", `${label} is not a safe path identifier`);
	}
	return value;
}

function resolvedContained(root: string, candidate: string): string {
	const rootPath = path.resolve(root);
	try {
		if (fs.existsSync(rootPath) && fs.lstatSync(rootPath).isSymbolicLink()) {
			throw new PersistentSessionError("INVALID", `state root is a symlink: ${rootPath}`);
		}
	} catch (error) {
		if (error instanceof PersistentSessionError) throw error;
		throw new PersistentSessionError("INVALID", `cannot validate state root: ${rootPath}`);
	}
	const candidatePath = path.resolve(candidate);
	const relative = path.relative(rootPath, candidatePath);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new PersistentSessionError("INVALID", `runtime path escapes state root: ${candidate}`);
	}
	return candidatePath;
}

function rejectSymlinkComponents(root: string, candidate: string): void {
	const relative = path.relative(root, candidate);
	let current = root;
	for (const component of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			if (fs.lstatSync(current).isSymbolicLink()) {
				throw new PersistentSessionError(
					"INVALID",
					`runtime path contains a symlink: ${candidate}`,
				);
			}
		} catch (error) {
			if (error instanceof PersistentSessionError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			break;
		}
	}
}

function rejectSymlinkPath(candidate: string): void {
	const parsed = path.parse(candidate);
	let current = parsed.root;
	for (const component of path.relative(parsed.root, candidate).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			if (fs.lstatSync(current).isSymbolicLink()) {
				throw new PersistentSessionError("INVALID", `state root contains a symlink: ${candidate}`);
			}
		} catch (error) {
			if (error instanceof PersistentSessionError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

/** Validate a runtime path lexically and against existing symlink components. */
export function validateContainedRuntimePath(stateRoot: string, candidate: string): string {
	const root = path.resolve(stateRoot);
	const resolved = resolvedContained(root, candidate);
	rejectSymlinkPath(root);
	if (fs.existsSync(root)) rejectSymlinkComponents(root, resolved);
	return resolved;
}

export interface PersistentSessionPaths {
	stateRoot: string;
	parentRoot: string;
	sessionsRoot: string;
	locksRoot: string;
	sessionDir: string;
	lockDir: string;
}

/** Derive the only child-session and lock locations accepted by the store. */
export function derivePersistentSessionPaths(
	stateRoot: string,
	ownerParentSessionId: string,
	sessionId: string,
): PersistentSessionPaths {
	const root = validateContainedRuntimePath(stateRoot, stateRoot);
	const parent = validId(ownerParentSessionId, "owner parent session ID");
	const session = validId(sessionId, "session ID");
	const parentRoot = path.join(root, "subagents", parent);
	const sessionsRoot = path.join(parentRoot, "sessions");
	const locksRoot = path.join(parentRoot, "locks");
	const sessionDir = path.join(sessionsRoot, session);
	const lockDir = path.join(locksRoot, session);
	for (const candidate of [parentRoot, sessionsRoot, locksRoot, sessionDir, lockDir]) {
		validateContainedRuntimePath(root, candidate);
	}
	return { stateRoot: root, parentRoot, sessionsRoot, locksRoot, sessionDir, lockDir };
}

function mkdirOwned(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(directory, 0o700);
	} catch {
		/* Windows and restricted test filesystems may not support chmod. */
	}
}

function finiteTimestamp(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new PersistentSessionError("INVALID", `${label} must be a finite timestamp`);
	}
	return value;
}

function branchOf(entry: { parentBranchId?: unknown; branchId?: unknown }): string | undefined {
	const branch = entry.parentBranchId ?? entry.branchId;
	return typeof branch === "string" ? branch : undefined;
}

function isSnapshot(record: SessionRecord): record is PersistentSessionSnapshot {
	return !((record as BlockedRecord).kind === "blocked");
}

/** Pi custom entries wrap the snapshot in `data`; fixtures may pass snapshots directly. */
function unwrapSnapshotEntry(raw: unknown): Record<string, unknown> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const entry = raw as Record<string, unknown>;
	if (entry.type === "custom") {
		if (entry.customType !== PERSISTENT_SESSION_STATE_TYPE) return undefined;
		return entry.data && typeof entry.data === "object"
			? (entry.data as Record<string, unknown>)
			: undefined;
	}
	if (entry.customType !== undefined && entry.customType !== PERSISTENT_SESSION_STATE_TYPE) {
		return undefined;
	}
	return entry;
}

function safeDiagnostic(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

export function reconstructPersistentSessions(
	entries: readonly unknown[],
	options: {
		stateRoot: string;
		ownerParentSessionId: string;
		activeBranchId?: string;
	},
): Map<string, PersistentSessionSnapshot | BlockedRecord> {
	const latest = new Map<string, { record: SessionRecord; order: number; revision: number }>();
	for (const [order, raw] of entries.entries()) {
		const candidate = unwrapSnapshotEntry(raw);
		if (!candidate) continue;
		const sessionId = typeof candidate.sessionId === "string" ? candidate.sessionId : undefined;
		if (!sessionId) continue;
		const branch = branchOf(candidate);
		if (options.activeBranchId !== undefined && branch !== options.activeBranchId) continue;
		const revision = typeof candidate.revision === "number" ? candidate.revision : order;
		const current = latest.get(sessionId);
		if (
			current &&
			(revision < current.revision || (revision === current.revision && order < current.order))
		) {
			continue;
		}

		let record: SessionRecord;
		try {
			if (
				candidate.type !== PERSISTENT_SESSION_STATE_TYPE ||
				candidate.version !== PERSISTENT_SESSION_STATE_VERSION
			) {
				throw new PersistentSessionError(
					"BLOCKED",
					`unsupported persistent session snapshot version for ${sessionId}`,
				);
			}
			record = validateSnapshot(candidate, options.stateRoot);
		} catch (error) {
			record = {
				kind: "blocked",
				sessionId,
				ownerParentSessionId:
					typeof candidate.ownerParentSessionId === "string"
						? candidate.ownerParentSessionId
						: "unknown",
				parentBranchId: branch,
				state: "blocked",
				createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : 0,
				updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
				error: safeDiagnostic(error),
			};
		}
		latest.set(sessionId, { record, order, revision });
	}
	return new Map([...latest.entries()].map(([sessionId, value]) => [sessionId, value.record]));
}

function validateSnapshot(
	raw: Record<string, unknown>,
	stateRoot: string,
): PersistentSessionSnapshot {
	if (typeof raw.ownerParentSessionId !== "string" || typeof raw.sessionId !== "string") {
		throw new PersistentSessionError(
			"INVALID",
			"persistent snapshot is missing owner or session ID",
		);
	}
	const owner = validId(raw.ownerParentSessionId, "owner parent session ID");
	const sessionId = validId(raw.sessionId, "session ID");
	const state = raw.state;
	if (state !== "idle" && state !== "running" && state !== "blocked" && state !== "closed") {
		throw new PersistentSessionError(
			"INVALID",
			`invalid persistent session state for ${sessionId}`,
		);
	}
	if (raw.mode !== "persistent") {
		throw new PersistentSessionError(
			"INVALID",
			`persistent snapshot ${sessionId} has invalid mode`,
		);
	}
	const child = raw.child;
	if (!child || typeof child !== "object")
		throw new PersistentSessionError("INVALID", "missing child session descriptor");
	const childRecord = child as Record<string, unknown>;
	if (childRecord.sessionId !== sessionId || typeof childRecord.sessionDir !== "string") {
		throw new PersistentSessionError("INVALID", `child descriptor does not match ${sessionId}`);
	}
	const paths = derivePersistentSessionPaths(stateRoot, owner, sessionId);
	const childDir = validateContainedRuntimePath(stateRoot, childRecord.sessionDir);
	if (childDir !== paths.sessionDir) {
		throw new PersistentSessionError(
			"INVALID",
			`child session directory is not parent-contained for ${sessionId}`,
		);
	}
	if (!raw.execution || typeof raw.execution !== "object") {
		throw new PersistentSessionError("INVALID", `missing execution contract for ${sessionId}`);
	}
	const execution = raw.execution as PersistentExecutionContract;
	if (
		typeof execution.model !== "string" ||
		execution.model.trim() === "" ||
		!THINKING_LEVELS.includes(execution.thinking as (typeof THINKING_LEVELS)[number]) ||
		!Array.isArray(execution.tools) ||
		execution.tools.length > 200 ||
		execution.tools.some(
			(tool) => typeof tool !== "string" || tool.trim() === "" || tool.length > 200,
		) ||
		(execution.workspace !== "shared" && execution.workspace !== "worktree") ||
		typeof execution.cwd !== "string" ||
		execution.cwd.trim() === "" ||
		typeof execution.projectTrusted !== "boolean" ||
		(execution.readOnly !== undefined && typeof execution.readOnly !== "boolean") ||
		(execution.timeoutMs !== undefined &&
			(typeof execution.timeoutMs !== "number" ||
				!Number.isFinite(execution.timeoutMs) ||
				execution.timeoutMs <= 0 ||
				execution.timeoutMs > MAX_SUBAGENT_TIMEOUT_MS)) ||
		typeof execution.systemPrompt !== "string"
	) {
		throw new PersistentSessionError("INVALID", `invalid execution contract for ${sessionId}`);
	}
	if (execution.worktree !== undefined) {
		if (
			!execution.worktree ||
			typeof execution.worktree !== "object" ||
			typeof execution.worktree.path !== "string" ||
			execution.worktree.path.trim() === "" ||
			typeof execution.worktree.branch !== "string" ||
			execution.worktree.branch.trim() === "" ||
			typeof execution.worktree.repository !== "string" ||
			execution.worktree.repository.trim() === ""
		) {
			throw new PersistentSessionError("INVALID", `invalid worktree metadata for ${sessionId}`);
		}
	}
	if (
		(execution.workspace === "worktree" &&
			(!execution.worktree ||
				path.resolve(execution.cwd) !== path.resolve(execution.worktree.path))) ||
		(execution.workspace === "shared" && execution.worktree !== undefined)
	) {
		throw new PersistentSessionError(
			"INVALID",
			`workspace and worktree contract do not match for ${sessionId}`,
		);
	}
	if (
		raw.latestRunId !== undefined &&
		(typeof raw.latestRunId !== "string" || raw.latestRunId.length === 0)
	) {
		throw new PersistentSessionError("INVALID", `invalid latest run ID for ${sessionId}`);
	}
	if (
		raw.latestTaskId !== undefined &&
		(typeof raw.latestTaskId !== "string" || raw.latestTaskId.length === 0)
	) {
		throw new PersistentSessionError("INVALID", `invalid latest task ID for ${sessionId}`);
	}
	return {
		type: PERSISTENT_SESSION_STATE_TYPE,
		version: PERSISTENT_SESSION_STATE_VERSION,
		revision: typeof raw.revision === "number" ? raw.revision : undefined,
		ownerParentSessionId: owner,
		parentBranchId: branchOf(raw),
		sessionId,
		state,
		mode: "persistent",
		child: { sessionId, sessionDir: childDir },
		execution: {
			...execution,
			tools: [...execution.tools],
			worktree: execution.worktree ? { ...execution.worktree } : undefined,
		},
		latestRunId: typeof raw.latestRunId === "string" ? raw.latestRunId : undefined,
		latestTaskId: typeof raw.latestTaskId === "string" ? raw.latestTaskId : undefined,
		createdAt: finiteTimestamp(raw.createdAt, "createdAt"),
		updatedAt: finiteTimestamp(raw.updatedAt, "updatedAt"),
		error: typeof raw.error === "string" ? safeDiagnostic(raw.error) : undefined,
	};
}

function snapshotView(record: SessionRecord): PersistentSessionView {
	if (!isSnapshot(record)) {
		return {
			sessionId: record.sessionId,
			ownerParentSessionId: record.ownerParentSessionId,
			state: "blocked",
			mode: "persistent",
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			error: record.error,
		};
	}
	return {
		sessionId: record.sessionId,
		ownerParentSessionId: record.ownerParentSessionId,
		state: record.state,
		mode: "persistent",
		model: record.execution.model,
		thinking: record.execution.thinking,
		tools: [...record.execution.tools],
		workspace: record.execution.workspace,
		cwd: record.execution.cwd,
		readOnly: record.execution.readOnly,
		timeoutMs: record.execution.timeoutMs,
		worktree: record.execution.worktree ? { ...record.execution.worktree } : undefined,
		latestRunId: record.latestRunId,
		latestTaskId: record.latestTaskId,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		error: record.error,
	};
}

function readJsonLines(file: string): unknown[] {
	if (!fs.existsSync(file)) return [];
	const content = fs.readFileSync(file, "utf8");
	return content
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as unknown];
			} catch {
				return [];
			}
		});
}

export class PersistentSessionStore {
	readonly stateRoot: string;
	readonly ownerParentSessionId: string;
	activeBranchId?: string;

	private readonly now: () => number;
	private readonly randomNonce: () => string;
	private readonly processHooks: PersistentProcessHooks;
	private readonly appendHook?: (snapshot: PersistentSessionSnapshot) => void;
	private readonly snapshotFile: string;
	private entries: unknown[];
	private records = new Map<string, SessionRecord>();

	constructor(options: PersistentSessionStoreOptions) {
		this.stateRoot = path.resolve(options.stateRoot);
		this.ownerParentSessionId = validId(options.ownerParentSessionId, "owner parent session ID");
		this.activeBranchId = options.activeBranchId;
		this.now = options.now ?? (() => Date.now());
		this.randomNonce = options.randomNonce ?? randomUUID;
		this.processHooks = options.processHooks ?? {};
		this.appendHook = options.appendSnapshot;
		const paths = derivePersistentSessionPaths(
			this.stateRoot,
			this.ownerParentSessionId,
			"placeholder",
		);
		mkdirOwned(this.stateRoot);
		mkdirOwned(path.dirname(paths.parentRoot));
		mkdirOwned(paths.parentRoot);
		mkdirOwned(paths.sessionsRoot);
		mkdirOwned(paths.locksRoot);
		this.snapshotFile = path.join(paths.parentRoot, "session-state.jsonl");
		validateContainedRuntimePath(this.stateRoot, this.snapshotFile);
		// Production snapshots live in the parent session. The local JSONL file is
		// only a fixture fallback when no append hook is supplied.
		this.entries = options.appendSnapshot
			? [...(options.entries ?? options.snapshots ?? [])]
			: [...(options.entries ?? options.snapshots ?? []), ...readJsonLines(this.snapshotFile)];
		this.rebuild();
	}

	private rebuild(): void {
		this.records = reconstructPersistentSessions(this.entries, {
			stateRoot: this.stateRoot,
			ownerParentSessionId: this.ownerParentSessionId,
			activeBranchId: this.activeBranchId,
		});
	}

	/** Replace the branch projection without reading any global or local ledger. */
	refresh(entries: readonly unknown[], activeBranchId?: string): void {
		this.entries = [...entries];
		this.activeBranchId = activeBranchId;
		this.rebuild();
	}

	/** All active-branch sessions owned by this parent as safe bounded views. */
	list(): PersistentSessionView[] {
		return [...this.records.values()]
			.filter((record) => record.ownerParentSessionId === this.ownerParentSessionId)
			.sort((a, b) => a.updatedAt - b.updatedAt)
			.map(snapshotView);
	}

	get(sessionId: string): PersistentSessionView {
		const id = validId(sessionId, "session ID");
		const record = this.records.get(id);
		if (!record) throw new PersistentSessionError("UNKNOWN", `unknown persistent session ${id}`);
		if (record.ownerParentSessionId !== this.ownerParentSessionId) {
			throw new PersistentSessionError(
				"FOREIGN_OWNER",
				`persistent session ${id} belongs to another parent`,
			);
		}
		return snapshotView(record);
	}

	/** Internal snapshot access for later runtime integration. */
	getSnapshot(sessionId: string): PersistentSessionSnapshot {
		const id = validId(sessionId, "session ID");
		const record = this.records.get(id);
		if (!record) throw new PersistentSessionError("UNKNOWN", `unknown persistent session ${id}`);
		if (!isSnapshot(record)) throw new PersistentSessionError("BLOCKED", record.error);
		if (record.ownerParentSessionId !== this.ownerParentSessionId) {
			throw new PersistentSessionError(
				"FOREIGN_OWNER",
				`persistent session ${id} belongs to another parent`,
			);
		}
		return structuredClone(record);
	}

	/** Return the derived child directory without touching or deleting its contents. */
	pathsFor(sessionId: string): PersistentSessionPaths {
		return derivePersistentSessionPaths(this.stateRoot, this.ownerParentSessionId, sessionId);
	}

	prepareChildDirectory(sessionId: string): PersistentChildSession {
		const paths = this.pathsFor(sessionId);
		mkdirOwned(paths.sessionDir);
		return { sessionId, sessionDir: paths.sessionDir };
	}

	append(input: PersistentSessionSnapshotInput): PersistentSessionSnapshot {
		const snapshot = validateSnapshot(
			{
				...input,
				type: input.type,
				version: input.version,
			},
			this.stateRoot,
		);
		if (snapshot.ownerParentSessionId !== this.ownerParentSessionId) {
			throw new PersistentSessionError(
				"FOREIGN_OWNER",
				"persistent session owner does not match this parent",
			);
		}
		if (this.activeBranchId !== undefined && branchOf(snapshot) !== this.activeBranchId) {
			throw new PersistentSessionError(
				"INACTIVE_BRANCH",
				`persistent session ${snapshot.sessionId} is not on the active branch`,
			);
		}
		const revision =
			Math.max(
				0,
				...this.entries.flatMap((entry) => {
					const candidate = unwrapSnapshotEntry(entry);
					const value = candidate?.revision;
					return typeof value === "number" && Number.isFinite(value) ? [value] : [];
				}),
			) + 1;
		const stored = { ...snapshot, revision };
		this.appendHook?.(structuredClone(stored));
		if (!this.appendHook) {
			fs.appendFileSync(this.snapshotFile, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
			try {
				fs.chmodSync(this.snapshotFile, 0o600);
			} catch {
				/* Best effort on platforms without POSIX modes. */
			}
		}
		this.entries.push(stored);
		this.rebuild();
		return structuredClone(stored);
	}

	close(sessionId: string): PersistentSessionSnapshot {
		const current = this.getSnapshot(sessionId);
		if (current.state === "closed") return current;
		if (current.state === "running") {
			throw new PersistentSessionError("BUSY", `persistent session ${sessionId} is running`);
		}
		if (fs.existsSync(this.pathsFor(sessionId).lockDir)) {
			throw new PersistentSessionError(
				"BUSY",
				`persistent session ${sessionId} has an active lock`,
			);
		}
		return this.append({ ...current, state: "closed", updatedAt: this.now() });
	}

	acquireLock(
		sessionId: string,
		metadata: Omit<
			PersistentLockOwner,
			"ownerParentSessionId" | "sessionId" | "nonce" | "acquiredAt"
		> = {
			parentPid: process.pid,
		},
	): PersistentSessionLock {
		const current = this.getSnapshot(sessionId);
		if (current.state === "closed")
			throw new PersistentSessionError("CLOSED", `persistent session ${sessionId} is closed`);
		if (current.state === "blocked")
			throw new PersistentSessionError(
				"BLOCKED",
				current.error ?? `persistent session ${sessionId} is blocked`,
			);
		if (current.state === "running")
			throw new PersistentSessionError("BUSY", `persistent session ${sessionId} is running`);
		const paths = this.pathsFor(sessionId);
		const owner: PersistentLockOwner = {
			...metadata,
			ownerParentSessionId: this.ownerParentSessionId,
			sessionId,
			nonce: this.randomNonce(),
			acquiredAt: this.now(),
		};
		try {
			fs.mkdirSync(paths.lockDir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			this.recoverStaleLock(paths.lockDir, owner);
			fs.mkdirSync(paths.lockDir, { mode: 0o700 });
		}
		let ownerCreated = false;
		try {
			const ownerFile = path.join(paths.lockDir, "owner.json");
			validateContainedRuntimePath(this.stateRoot, ownerFile);
			fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			ownerCreated = true;
			return { sessionId, nonce: owner.nonce, path: paths.lockDir };
		} catch (error) {
			if (ownerCreated) {
				try {
					fs.unlinkSync(path.join(paths.lockDir, "owner.json"));
					fs.rmdirSync(paths.lockDir);
				} catch {
					/* Never remove unknown lock contents after a partial failure. */
				}
			}
			throw error;
		}
	}

	readLockOwner(sessionId: string): PersistentLockOwner | undefined {
		const paths = this.pathsFor(sessionId);
		const ownerFile = path.join(paths.lockDir, "owner.json");
		try {
			const value = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as PersistentLockOwner;
			if (
				typeof value.parentPid !== "number" ||
				!Number.isInteger(value.parentPid) ||
				value.parentPid <= 0 ||
				typeof value.ownerParentSessionId !== "string" ||
				value.ownerParentSessionId !== this.ownerParentSessionId ||
				value.sessionId !== sessionId ||
				typeof value.nonce !== "string" ||
				value.nonce.length === 0 ||
				typeof value.acquiredAt !== "number"
			) {
				throw new Error("invalid lock owner metadata");
			}
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new PersistentSessionError(
				"BLOCKED",
				`cannot read persistent lock owner: ${safeDiagnostic(error)}`,
			);
		}
	}

	/** Update only the matching lease, typically immediately after child spawn. */
	updateLockOwner(
		lock: PersistentSessionLock,
		metadata: Partial<Pick<PersistentLockOwner, "childPid" | "ownerToken" | "parentPid">>,
	): PersistentLockOwner {
		const owner = this.readLockOwner(lock.sessionId);
		if (!owner || owner.nonce !== lock.nonce) {
			throw new PersistentSessionError(
				"BUSY",
				`persistent session ${lock.sessionId} lease changed`,
			);
		}
		const updated: PersistentLockOwner = { ...owner, ...metadata };
		const ownerFile = path.join(this.pathsFor(lock.sessionId).lockDir, "owner.json");
		const temporary = path.join(this.pathsFor(lock.sessionId).lockDir, `.owner-${lock.nonce}.tmp`);
		validateContainedRuntimePath(this.stateRoot, temporary);
		try {
			fs.writeFileSync(temporary, `${JSON.stringify(updated)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			fs.renameSync(temporary, ownerFile);
		} catch (error) {
			try {
				if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
			} catch {
				/* Preserve unknown files if cleanup is not certain. */
			}
			throw new PersistentSessionError(
				"BLOCKED",
				`cannot update persistent lock owner: ${safeDiagnostic(error)}`,
			);
		}
		return updated;
	}

	releaseLock(lock: PersistentSessionLock): boolean {
		const paths = this.pathsFor(lock.sessionId);
		if (path.resolve(lock.path) !== paths.lockDir) return false;
		const ownerFile = path.join(paths.lockDir, "owner.json");
		let owner: Partial<PersistentLockOwner>;
		try {
			const contents = fs.readdirSync(paths.lockDir);
			if (contents.length !== 1 || contents[0] !== "owner.json") return false;
			owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as Partial<PersistentLockOwner>;
		} catch {
			return false;
		}
		if (
			owner.nonce !== lock.nonce ||
			owner.sessionId !== lock.sessionId ||
			owner.ownerParentSessionId !== this.ownerParentSessionId
		) {
			return false;
		}
		try {
			fs.unlinkSync(ownerFile);
			fs.rmdirSync(paths.lockDir);
			return true;
		} catch {
			return false;
		}
	}

	private recoverStaleLock(lockDir: string, requestedOwner: PersistentLockOwner): void {
		const ownerFile = path.join(lockDir, "owner.json");
		let owner: PersistentLockOwner;
		try {
			owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as PersistentLockOwner;
			if (
				owner.sessionId !== requestedOwner.sessionId ||
				owner.ownerParentSessionId !== this.ownerParentSessionId ||
				typeof owner.nonce !== "string"
			) {
				throw new Error("lock owner metadata does not match requested session");
			}
		} catch (error) {
			throw new PersistentSessionError(
				"BLOCKED",
				`cannot verify persistent lock owner: ${safeDiagnostic(error)}`,
			);
		}
		const pids: number[] = [];
		for (const pid of [owner.parentPid, owner.childPid]) {
			if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) pids.push(pid);
		}
		for (const pid of pids) {
			try {
				if ((this.processHooks.isProcessAlive ?? defaultProcessAlive)(pid)) {
					throw new PersistentSessionError(
						"BUSY",
						`persistent session ${owner.sessionId} has a live lock owner`,
					);
				}
			} catch (error) {
				if (error instanceof PersistentSessionError) throw error;
				throw new PersistentSessionError("BLOCKED", `cannot verify lock owner process ${pid}`);
			}
		}
		const cleanup = this.processHooks.cleanupStaleOwner;
		const confirmed = this.processHooks.confirmCleanup;
		if (!cleanup && !confirmed) {
			throw new PersistentSessionError(
				"BLOCKED",
				"stale lock recovery requires confirmed child cleanup",
			);
		}
		try {
			if (cleanup && !cleanup(owner)) throw new Error("stale child cleanup was not confirmed");
			if (confirmed && !confirmed(owner)) throw new Error("process cleanup was not confirmed");
		} catch (error) {
			throw new PersistentSessionError("BLOCKED", safeDiagnostic(error));
		}
		try {
			const contents = fs.readdirSync(lockDir);
			if (contents.length !== 1 || contents[0] !== "owner.json") {
				throw new Error("lock directory contains unknown files");
			}
		} catch (error) {
			throw new PersistentSessionError(
				"BLOCKED",
				`stale lock cannot be quarantined safely: ${safeDiagnostic(error)}`,
			);
		}
		const quarantine = `${lockDir}.stale-${this.randomNonce()}`;
		try {
			fs.renameSync(lockDir, quarantine);
		} catch (error) {
			throw new PersistentSessionError(
				"BUSY",
				`lock changed while recovering: ${safeDiagnostic(error)}`,
			);
		}
		try {
			fs.unlinkSync(path.join(quarantine, "owner.json"));
			fs.rmdirSync(quarantine);
		} catch (error) {
			try {
				if (!fs.existsSync(lockDir) && fs.existsSync(quarantine)) {
					fs.renameSync(quarantine, lockDir);
				}
			} catch {
				/* The caller remains blocked when the quarantine cannot be restored. */
			}
			throw new PersistentSessionError(
				"BLOCKED",
				`stale lock quarantine cleanup failed: ${safeDiagnostic(error)}`,
			);
		}
	}
}

function defaultProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

export type { WorktreeInfo };
