import {
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	sessionEntryToContextMessages,
	SettingsManager,
	type ContextEvent,
	type ExtensionAPI,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const CONTINUATION_PROMPT = `Automatic context compaction completed. Reassess active work, current state, and open todo items. Treat open todos as the active work queue: reconcile verified items, then autonomously start the next unverified item after the current user request unless it conflicts or requires material user input. Continue working autonomously unless you need user input. If nothing remains, respond only with a brief completion confirmation.`;

export const CONTEXT_GUARD_HEADROOM_TOKENS = 32_000;
export const EMERGENCY_TOOL_RESULT_TEXT_CHARS = 48_000;

const EMERGENCY_TRUNCATION_MARKER =
	"temporarily omitted from this request; full result remains in the session";

type ContextMessage = ContextEvent["messages"][number];

function truncateEmergencyText(text: string, maxSourceChars: number): string {
	if (text.length <= maxSourceChars) return text;

	const keptChars = Math.max(0, maxSourceChars);
	const omittedChars = text.length - keptChars;
	const marker = `\n...[${omittedChars.toLocaleString()} characters ${EMERGENCY_TRUNCATION_MARKER}]...\n`;
	if (keptChars === 0) return marker.trim();

	const headChars = Math.ceil(keptChars / 2);
	const tailChars = Math.floor(keptChars / 2);
	return `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(-tailChars) : ""}`;
}

export function protectOversizedToolResults(
	messages: ContextEvent["messages"],
	maxTextChars = EMERGENCY_TOOL_RESULT_TEXT_CHARS,
): ContextEvent["messages"] {
	let remainingChars = Math.max(0, Math.floor(maxTextChars));
	let changed = false;
	const protectedMessages = [...messages];

	// Preserve the newest tool output first. Older tool results are still retained
	// in the session and will be available to the compaction summary.
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult") continue;

		const content = message.content;
		let contentChanged = false;
		const protectedContent = content.map((block) => {
			if (block.type !== "text") return block;

			const keptChars = Math.min(block.text.length, remainingChars);
			remainingChars -= keptChars;
			const text = truncateEmergencyText(block.text, keptChars);
			if (text === block.text) return block;
			contentChanged = true;
			return { ...block, text };
		});
		if (contentChanged) {
			protectedMessages[index] = { ...message, content: protectedContent } as ContextMessage;
			changed = true;
		}
	}

	return changed ? protectedMessages : messages;
}

export function contextGuardThreshold(contextWindow: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return Number.POSITIVE_INFINITY;

	const headroom = Math.min(CONTEXT_GUARD_HEADROOM_TOKENS, contextWindow * 0.2);
	return contextWindow - headroom;
}

export function shouldGuardContext(contextTokens: number, contextWindow: number): boolean {
	return Number.isFinite(contextTokens) && contextTokens > contextGuardThreshold(contextWindow);
}

// Pi cannot compact when its cut-point rules leave nothing to summarize.
// Mirror that eligibility check before activating temporary context protection.
export function hasCompactionCandidate(entries: SessionEntry[], keepRecentTokens: number): boolean {
	if (entries.length === 0 || entries.at(-1)?.type === "compaction") return false;

	let previousCompactionIndex = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.type === "compaction") {
			previousCompactionIndex = index;
			break;
		}
	}

	let boundaryStart = 0;
	if (previousCompactionIndex >= 0) {
		const previousCompaction = entries[previousCompactionIndex];
		if (previousCompaction?.type !== "compaction") return false;

		const firstKeptIndex = entries.findIndex(
			(entry) => entry.id === previousCompaction.firstKeptEntryId,
		);
		boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : previousCompactionIndex + 1;
	}

	const cutPoint = findCutPoint(entries, boundaryStart, entries.length, keepRecentTokens);
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const hasContextMessages = (start: number, end: number) => {
		for (let index = start; index < end; index++) {
			const entry = entries[index]!;
			if (entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0) {
				return true;
			}
		}
		return false;
	};

	return (
		hasContextMessages(boundaryStart, historyEnd) ||
		(cutPoint.isSplitTurn &&
			hasContextMessages(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex))
	);
}

function sendContinuation(pi: ExtensionAPI): void {
	pi.sendMessage(
		{
			customType: "compaction-continuation",
			content: CONTINUATION_PROMPT,
			display: false,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

export default function (pi: ExtensionAPI) {
	let protectOutgoingContext = false;
	let keepRecentTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;

	const clearContextGuard = () => {
		protectOutgoingContext = false;
	};

	pi.on("session_start", (_event, ctx) => {
		clearContextGuard();
		try {
			keepRecentTokens = SettingsManager.create(ctx.cwd, undefined, {
				projectTrusted: ctx.isProjectTrusted(),
			}).getCompactionKeepRecentTokens();
		} catch {
			keepRecentTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
		}
	});

	pi.on("turn_end", (event, ctx) => {
		// Pi owns compaction. This extension only protects an active tool loop when
		// Pi cannot safely compact yet or the provider reports an overflowed context.
		if (event.toolResults.length === 0) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !shouldGuardContext(usage.tokens, usage.contextWindow)) {
			return;
		}

		const hasCandidate = hasCompactionCandidate(ctx.sessionManager.getBranch(), keepRecentTokens);
		protectOutgoingContext ||= !hasCandidate || usage.tokens > usage.contextWindow;
	});

	pi.on("context", (event) => {
		if (!protectOutgoingContext) return;

		const messages = protectOversizedToolResults(event.messages);
		return messages === event.messages ? undefined : { messages };
	});

	pi.on("agent_settled", clearContextGuard);
	pi.on("session_shutdown", clearContextGuard);

	pi.on("session_compact", (event) => {
		clearContextGuard();
		if (event.reason === "manual") return;

		// Native overflow recovery retries in core. Native threshold and
		// non-retrying overflow compactions need the established follow-up.
		if (!event.willRetry) sendContinuation(pi);
	});
}
