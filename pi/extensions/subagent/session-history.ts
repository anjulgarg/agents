import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

import type { PersistentChildSession, UsageStats } from "./contracts.ts";
import { emptyUsage } from "./rpc-client.ts";

type SessionEntry = ReturnType<SessionManager["getBranch"]>[number];

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface PersistentThreadHistory {
	messages: Message[];
	/** Usage carried by compaction or branch-summary entries rather than messages. */
	nonMessageUsage: UsageStats;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function absorbUsage(target: UsageStats, usage: UsageLike | undefined, turn = false): void {
	if (!usage) return;
	target.input += finite(usage.input);
	target.output += finite(usage.output);
	target.cacheRead += finite(usage.cacheRead);
	target.cacheWrite += finite(usage.cacheWrite);
	target.cost += finite(usage.cost?.total);
	if (turn) target.turns++;
}

function isRenderableMessage(message: unknown): message is Message {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "user" || role === "assistant" || role === "toolResult";
}

function historyFromEntries(entries: readonly SessionEntry[]): PersistentThreadHistory {
	const messages: Message[] = [];
	const nonMessageUsage = emptyUsage();
	for (const entry of entries) {
		if (entry.type === "message") {
			if (isRenderableMessage(entry.message)) messages.push(entry.message);
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			absorbUsage(nonMessageUsage, entry.usage);
		}
	}
	return { messages, nonMessageUsage };
}

/** Load the exact active branch from a durable persistent child conversation. */
export async function loadPersistentThreadHistory(
	child: PersistentChildSession,
): Promise<PersistentThreadHistory | undefined> {
	const sessions = await SessionManager.listAll(child.sessionDir);
	const exact = sessions.find((session) => session.id === child.sessionId);
	if (!exact) return undefined;
	const manager = SessionManager.open(exact.path, child.sessionDir);
	return historyFromEntries(manager.getBranch());
}

function messageIdentity(message: Message, fallback: string): string {
	const timestamp = finite(message.timestamp);
	if (timestamp === 0) return fallback;
	const toolCallId = message.role === "toolResult" ? message.toolCallId : "";
	return `${message.role}:${timestamp}:${toolCallId}`;
}

/** Merge durable completed messages with the current RPC process's live projection. */
export function mergePersistentMessages(
	durable: readonly Message[],
	live: readonly Message[] = [],
): Message[] {
	const merged = new Map<string, Message>();
	for (const [index, message] of durable.entries()) {
		merged.set(messageIdentity(message, `durable:${index}`), message);
	}
	for (const [index, message] of live.entries()) {
		const key = messageIdentity(message, `live:${index}`);
		const existing = merged.get(key);
		if (
			existing?.role === "assistant" &&
			existing.stopReason !== "pending" &&
			message.role === "assistant" &&
			message.stopReason === "pending"
		) {
			continue;
		}
		merged.set(key, message);
	}
	return [...merged.values()];
}

/** Recompute cumulative usage from the merged transcript plus non-message session work. */
export function cumulativePersistentUsage(
	messages: readonly Message[],
	nonMessageUsage: UsageStats = emptyUsage(),
): UsageStats {
	const usage = { ...nonMessageUsage };
	for (const message of messages) {
		if (message.role === "assistant") absorbUsage(usage, message.usage, true);
		else if (message.role === "toolResult") absorbUsage(usage, message.usage);
	}
	return usage;
}
