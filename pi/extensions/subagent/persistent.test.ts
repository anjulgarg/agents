import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { PersistentExecutionContract } from "./contracts.ts";
import type { PersistentSessionSnapshotInput } from "./persistent.ts";
import {
	derivePersistentSessionPaths,
	PersistentSessionError,
	PersistentSessionStore,
	validateContainedRuntimePath,
} from "./persistent.ts";

let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
	console.log(
		`${condition ? "PASS" : "FAIL"}: ${name}${condition || !detail ? "" : ` -- ${detail}`}`,
	);
	if (!condition) failed++;
}

function expectError(code: PersistentSessionError["code"], action: () => unknown): boolean {
	try {
		action();
		return false;
	} catch (error) {
		return error instanceof PersistentSessionError && error.code === code;
	}
}

function execution(): PersistentExecutionContract {
	return {
		model: "test/model",
		thinking: "off",
		tools: ["read", "bash"],
		workspace: "shared",
		cwd: "/tmp/project",
		projectTrusted: false,
		systemPrompt: "secret exact system prompt",
	};
}

function snapshot(
	stateRoot: string,
	overrides: Partial<PersistentSessionSnapshotInput> = {},
): PersistentSessionSnapshotInput {
	const owner = overrides.ownerParentSessionId ?? "parent-1";
	const sessionId = overrides.sessionId ?? "child-1";
	return {
		type: "subagent-session-state",
		version: 1,
		ownerParentSessionId: owner,
		parentBranchId: overrides.parentBranchId ?? "branch-main",
		sessionId,
		state: overrides.state ?? "idle",
		mode: "persistent",
		child: {
			sessionId,
			sessionDir:
				overrides.child?.sessionDir ??
				derivePersistentSessionPaths(stateRoot, owner, sessionId).sessionDir,
		},
		execution: overrides.execution ?? execution(),
		latestRunId: overrides.latestRunId,
		latestTaskId: overrides.latestTaskId,
		createdAt: overrides.createdAt ?? 100,
		updatedAt: overrides.updatedAt ?? 100,
		error: overrides.error,
	};
}

function store(root: string, entries?: readonly unknown[]): PersistentSessionStore {
	return new PersistentSessionStore({
		stateRoot: root,
		ownerParentSessionId: "parent-1",
		activeBranchId: "branch-main",
		entries,
		processHooks: { isProcessAlive: () => false },
	});
}

async function main(): Promise<void> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "persistent-subagent-test-"));
	try {
		const initial = snapshot(root, { latestRunId: "run-1", latestTaskId: "task-1" });
		const foreign = snapshot(root, {
			ownerParentSessionId: "parent-2",
			sessionId: "foreign-child",
			child: undefined,
		});
		const inactive = snapshot(root, { sessionId: "old-branch", parentBranchId: "branch-old" });
		const rebuilt = store(root, [initial, foreign, inactive]);
		check(
			"reconstructs only latest active-branch owner records",
			rebuilt.list().length === 1 && rebuilt.list()[0]?.sessionId === "child-1",
			JSON.stringify(rebuilt.list()),
		);
		check(
			"foreign owner is refused",
			expectError("FOREIGN_OWNER", () => rebuilt.get("foreign-child")),
		);
		check(
			"inactive branch is not discoverable",
			expectError("UNKNOWN", () => rebuilt.get("old-branch")),
		);

		const updated = rebuilt.append(snapshot(root, { state: "running", updatedAt: 200 }));
		check(
			"append reconstructs the latest versioned snapshot",
			rebuilt.get("child-1").state === "running" && updated.revision === 1,
			JSON.stringify(rebuilt.get("child-1")),
		);
		check(
			"safe views omit the exact system prompt",
			!JSON.stringify(rebuilt.get("child-1")).includes("secret exact system prompt"),
		);

		check(
			"runtime paths are contained below the injected root",
			validateContainedRuntimePath(root, path.join(root, "subagents", "parent-1")).startsWith(root),
		);
		check(
			"path traversal is rejected",
			expectError("INVALID", () => derivePersistentSessionPaths(root, "parent-1", "../escape")),
		);
		check(
			"escaping child directory is rejected",
			expectError("INVALID", () =>
				rebuilt.append(
					snapshot(root, {
						child: { sessionId: "child-1", sessionDir: path.join(root, "..", "escape") },
					}),
				),
			),
		);
		check(
			"mismatched worktree contracts are rejected",
			expectError("INVALID", () =>
				rebuilt.append(
					snapshot(root, {
						execution: {
							...execution(),
							workspace: "worktree",
							cwd: "/tmp/worktree-a",
							worktree: {
								path: "/tmp/worktree-b",
								branch: "test-branch",
								repository: "/tmp/repository",
							},
						},
					}),
				),
			),
		);

		const lockStore = store(root);
		lockStore.append(snapshot(root, { state: "idle", updatedAt: 300 }));
		const firstLock = lockStore.acquireLock("child-1", { parentPid: 999 });
		const liveRefusal = new PersistentSessionStore({
			stateRoot: root,
			ownerParentSessionId: "parent-1",
			activeBranchId: "branch-main",
			processHooks: { isProcessAlive: () => true },
		});
		check(
			"live lock owner is never stolen",
			expectError("BUSY", () => liveRefusal.acquireLock("child-1")),
		);

		const unconfirmed = new PersistentSessionStore({
			stateRoot: root,
			ownerParentSessionId: "parent-1",
			activeBranchId: "branch-main",
			processHooks: { isProcessAlive: () => false },
		});
		check(
			"stale lock recovery fails closed without confirmed cleanup",
			expectError("BLOCKED", () => unconfirmed.acquireLock("child-1", { parentPid: 999 })),
		);
		const recovered = new PersistentSessionStore({
			stateRoot: root,
			ownerParentSessionId: "parent-1",
			activeBranchId: "branch-main",
			processHooks: {
				isProcessAlive: () => false,
				cleanupStaleOwner: () => true,
				confirmCleanup: () => true,
			},
		});
		const recoveredLock = recovered.acquireLock("child-1", { parentPid: 999 });
		check("stale lock recovers only after confirmed cleanup", recoveredLock.nonce.length > 0);
		check(
			"wrong nonce cannot release a lock",
			!recovered.releaseLock({ ...recoveredLock, nonce: "wrong" }),
		);
		const unknownLockFile = path.join(recoveredLock.path, "unknown-lock-file");
		await fs.promises.writeFile(unknownLockFile, "preserve", "utf8");
		check(
			"lock release preserves unknown files and ownership metadata",
			!recovered.releaseLock(recoveredLock) &&
				fs.existsSync(unknownLockFile) &&
				fs.existsSync(path.join(recoveredLock.path, "owner.json")),
		);
		await fs.promises.rm(unknownLockFile);
		check("matching nonce releases the lock", recovered.releaseLock(recoveredLock));
		check("replaced stale lock cannot release the new lease", !lockStore.releaseLock(firstLock));

		const staleWithUnknown = recovered.acquireLock("child-1", { parentPid: 999 });
		const staleUnknownFile = path.join(staleWithUnknown.path, "unknown-stale-file");
		await fs.promises.writeFile(staleUnknownFile, "preserve", "utf8");
		const unknownRecovery = new PersistentSessionStore({
			stateRoot: root,
			ownerParentSessionId: "parent-1",
			activeBranchId: "branch-main",
			processHooks: {
				isProcessAlive: () => false,
				cleanupStaleOwner: () => true,
				confirmCleanup: () => true,
			},
		});
		check(
			"stale recovery preserves unknown lock files and stays blocked",
			expectError("BLOCKED", () => unknownRecovery.acquireLock("child-1")) &&
				fs.existsSync(staleUnknownFile) &&
				fs.existsSync(path.join(staleWithUnknown.path, "owner.json")),
		);
		await fs.promises.rm(staleUnknownFile);
		check("owned stale fixture lock can be released", recovered.releaseLock(staleWithUnknown));

		const closeStore = store(root);
		const childDir = closeStore.prepareChildDirectory("child-1").sessionDir;
		const transcript = path.join(childDir, "child.jsonl");
		const unknown = path.join(childDir, "unknown-runtime-file");
		await fs.promises.writeFile(transcript, "conversation", "utf8");
		await fs.promises.writeFile(unknown, "preserve me", "utf8");
		const closed = closeStore.close("child-1");
		check("logical close preserves the transcript and unknown files", closed.state === "closed");
		check(
			"logical close does not delete runtime files",
			fs.existsSync(transcript) && fs.readFileSync(unknown, "utf8") === "preserve me",
		);
		check(
			"closed session cannot be resumed",
			expectError("CLOSED", () => closeStore.acquireLock("child-1")),
		);
		check(
			"tests use a temporary injected state root",
			closeStore.stateRoot === path.resolve(root) &&
				!closeStore.stateRoot.includes(path.join(".pi", "agent")),
		);
	} finally {
		await fs.promises.rm(root, { recursive: true, force: true });
	}

	if (failed > 0) {
		console.log(`\n${failed} persistent session test(s) FAILED`);
		process.exit(1);
	}
	console.log("\nAll persistent session tests passed");
}

void main();
