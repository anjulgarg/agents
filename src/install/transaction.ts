import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	OperationContext,
	OperationEvent,
	OperationPlan,
	OperationResult,
} from "./contracts.ts";
import { AgentsError } from "./contracts.ts";
import { assertSnapshotEqual, getPlanInternal, readSnapshot, type Snapshot } from "./planner.ts";
import { validateDestination, validateSafeRoots } from "./safety.ts";

async function materialize(path: string, value: Snapshot): Promise<void> {
	if (value.kind === "absent") return;
	if (value.kind === "file") {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, value.data, { mode: value.mode });
		return;
	}
	await mkdir(path, { recursive: true, mode: value.mode });
	for (const [relative, file] of value.files) {
		const target = join(path, ...relative.split("/"));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.data, { mode: file.mode });
	}
}

function fail(context: OperationContext, phase: string): void {
	if (context.failureInjection?.phase === phase) throw new Error(`Injected failure: ${phase}`);
}

export async function applyPlan(
	context: OperationContext,
	plan: OperationPlan,
): Promise<OperationResult> {
	const internal = getPlanInternal(plan);
	if (!internal)
		throw new AgentsError("transaction-failed", "Plan was not created by this process.");
	const roots = await validateSafeRoots(context.home, context.sourceRoot);
	if (roots.home !== internal.home || roots.sourceRoot !== internal.sourceRoot)
		throw new AgentsError("unsafe-path", "Plan context changed before apply.");
	for (const change of plan.changes)
		await validateDestination(roots.home, change.path, roots.sourceRoot);

	const operationId = context.operationId?.() ?? randomUUID();
	const events: OperationEvent[] = [];
	const started = Date.now();
	const emit = (name: OperationEvent["name"], errorCode?: OperationEvent["errorCode"]): void => {
		const event = {
			name,
			operationId,
			componentIds: plan.resolved,
			count: plan.changes.length,
			durationMs: Date.now() - started,
			...(errorCode ? { errorCode } : {}),
		};
		events.push(event);
		context.emit?.(event);
	};
	const agents = join(roots.home, ".agents");
	let agentsExisted = true;
	try {
		await lstat(agents);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") agentsExisted = false;
		else throw error;
	}
	await mkdir(agents, { recursive: true });
	const lockPath = join(agents, ".operation.lock");
	let lock;
	try {
		lock = await open(lockPath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new AgentsError(
				"operation-in-progress",
				"Another agents operation is in progress.",
				undefined,
				{ cause: error },
			);
		throw error;
	}
	const transactionRoot = join(agents, ".transactions", operationId);
	const backupRoot = join(transactionRoot, "backup");
	const stageRoot = join(transactionRoot, "stage");
	const committed: string[] = [];
	try {
		for (const [path, before] of internal.before)
			if (!assertSnapshotEqual(await readSnapshot(path), before))
				throw new AgentsError("transaction-failed", "Managed state changed after planning.");
		emit("agents.transaction.start");
		await mkdir(backupRoot, { recursive: true });
		await mkdir(stageRoot, { recursive: true });
		fail(context, "after-lock");
		const ordered = [...plan.changes].sort((a, b) =>
			a.path === internal.receiptPath
				? 1
				: b.path === internal.receiptPath
					? -1
					: a.path.localeCompare(b.path),
		);
		for (const [index, change] of ordered.entries()) {
			const desired = internal.desired.get(change.path)!;
			await materialize(join(stageRoot, String(index)), desired);
		}
		await writeFile(
			join(transactionRoot, "journal.json"),
			JSON.stringify(
				{ operationId, paths: ordered.map(({ path }) => path), receiptLast: true },
				null,
				2,
			) + "\n",
			{ mode: 0o600 },
		);
		fail(context, "after-stage");
		for (const [index, change] of ordered.entries()) {
			const before = internal.before.get(change.path)!;
			if (before.kind !== "absent")
				await cp(change.path, join(backupRoot, String(index)), {
					recursive: true,
					preserveTimestamps: true,
				});
		}
		fail(context, "after-backup");
		for (const [index, change] of ordered.entries()) {
			await rm(change.path, { recursive: true, force: true });
			const wanted = internal.desired.get(change.path)!;
			if (wanted.kind !== "absent") {
				await mkdir(dirname(change.path), { recursive: true });
				await rename(join(stageRoot, String(index)), change.path);
			}
			committed.push(change.path);
			if (context.failureInjection?.phase === "during-commit" && committed.length === 1)
				fail(context, "during-commit");
		}
		fail(context, "after-receipt");
		emit("agents.transaction.commit");
		await rm(transactionRoot, { recursive: true, force: true });
		return { operationId, changed: plan.changes.length, receiptPath: internal.receiptPath, events };
	} catch (error) {
		let rollbackError: unknown;
		try {
			if (context.failureInjection?.rollback)
				throw new Error("Injected rollback failure", { cause: error });
			const ordered = [...plan.changes].sort((a, b) =>
				a.path === internal.receiptPath
					? 1
					: b.path === internal.receiptPath
						? -1
						: a.path.localeCompare(b.path),
			);
			for (const path of [...committed].reverse()) {
				const index = ordered.findIndex((change) => change.path === path);
				await rm(path, { recursive: true, force: true });
				const before = internal.before.get(path)!;
				if (before.kind !== "absent") {
					await mkdir(dirname(path), { recursive: true });
					await cp(join(backupRoot, String(index)), path, {
						recursive: true,
						preserveTimestamps: true,
					});
				}
			}
			emit("agents.transaction.rollback", "transaction-failed");
			await rm(transactionRoot, { recursive: true, force: true });
		} catch (caught) {
			rollbackError = caught;
		}
		if (rollbackError) {
			emit("agents.transaction.rollback", "rollback-failed");
			throw new AgentsError(
				"rollback-failed",
				`Rollback failed. Recovery backup retained at ${backupRoot}.`,
				backupRoot,
				{ cause: rollbackError },
			);
		}
		throw new AgentsError(
			"transaction-failed",
			"Transaction failed and all managed paths were restored.",
			undefined,
			{ cause: error },
		);
	} finally {
		await lock.close().catch(() => undefined);
		await rm(lockPath, { force: true }).catch(() => undefined);
		await rmdir(join(agents, ".transactions")).catch(() => undefined);
		if (!agentsExisted) await rmdir(agents).catch(() => undefined);
	}
}
