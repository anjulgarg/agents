import proactiveCompaction, {
	CONTINUATION_PROMPT,
	hasCompactionCandidate,
	protectOversizedToolResults,
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

function contextMessage(role: string, content: unknown): any {
	return { role, content, timestamp: 0 };
}

const oversizedToolText = "x".repeat(84_000);
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
	messageEntry("result", "toolResult", [{ type: "text", text: oversizedToolText }]),
];
const eligibleBranch = [...oversizedToolTail, messageEntry("next-user", "user", "continue")];
const settledBranch = [
	...oversizedToolTail,
	messageEntry("final-assistant", "assistant", [{ type: "text", text: "I can continue." }]),
];

function setup(tokens: number | null, contextWindow: number, branch: any[] = eligibleBranch) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const sent: Array<{ message: any; options: any }> = [];
	const compactCalls: CompactOptions[] = [];
	const notices: Array<{ message: string; level: string }> = [];
	let currentTokens = tokens;
	let currentBranch = branch;

	proactiveCompaction({
		on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, handler),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	} as any);

	const ctx = {
		getContextUsage: () => ({ tokens: currentTokens, contextWindow, percent: null }),
		compact: (options: CompactOptions) => compactCalls.push(options),
		sessionManager: { getBranch: () => currentBranch },
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
		},
	};
	const turnEnd = (toolResults: any[] = [{}]) => handlers.get("turn_end")?.({ toolResults }, ctx);
	const settled = () => handlers.get("agent_settled")?.({}, ctx);
	const compact = (event: any) => handlers.get("session_compact")?.(event, ctx);
	const protect = (messages: any[]) => handlers.get("context")?.({ messages }, ctx);

	return {
		compactCalls,
		compact,
		notices,
		protect,
		sent,
		settled,
		setBranch: (value: any[]) => {
			currentBranch = value;
		},
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
	"recognizes a candidate after a newer boundary supplies a legal cut point",
	hasCompactionCandidate(eligibleBranch, 20_000) && hasCompactionCandidate(settledBranch, 20_000),
	JSON.stringify(settledBranch.map((entry) => entry.message.role)),
);

const protectedSource = [
	contextMessage("toolResult", [{ type: "text", text: "a".repeat(20) }]),
	contextMessage("assistant", [{ type: "text", text: "between" }]),
	contextMessage("toolResult", [{ type: "text", text: "b".repeat(20) }]),
];
const protectedMessages = protectOversizedToolResults(protectedSource, 25);
assert(
	"protects outgoing context without mutating stored messages",
	protectedMessages !== protectedSource &&
		(protectedMessages[0] as any).content[0].text.includes("full result remains in the session") &&
		(protectedMessages[2] as any).content[0].text === "b".repeat(20) &&
		(protectedSource[0] as any).content[0].text === "a".repeat(20),
	JSON.stringify(protectedMessages),
);

const blockedTail = setup(100_001, 100_000, oversizedToolTail);
blockedTail.turnEnd();
assert(
	"does not compact an active run without eligible history",
	blockedTail.compactCalls.length === 0,
	JSON.stringify(blockedTail.compactCalls),
);
const emergencyContext = [
	contextMessage("user", [{ type: "text", text: "inspect" }]),
	contextMessage("toolResult", [{ type: "text", text: oversizedToolText }]),
];
const protectedEvent = blockedTail.protect(emergencyContext);
assert(
	"temporarily trims an oversized outgoing tool result",
	protectedEvent?.messages !== emergencyContext &&
		protectedEvent?.messages[1]?.content[0]?.text.length < oversizedToolText.length &&
		emergencyContext[1]?.content[0]?.text === oversizedToolText,
	JSON.stringify({ protectedLength: protectedEvent?.messages[1]?.content[0]?.text.length }),
);
blockedTail.settled();
assert(
	"waits for a legal boundary before recovery compaction",
	blockedTail.compactCalls.length === 0,
	JSON.stringify(blockedTail.compactCalls),
);
blockedTail.setBranch(settledBranch);
blockedTail.settled();
assert(
	"starts recovery compaction only after the agent settles",
	blockedTail.compactCalls.length === 1,
	JSON.stringify(blockedTail.compactCalls),
);

const smallBoundary = setup(80_000, 100_000);
smallBoundary.turnEnd();
smallBoundary.settled();
assert(
	"does not trigger at the smaller-context boundary",
	smallBoundary.compactCalls.length === 0,
	JSON.stringify(smallBoundary.compactCalls),
);
smallBoundary.setTokens(80_001);
smallBoundary.turnEnd();
assert(
	"defers compaction one token above the smaller-context boundary",
	smallBoundary.compactCalls.length === 0,
	JSON.stringify(smallBoundary.compactCalls),
);
smallBoundary.settled();
assert(
	"compacts above the smaller-context boundary after settlement",
	smallBoundary.compactCalls.length === 1,
	JSON.stringify(smallBoundary.compactCalls),
);

const largeBoundary = setup(168_000, 200_000);
largeBoundary.turnEnd();
largeBoundary.settled();
assert(
	"leaves 32,000 tokens for a large context",
	proactiveCompactionThreshold(200_000) === 168_000 && largeBoundary.compactCalls.length === 0,
	JSON.stringify(largeBoundary.compactCalls),
);
largeBoundary.setTokens(168_001);
largeBoundary.turnEnd();
largeBoundary.settled();
assert(
	"compacts above the large-context boundary after settlement",
	largeBoundary.compactCalls.length === 1,
	JSON.stringify(largeBoundary.compactCalls),
);

const finalAnswer = setup(99_999, 100_000);
finalAnswer.turnEnd([]);
finalAnswer.settled();
assert(
	"does not trigger for a final answer without a preceding high tool turn",
	finalAnswer.compactCalls.length === 0,
	JSON.stringify(finalAnswer.compactCalls),
);

const alreadyHigh = setup(99_999, 100_000);
alreadyHigh.turnEnd();
alreadyHigh.settled();
assert(
	"triggers an already-high session without threshold-crossing state",
	alreadyHigh.compactCalls.length === 1,
	JSON.stringify(alreadyHigh.compactCalls),
);

const deduplicated = setup(99_999, 100_000);
deduplicated.turnEnd();
deduplicated.turnEnd();
deduplicated.settled();
deduplicated.settled();
assert(
	"deduplicates deferred proactive compactions",
	deduplicated.compactCalls.length === 1,
	JSON.stringify(deduplicated.compactCalls),
);
deduplicated.compactCalls[0]?.onError?.(new Error("test failure"));
deduplicated.settled();
assert(
	"reports failure and allows a later settled retry",
	deduplicated.compactCalls.length === 2 &&
		deduplicated.sent.length === 0 &&
		deduplicated.notices.length === 1 &&
		deduplicated.notices[0]?.level === "error" &&
		deduplicated.notices[0]?.message.includes("test failure"),
	JSON.stringify({ calls: deduplicated.compactCalls.length, notices: deduplicated.notices }),
);

const benignNoOp = setup(99_999, 100_000);
benignNoOp.turnEnd();
benignNoOp.settled();
benignNoOp.compactCalls[0]?.onError?.(new Error("Nothing to compact (session too small)"));
benignNoOp.settled();
assert(
	"does not duplicate Pi's benign no-op compaction error",
	benignNoOp.notices.length === 0 && benignNoOp.compactCalls.length === 1,
	JSON.stringify({ calls: benignNoOp.compactCalls.length, notices: benignNoOp.notices }),
);

const successful = setup(99_999, 100_000);
successful.turnEnd();
successful.settled();
const completion = successful.compactCalls[0]?.onComplete;
completion?.();
completion?.();
assert(
	"does not continue after settled proactive compaction",
	successful.sent.length === 0,
	JSON.stringify(successful.sent),
);

const nativeBeforeSettlement = setup(99_999, 100_000);
nativeBeforeSettlement.turnEnd();
nativeBeforeSettlement.compact({ reason: "threshold", willRetry: false });
nativeBeforeSettlement.settled();
assert(
	"native compaction satisfies pending work without a duplicate manual compact",
	nativeBeforeSettlement.compactCalls.length === 0 && nativeBeforeSettlement.sent.length === 1,
	JSON.stringify({ calls: nativeBeforeSettlement.compactCalls, sent: nativeBeforeSettlement.sent }),
);

const userManual = setup(99_999, 100_000);
userManual.turnEnd();
userManual.compact({ reason: "manual", willRetry: false });
userManual.settled();
assert(
	"user manual compaction clears pending recovery without resuming the agent",
	userManual.compactCalls.length === 0 && userManual.sent.length === 0,
	JSON.stringify({ calls: userManual.compactCalls, sent: userManual.sent }),
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
