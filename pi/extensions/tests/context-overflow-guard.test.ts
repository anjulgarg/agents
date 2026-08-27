import proactiveCompaction, {
	CONTINUATION_PROMPT,
	hasCompactionCandidate,
	contextGuardThreshold,
	protectOversizedToolResults,
} from "../context-overflow-guard.ts";

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

function setup(tokens: number | null, contextWindow: number, branch: any[] = eligibleBranch) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const sent: Array<{ message: any; options: any }> = [];
	let currentTokens = tokens;
	let currentBranch = branch;
	let compactCalls = 0;

	proactiveCompaction({
		on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, handler),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	} as any);

	const ctx = {
		getContextUsage: () => ({ tokens: currentTokens, contextWindow, percent: null }),
		compact: () => {
			compactCalls++;
		},
		sessionManager: { getBranch: () => currentBranch },
	};

	return {
		compact: (event: any) => handlers.get("session_compact")?.(event, ctx),
		compactCalls: () => compactCalls,
		protect: (messages: any[]) => handlers.get("context")?.({ messages }, ctx),
		sent,
		settled: () => handlers.get("agent_settled")?.({}, ctx),
		setBranch: (value: any[]) => {
			currentBranch = value;
		},
		setTokens: (value: number | null) => {
			currentTokens = value;
		},
		turnEnd: (toolResults: any[] = [{}]) => handlers.get("turn_end")?.({ toolResults }, ctx),
	};
}

assert(
	"uses 20 percent headroom for smaller contexts",
	contextGuardThreshold(100_000) === 80_000,
	String(contextGuardThreshold(100_000)),
);
assert(
	"caps headroom at 32,000 tokens for larger contexts",
	contextGuardThreshold(272_000) === 240_000,
	String(contextGuardThreshold(272_000)),
);

const belowThreshold = setup(240_000, 272_000, oversizedToolTail);
belowThreshold.turnEnd();
assert(
	"does not guard at the threshold boundary",
	belowThreshold.protect([
		contextMessage("toolResult", [{ type: "text", text: oversizedToolText }]),
	]) === undefined,
	"context was unexpectedly guarded",
);

const compactable = setup(250_000, 272_000, eligibleBranch);
compactable.turnEnd();
assert(
	"leaves compactable in-window context to Pi",
	compactable.protect([
		contextMessage("toolResult", [{ type: "text", text: oversizedToolText }]),
	]) === undefined,
	"context was unexpectedly guarded",
);

const blocked = setup(250_000, 272_000, oversizedToolTail);
blocked.turnEnd();
const emergencyContext = [
	contextMessage("user", [{ type: "text", text: "inspect" }]),
	contextMessage("toolResult", [{ type: "text", text: oversizedToolText }]),
];
const guarded = blocked.protect(emergencyContext);
assert(
	"guards a high context with no legal compaction candidate",
	guarded?.messages !== emergencyContext &&
		guarded?.messages[1]?.content[0]?.text.length < oversizedToolText.length &&
		emergencyContext[1]?.content[0]?.text === oversizedToolText,
	JSON.stringify({ protectedLength: guarded?.messages[1]?.content[0]?.text.length }),
);
blocked.setBranch(settledBranch);
blocked.setTokens(80_000);
blocked.turnEnd();
assert(
	"keeps the guard active for the remainder of the agent run",
	blocked.protect(emergencyContext)?.messages !== emergencyContext,
	"guard cleared before settlement",
);
blocked.settled();
assert(
	"clears the guard when the agent settles",
	blocked.protect(emergencyContext) === undefined && blocked.compactCalls() === 0,
	JSON.stringify({ compactCalls: blocked.compactCalls() }),
);

const overflowed = setup(272_001, 272_000, eligibleBranch);
overflowed.turnEnd();
assert(
	"guards provider-reported overflow even when history is compactable",
	overflowed.protect(emergencyContext)?.messages !== emergencyContext,
	"overflow context was not guarded",
);
overflowed.compact({ reason: "manual", willRetry: false });
assert(
	"successful compaction clears the guard without an extension compaction call",
	overflowed.protect(emergencyContext) === undefined && overflowed.compactCalls() === 0,
	JSON.stringify({ compactCalls: overflowed.compactCalls() }),
);

const finalAnswer = setup(272_001, 272_000, oversizedToolTail);
finalAnswer.turnEnd([]);
assert(
	"does not guard a final answer without tool results",
	finalAnswer.protect(emergencyContext) === undefined,
	"final answer unexpectedly activated the guard",
);

const native = setup(50_000, 100_000);
native.compact({ reason: "manual", willRetry: false });
native.compact({ reason: "overflow", willRetry: true });
native.compact({ reason: "threshold", willRetry: false });
native.compact({ reason: "overflow", willRetry: false });
assert(
	"continues only after native non-retrying compaction",
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
