/**
 * Run: npm run test:extensions
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { boundSessionEvidence, extractSessionEvidence } from "../lib/session-evidence.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function entry(overrides: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id: "entry",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		...overrides,
	} as SessionEntry;
}

const usage = {
	input: 100,
	output: 20,
	cacheRead: 900,
	cacheWrite: 0,
	totalTokens: 1_020,
	cost: { input: 0.0001, output: 0.0002, cacheRead: 0.00009, cacheWrite: 0, total: 0.00039 },
};

const fixture = [
	entry({
		id: "u1",
		message: { role: "user", content: "Fix the   login\nrace", timestamp: 1 },
	}),
	entry({
		id: "a1",
		parentId: "u1",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect it." },
				{
					type: "toolCall",
					id: "t1",
					name: "future_tool",
					arguments: { secret: "do-not-include" },
				},
				{ type: "toolCall", id: "t2", name: "subagent", arguments: { task: "investigate" } },
				{ type: "toolCall", id: "t3", name: "future_tool", arguments: {} },
			],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		},
	}),
	entry({
		id: "tr1",
		parentId: "a1",
		message: {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "future_tool",
			content: [{ type: "text", text: "raw result must stay excluded" }],
			isError: false,
			timestamp: 3,
		},
	}),
	entry({
		id: "a2",
		parentId: "tr1",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "The race is isolated and the fix is ready." }],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "stop",
			timestamp: 4,
		},
	}),
	entry({
		type: "custom",
		id: "recap-state",
		parentId: "a2",
		customType: "session-recap",
		data: { v: 1, recap: "ignored feature state", cursorEntryId: "a2", generatedAt: 1 },
	}),
	entry({
		type: "custom",
		id: "btw-state",
		parentId: "recap-state",
		customType: "btw",
		data: { question: "ignored", answer: "ignored" },
	}),
	entry({
		type: "custom",
		id: "ann-incomplete",
		parentId: "btw-state",
		customType: "announce-step-duration-update",
		data: { completed: false, step: "Ignore unfinished announcement" },
	}),
	entry({
		type: "custom",
		id: "ann1",
		parentId: "ann-incomplete",
		customType: "announce-step-duration-update",
		data: {
			completed: true,
			step: "Diagnose login race",
			toolCount: 4,
			changedFiles: ["src/login.ts"],
			checkCount: 1,
			failedChecks: 0,
			recoveredFailures: 1,
		},
	}),
] as SessionEntry[];

const extracted = extractSessionEvidence(fixture);
const extractedText = extracted.map((event) => event.text).join("\n");
assert(
	"aggregates tools and keeps user, final agent, completed announce only",
	extractedText.includes("USER: Fix the login race") &&
		extractedText.includes("TOOLS: future_tool x2, subagent x1") &&
		extractedText.includes("AGENT: The race is isolated") &&
		extractedText.includes("WORK: Diagnose login race (4 tools, 1 file changed)") &&
		!extractedText.includes("checks") &&
		!extractedText.includes("recovered") &&
		!extractedText.includes("I will inspect") &&
		!extractedText.includes("do-not-include") &&
		!extractedText.includes("raw result") &&
		!extractedText.includes("unfinished") &&
		!extractedText.includes("ignored feature") &&
		!extractedText.includes("ignored"),
	extractedText,
);

const lengthEvents = extractSessionEvidence([
	entry({
		id: "length-output",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Useful progress before the output limit." }],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "length",
			timestamp: 5,
		},
	}),
]);
assert(
	"retains length-terminated assistant output",
	lengthEvents.length === 1 && lengthEvents[0]?.text.includes("Useful progress"),
	JSON.stringify(lengthEvents),
);

const trailingTools = extractSessionEvidence([
	entry({
		id: "tool-only",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "t9", name: "bash", arguments: {} }],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 6,
		},
	}),
]);
assert(
	"flushes pending tool counts at end of branch",
	trailingTools.length === 1 &&
		trailingTools[0]?.text === "TOOLS: bash x1" &&
		trailingTools[0]?.entryId === "tool-only",
	JSON.stringify(trailingTools),
);

const truncated = extractSessionEvidence(
	[
		entry({
			id: "long",
			message: { role: "user", content: `start ${"x".repeat(200)} end`, timestamp: 1 },
		}),
	],
	{ maxEventChars: 40 },
);
assert(
	"middle-truncates individual events under maxEventChars",
	truncated.length === 1 && truncated[0]!.text.includes("...") && truncated[0]!.text.length <= 40,
	JSON.stringify(truncated),
);

assert(
	"ignores non-positive maxEventChars and still extracts",
	extractSessionEvidence(fixture, { maxEventChars: 0 }).length === extracted.length &&
		extractSessionEvidence(fixture, { maxEventChars: -5 }).length === extracted.length,
	"expected fallback to default event limit",
);

const bounded = boundSessionEvidence(
	[
		{ entryId: "first", text: `USER: original problem ${"a".repeat(40)}` },
		...Array.from({ length: 8 }, (_, index) => ({
			entryId: `middle-${index}`,
			text: `AGENT: middle ${index} ${"b".repeat(40)}`,
		})),
		{ entryId: "last", text: "USER: latest scope change" },
	],
	200,
);
assert(
	"bounded evidence keeps first and newest with omission marker",
	bounded.includes("original problem") &&
		bounded.includes("latest scope change") &&
		bounded.includes("omitted for input limit") &&
		!bounded.includes("middle 3"),
	bounded,
);

assert(
	"aggregate bound is hard even below one event's length",
	boundSessionEvidence([{ entryId: "x", text: "USER: a long event" }], 5).length <= 5,
	boundSessionEvidence([{ entryId: "x", text: "USER: a long event" }], 5),
);

assert(
	"non-positive aggregate bound yields empty string",
	boundSessionEvidence([{ entryId: "x", text: "USER: hi" }], 0) === "" &&
		boundSessionEvidence([{ entryId: "x", text: "USER: hi" }], -1) === "",
	"expected empty for invalid limits",
);

console.log("All session-evidence tests passed.");
