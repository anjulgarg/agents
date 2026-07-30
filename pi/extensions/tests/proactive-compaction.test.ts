import proactiveCompaction, {
	CONTINUATION_PROMPT,
	hasCompactionCandidate,
	proactiveCompactionThreshold,
} from "../proactive-compaction.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

assert(
	"compaction continuation promotes open todos to the active work queue",
	CONTINUATION_PROMPT.includes("Treat open todos as the active work queue") &&
		CONTINUATION_PROMPT.includes("autonomously start the next unverified item"),
	CONTINUATION_PROMPT,
);

type CompactOptions = {
	onComplete?: () => void;
	onError?: (error: Error) => void;
};

function messageEntry(id: string, role: string, content: unknown): any {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role, content, timestamp: 0 },
	};
}

const oversizedToolTail = [
	messageEntry("user", "user", "inspect the repository"),
	messageEntry("assistant", "assistant", [
		{
			type: "toolCall",
			id: "call",
			name: "read",
			arguments: { path: "large.txt" },
		},
	]),
	messageEntry("result", "toolResult", [{ type: "text", text: "x".repeat(84_000) }]),
];
const eligibleBranch = [...oversizedToolTail, messageEntry("next-user", "user", "continue")];

function setup(tokens: number | null, contextWindow: number, branch: any[] = eligibleBranch) {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const sent: Array<{ message: any; options: any }> = [];
	const compactCalls: CompactOptions[] = [];
	const notices: Array<{ message: string; level: string }> = [];
	let currentTokens = tokens;

	proactiveCompaction({
		on: (event: string, handler: (event: any, ctx: any) => void) => handlers.set(event, handler),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	} as any);

	const ctx = {
		getContextUsage: () => ({ tokens: currentTokens, contextWindow, percent: null }),
		compact: (options: CompactOptions) => compactCalls.push(options),
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
		},
	};
	const turnEnd = (toolResults: any[] = [{}]) => handlers.get("turn_end")?.({ toolResults }, ctx);
	const compact = (event: any) => handlers.get("session_compact")?.(event, ctx);

	return {
		compactCalls,
		compact,
		notices,
		sent,
		setTokens: (value: number | null) => {
			currentTokens = value;
		},
		turnEnd,
	};
}

assert(
	"recognizes a tool-result tail without a legal compaction cut point",
	!hasCompactionCandidate(oversizedToolTail, 20_000),
	JSON.stringify(oversizedToolTail.map((entry) => entry.message.role)),
);
assert(
	"recognizes a candidate after a newer turn supplies a legal cut point",
	hasCompactionCandidate(eligibleBranch, 20_000),
	JSON.stringify(eligibleBranch.map((entry) => entry.message.role)),
);

const blockedTail = setup(99_999, 100_000, oversizedToolTail);
blockedTail.turnEnd();
assert(
	"does not request compaction when Pi has no eligible history",
	blockedTail.compactCalls.length === 0 && blockedTail.notices.length === 0,
	JSON.stringify({ calls: blockedTail.compactCalls.length, notices: blockedTail.notices }),
);

const smallBoundary = setup(80_000, 100_000);
smallBoundary.turnEnd();
assert(
	"does not trigger at the smaller-context boundary",
	smallBoundary.compactCalls.length === 0,
	JSON.stringify(smallBoundary.compactCalls),
);
smallBoundary.setTokens(80_001);
smallBoundary.turnEnd();
assert(
	"triggers one token above the smaller-context boundary",
	smallBoundary.compactCalls.length === 1,
	JSON.stringify(smallBoundary.compactCalls),
);

const largeBoundary = setup(168_000, 200_000);
largeBoundary.turnEnd();
assert(
	"leaves 32,000 tokens for a large context",
	proactiveCompactionThreshold(200_000) === 168_000 && largeBoundary.compactCalls.length === 0,
	JSON.stringify(largeBoundary.compactCalls),
);
largeBoundary.setTokens(168_001);
largeBoundary.turnEnd();
assert(
	"triggers above the large-context boundary",
	largeBoundary.compactCalls.length === 1,
	JSON.stringify(largeBoundary.compactCalls),
);

const finalAnswer = setup(99_999, 100_000);
finalAnswer.turnEnd([]);
assert(
	"does not trigger for a final answer without tool calls",
	finalAnswer.compactCalls.length === 0,
	JSON.stringify(finalAnswer.compactCalls),
);

const alreadyHigh = setup(99_999, 100_000);
alreadyHigh.turnEnd();
assert(
	"triggers an already-high session without threshold-crossing state",
	alreadyHigh.compactCalls.length === 1,
	JSON.stringify(alreadyHigh.compactCalls),
);

const deduplicated = setup(99_999, 100_000);
deduplicated.turnEnd();
deduplicated.turnEnd();
assert(
	"deduplicates concurrent proactive compactions",
	deduplicated.compactCalls.length === 1,
	JSON.stringify(deduplicated.compactCalls),
);
deduplicated.compactCalls[0]?.onError?.(new Error("test failure"));
deduplicated.turnEnd();
assert(
	"reports failure and allows a later proactive retry",
	deduplicated.compactCalls.length === 2 &&
		deduplicated.sent.length === 0 &&
		deduplicated.notices.length === 1 &&
		deduplicated.notices[0]?.level === "error" &&
		deduplicated.notices[0]?.message.includes("test failure"),
	JSON.stringify({ calls: deduplicated.compactCalls.length, notices: deduplicated.notices }),
);

const benignNoOp = setup(99_999, 100_000);
benignNoOp.turnEnd();
benignNoOp.compactCalls[0]?.onError?.(new Error("Nothing to compact (session too small)"));
assert(
	"does not duplicate Pi's benign no-op compaction error",
	benignNoOp.notices.length === 0,
	JSON.stringify(benignNoOp.notices),
);

const successful = setup(99_999, 100_000);
successful.turnEnd();
const completion = successful.compactCalls[0]?.onComplete;
completion?.();
completion?.();
successful.compact({ reason: "manual", willRetry: false });
assert(
	"continues exactly once after successful extension compaction",
	successful.sent.length === 1 &&
		successful.sent[0]?.message.content === CONTINUATION_PROMPT &&
		successful.sent[0]?.message.display === false &&
		successful.sent[0]?.options.triggerTurn === true &&
		successful.sent[0]?.options.deliverAs === "followUp",
	JSON.stringify(successful.sent),
);

const nativeOverlap = setup(99_999, 100_000);
nativeOverlap.turnEnd();
nativeOverlap.compact({ reason: "threshold", willRetry: false });
assert(
	"defers overlapping native continuation until proactive compaction settles",
	nativeOverlap.sent.length === 0,
	JSON.stringify(nativeOverlap.sent),
);
nativeOverlap.compactCalls[0]?.onError?.(new Error("Already compacted"));
nativeOverlap.compactCalls[0]?.onComplete?.();
assert(
	"deduplicates overlapping native and proactive continuation paths",
	nativeOverlap.sent.length === 1 && nativeOverlap.notices.length === 0,
	JSON.stringify({ sent: nativeOverlap.sent, notices: nativeOverlap.notices }),
);

const nativeRetryOverlap = setup(99_999, 100_000);
nativeRetryOverlap.turnEnd();
nativeRetryOverlap.compact({ reason: "overflow", willRetry: true });
nativeRetryOverlap.compactCalls[0]?.onError?.(new Error("Already compacted"));
assert(
	"does not continue when overlapping native compaction retries in core",
	nativeRetryOverlap.sent.length === 0 && nativeRetryOverlap.notices.length === 0,
	JSON.stringify({ sent: nativeRetryOverlap.sent, notices: nativeRetryOverlap.notices }),
);

const userManual = setup(50_000, 100_000);
userManual.compact({ reason: "manual", willRetry: false });
assert(
	"does not resume after user manual compaction",
	userManual.sent.length === 0,
	JSON.stringify(userManual.sent),
);

const native = setup(50_000, 100_000);
native.compact({ reason: "manual", willRetry: false });
native.compact({ reason: "overflow", willRetry: true });
native.compact({ reason: "threshold", willRetry: false });
native.compact({ reason: "overflow", willRetry: false });
assert(
	"preserves native compaction continuation events",
	native.sent.length === 2 &&
		native.sent.every(
			({ message, options }) =>
				message.content === CONTINUATION_PROMPT &&
				message.display === false &&
				options.triggerTurn === true &&
				options.deliverAs === "followUp",
		),
	JSON.stringify(native.sent),
);
