import {
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	sessionEntryToContextMessages,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const CONTINUATION_PROMPT = `Automatic context compaction completed. Reassess active work, current state, and open todo items. Treat open todos as the active work queue: reconcile verified items, then autonomously start the next unverified item after the current user request unless it conflicts or requires material user input. Continue working autonomously unless you need user input. If nothing remains, respond only with a brief completion confirmation.`;

export const PROACTIVE_HEADROOM_TOKENS = 32_000;

export function proactiveCompactionThreshold(contextWindow: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return Number.POSITIVE_INFINITY;

	const headroom = Math.min(PROACTIVE_HEADROOM_TOKENS, contextWindow * 0.2);
	return contextWindow - headroom;
}

export function shouldProactivelyCompact(contextTokens: number, contextWindow: number): boolean {
	return (
		Number.isFinite(contextTokens) && contextTokens > proactiveCompactionThreshold(contextWindow)
	);
}

// ctx.compact() reports an error when Pi's cut-point rules leave nothing to
// summarize, even if provider usage is above the threshold. Mirror that
// eligibility check before starting the detached compaction.
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
	let proactiveCompactionInFlight = false;
	let proactiveContinuationSent = false;
	let nativeOutcomeDuringProactive: "continue" | "retry" | undefined;
	let keepRecentTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;

	const finishProactiveCompaction = () => {
		if (!proactiveCompactionInFlight || proactiveContinuationSent) return;

		const shouldContinue = nativeOutcomeDuringProactive !== "retry";
		proactiveContinuationSent = true;
		proactiveCompactionInFlight = false;
		nativeOutcomeDuringProactive = undefined;
		if (shouldContinue) sendContinuation(pi);
	};

	const failProactiveCompaction = (ctx: ExtensionContext, error: unknown) => {
		if (!proactiveCompactionInFlight) return;

		const nativeOutcome = nativeOutcomeDuringProactive;
		proactiveCompactionInFlight = false;
		proactiveContinuationSent = nativeOutcome !== undefined;
		nativeOutcomeDuringProactive = undefined;
		if (nativeOutcome === "continue") {
			sendContinuation(pi);
			return;
		}
		if (nativeOutcome === "retry") return;

		const message = error instanceof Error ? error.message : String(error);
		if (message === "Nothing to compact (session too small)" || message === "Already compacted") {
			return;
		}
		ctx.ui.notify(`Proactive compaction failed: ${message}`, "error");
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			keepRecentTokens = SettingsManager.create(ctx.cwd, undefined, {
				projectTrusted: ctx.isProjectTrusted(),
			}).getCompactionKeepRecentTokens();
		} catch {
			keepRecentTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
		}
	});

	pi.on("turn_end", (event, ctx) => {
		// A turn with tool results will otherwise continue through the agent loop.
		// A final assistant answer has no tool results and must not trigger this.
		if (event.toolResults.length === 0 || proactiveCompactionInFlight) return;

		const usage = ctx.getContextUsage();
		if (
			!usage ||
			usage.tokens === null ||
			!shouldProactivelyCompact(usage.tokens, usage.contextWindow)
		) {
			return;
		}
		if (!hasCompactionCandidate(ctx.sessionManager.getBranch(), keepRecentTokens)) return;

		proactiveCompactionInFlight = true;
		proactiveContinuationSent = false;
		nativeOutcomeDuringProactive = undefined;
		try {
			ctx.compact({
				onComplete: finishProactiveCompaction,
				onError: (error) => failProactiveCompaction(ctx, error),
			});
		} catch (error) {
			failProactiveCompaction(ctx, error);
		}
	});

	pi.on("session_compact", (event) => {
		// Manual compactions are handled only by the proactive compact callback,
		// so user-issued /compact never resumes the agent.
		if (event.reason === "manual") return;

		// A large tool result can cross Pi's native threshold while proactive
		// compaction is aborting the loop. Defer that continuation until the
		// manual compact callback settles so the two paths cannot resume twice.
		if (proactiveCompactionInFlight) {
			nativeOutcomeDuringProactive = event.willRetry ? "retry" : "continue";
			return;
		}

		// Native overflow recovery retries in core. Native threshold and
		// non-retrying overflow compactions need the established follow-up.
		if (!event.willRetry) sendContinuation(pi);
	});
}
