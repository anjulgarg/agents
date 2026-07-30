/**
 * Token-Speed Extension Tests.
 *
 * Covers helper math, event wiring / state reset, hidden reasoning adjustment,
 * first delta semantics, abort/error, too-short durations, and custom footer
 * extension-status inclusion/order.
 *
 * Run: npm run test:extensions
 */

import tokenSpeedExtension, {
	effectiveOutputTokens,
	formatTokenSpeed,
	isSuccessfulStopReason,
	MIN_REPORT_DURATION_MS,
	STATUS_KEY,
	WARM_UP_MS,
} from "../token-speed.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

// ---- Pure helper tests ----

assert(
	"effectiveOutputTokens returns output when no reasoning field",
	effectiveOutputTokens({ output: 100 }, false) === 100,
	"expected 100",
);
assert(
	"effectiveOutputTokens returns output when reasoning is 0",
	effectiveOutputTokens({ output: 100, reasoning: 0 }, false) === 100,
	"expected 100",
);
assert(
	"effectiveOutputTokens returns output when hadThinkingDelta is true",
	effectiveOutputTokens({ output: 100, reasoning: 40 }, true) === 100,
	"expected 100",
);
assert(
	"effectiveOutputTokens subtracts reasoning when hidden and hadThinkingDelta is false",
	effectiveOutputTokens({ output: 100, reasoning: 30 }, false) === 70,
	"expected 70",
);
assert(
	"effectiveOutputTokens clamps to 0 when reasoning exceeds output",
	effectiveOutputTokens({ output: 20, reasoning: 50 }, false) === 0,
	"expected 0",
);

assert(
	"formatTokenSpeed returns formatted string for valid inputs",
	formatTokenSpeed(200, 2000) === "100 tok/s",
	`got ${formatTokenSpeed(200, 2000)}`,
);
assert(
	"formatTokenSpeed returns undefined for non-finite tokens",
	formatTokenSpeed(Infinity, 2000) === undefined,
	"expected undefined",
);
assert(
	"formatTokenSpeed returns undefined for negative tokens",
	formatTokenSpeed(-5, 2000) === undefined,
	"expected undefined",
);
assert(
	"formatTokenSpeed returns undefined for zero tokens",
	formatTokenSpeed(0, 2000) === undefined,
	"expected undefined",
);
assert(
	"formatTokenSpeed returns undefined for non-finite duration",
	formatTokenSpeed(100, Infinity) === undefined,
	"expected undefined",
);
assert(
	"formatTokenSpeed returns undefined for duration below minimum",
	formatTokenSpeed(100, MIN_REPORT_DURATION_MS - 1) === undefined,
	`got ${formatTokenSpeed(100, MIN_REPORT_DURATION_MS - 1)}`,
);
assert(
	"formatTokenSpeed returns undefined for zero duration",
	formatTokenSpeed(100, 0) === undefined,
	"expected undefined",
);
assert(
	"formatTokenSpeed returns undefined for computed non-positive speed",
	formatTokenSpeed(0, 5000) === undefined,
	"expected undefined",
);

assert(
	"isSuccessfulStopReason returns true for stop",
	isSuccessfulStopReason("stop"),
	"expected true",
);
assert(
	"isSuccessfulStopReason returns true for length",
	isSuccessfulStopReason("length"),
	"expected true",
);
assert(
	"isSuccessfulStopReason returns true for toolUse",
	isSuccessfulStopReason("toolUse"),
	"expected true",
);
assert(
	"isSuccessfulStopReason returns false for error",
	!isSuccessfulStopReason("error"),
	"expected false",
);
assert(
	"isSuccessfulStopReason returns false for aborted",
	!isSuccessfulStopReason("aborted"),
	"expected false",
);
assert(
	"isSuccessfulStopReason returns false for unknown reason",
	!isSuccessfulStopReason("unknown"),
	"expected false",
);

// ---- Extension wiring tests ----

interface StatusCall {
	key: string;
	text: string | undefined;
}

function makeMockPi() {
	const handlers = new Map<string, (event: any, ctx?: any) => void>();
	const statusCalls: StatusCall[] = [];
	const themeCalls: Array<{ color: string; text: string }> = [];

	const context: any = {
		mode: "tui",
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				statusCalls.push({ key, text });
			},
			theme: {
				fg: (color: string, text: string) => {
					themeCalls.push({ color, text });
					return text;
				},
			},
		},
	};

	const pi = new Proxy(
		{
			on: (event: string, handler: (event: any, ctx?: any) => void) => {
				handlers.set(event, handler);
			},
		},
		{
			get(target, property) {
				return property in target ? target[property as keyof typeof target] : () => undefined;
			},
		},
	);

	return { handlers, statusCalls, themeCalls, context, pi };
}

// Test 1: Event handlers are registered
const mock1 = makeMockPi();
tokenSpeedExtension(mock1.pi as any);
assert(
	"registers session_start handler",
	mock1.handlers.has("session_start"),
	[...mock1.handlers.keys()].join(", "),
);
assert(
	"registers message_start handler",
	mock1.handlers.has("message_start"),
	[...mock1.handlers.keys()].join(", "),
);
assert(
	"registers message_update handler",
	mock1.handlers.has("message_update"),
	[...mock1.handlers.keys()].join(", "),
);
assert(
	"registers message_end handler",
	mock1.handlers.has("message_end"),
	[...mock1.handlers.keys()].join(", "),
);
assert(
	"registers session_shutdown handler",
	mock1.handlers.has("session_shutdown"),
	[...mock1.handlers.keys()].join(", "),
);
assert(
	"registers session_compact handler",
	mock1.handlers.has("session_compact"),
	[...mock1.handlers.keys()].join(", "),
);
assert(
	"registers agent_end handler",
	mock1.handlers.has("agent_end"),
	[...mock1.handlers.keys()].join(", "),
);

// Test 2: State reset on session_start clears status
const mock2 = makeMockPi();
tokenSpeedExtension(mock2.pi as any, { clock: () => 1000 });
mock2.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock2.context);
assert(
	"session_start clears status",
	mock2.statusCalls.some((c) => c.key === STATUS_KEY && c.text === undefined),
	JSON.stringify(mock2.statusCalls),
);

// Test 3: session_shutdown resets state
const mock3 = makeMockPi();
tokenSpeedExtension(mock3.pi as any);
mock3.handlers.get("session_shutdown")?.(
	{ type: "session_shutdown", reason: "reload" },
	mock3.context,
);
assert(
	"session_shutdown clears status",
	mock3.statusCalls.some((call) => call.key === STATUS_KEY && call.text === undefined),
	JSON.stringify(mock3.statusCalls),
);

// Test 4: session_compact resets state
const mock4 = makeMockPi();
tokenSpeedExtension(mock4.pi as any);
mock4.handlers.get("session_compact")?.(
	{
		type: "session_compact",
		reason: "threshold",
		compactionEntry: {},
		fromExtension: false,
		willRetry: false,
	},
	mock4.context,
);
assert(
	"session_compact clears status",
	mock4.statusCalls.some((call) => call.key === STATUS_KEY && call.text === undefined),
	JSON.stringify(mock4.statusCalls),
);

// Test 5: assistant message_start resets per-message state
const mock5 = makeMockPi();
let fakeNow = 5000;
tokenSpeedExtension(mock5.pi as any, { clock: () => fakeNow });
// Simulate first delta
mock5.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "Hello", partial: {} },
	},
	mock5.context,
);
// Then a new assistant message starts
mock5.handlers.get("message_start")?.(
	{
		type: "message_start",
		message: { role: "assistant" },
	},
	mock5.context,
);
// User message should NOT reset
mock5.handlers.get("message_start")?.(
	{
		type: "message_start",
		message: { role: "user", content: "hi" },
	},
	mock5.context,
);
// Now first delta on new assistant, second delta, then end
fakeNow = 6000;
mock5.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "Wo", partial: {} },
	},
	mock5.context,
);
fakeNow = 6500;
mock5.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "rld", partial: {} },
	},
	mock5.context,
);
fakeNow = 7000;
mock5.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { output: 50 },
		},
	},
	mock5.context,
);
assert(
	"assistant message_start resets state correctly so second message gets measured",
	mock5.statusCalls.some(
		(c) => c.key === STATUS_KEY && c.text !== undefined && c.text.includes("tok/s"),
	),
	JSON.stringify(mock5.statusCalls),
);

// Test 6: First delta timing with text_delta (two non-empty deltas, first-to-last duration)
const mock6 = makeMockPi();
fakeNow = 1000;
tokenSpeedExtension(mock6.pi as any, { clock: () => fakeNow });
fakeNow = 1100;
mock6.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "Hel", partial: {} },
	},
	mock6.context,
);
// firstDeltaTime=1100, firstChunkEstimate=ceil(3/4)=1, warmUpUntil=2100
fakeNow = 2100;
mock6.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "lo", partial: {} },
	},
	mock6.context,
);
// lastChunkTime=2100
fakeNow = 3000;
mock6.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { output: 190 },
		},
	},
	mock6.context,
);
// Duration = 2100 - 1100 = 1000ms. Speed = (190 - 1) / 1.0 = 189 tok/s
const lastCall6 = mock6.statusCalls.findLast((c) => c.key === STATUS_KEY && c.text !== undefined);
assert(
	"text_delta first timing: computes correct rounded speed using lastChunkTime",
	lastCall6?.text?.includes("189 tok/s") === true,
	JSON.stringify({ lastCall6 }),
);

// Test 7: thinking_delta sets hadThinkingDelta (two non-empty deltas)
const mock7 = makeMockPi();
fakeNow = 2000;
tokenSpeedExtension(mock7.pi as any, { clock: () => fakeNow });
fakeNow = 2100;
mock7.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_delta", delta: "thinking...", partial: {} },
	},
	mock7.context,
);
// firstDeltaTime=2100, firstChunkEstimate=ceil(10/4)=3, warmUpUntil=3100
fakeNow = 2300;
mock7.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_delta", delta: " more", partial: {} },
	},
	mock7.context,
);
// lastChunkTime=2300
fakeNow = 2500;
mock7.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { output: 120, reasoning: 40 },
		},
	},
	mock7.context,
);
// hadThinkingDelta = true, so effective = output (120), not output - reasoning
// Duration = 2300 - 2100 = 200ms. Speed = (120 - 3) / 0.2 = 585 tok/s
const lastCall7 = mock7.statusCalls.find((c) => c.key === STATUS_KEY && c.text !== undefined);
assert(
	"thinking_delta prevents reasoning subtraction, uses full output",
	lastCall7?.text?.includes("585 tok/s") === true,
	JSON.stringify({ lastCall7 }),
);

// Thinking can begin after visible text; every non-empty thinking delta must be tracked.
const mock7b = makeMockPi();
fakeNow = 2600;
tokenSpeedExtension(mock7b.pi as any, { clock: () => fakeNow });
mock7b.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "Visible", partial: {} },
	},
	mock7b.context,
);
// firstDeltaTime=2600, firstChunkEstimate=ceil(7/4)=2, warmUpUntil=3600
fakeNow = 2700;
mock7b.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_delta", delta: "Reasoning", partial: {} },
	},
	mock7b.context,
);
// lastChunkTime=2700
fakeNow = 3600;
mock7b.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { output: 100, reasoning: 40 },
		},
	},
	mock7b.context,
);
// Duration = 2700 - 2600 = 100ms. Speed = (100 - 2) / 0.1 = 980 tok/s
assert(
	"thinking after text still prevents reasoning subtraction",
	mock7b.statusCalls.some((call) => call.text === "980 tok/s"),
	JSON.stringify(mock7b.statusCalls),
);

// Test 8: toolcall_delta starts timing (two non-empty deltas)
const mock8 = makeMockPi();
fakeNow = 3000;
tokenSpeedExtension(mock8.pi as any, { clock: () => fakeNow });
fakeNow = 3050;
mock8.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "toolcall_delta", delta: '{"na', partial: {} },
	},
	mock8.context,
);
// firstDeltaTime=3050, firstChunkEstimate=ceil(4/4)=1, warmUpUntil=4050
fakeNow = 3550;
mock8.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "toolcall_delta", delta: 'me"}', partial: {} },
	},
	mock8.context,
);
// lastChunkTime=3550
fakeNow = 4050;
mock8.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "toolUse",
			usage: { output: 100 },
		},
	},
	mock8.context,
);
// Duration = 3550 - 3050 = 500ms, Speed = (100 - 1) / 0.5 = 198 tok/s
const lastCall8 = mock8.statusCalls.find((c) => c.key === STATUS_KEY && c.text !== undefined);
assert(
	"toolcall_delta starts timing correctly",
	lastCall8?.text?.includes("198 tok/s") === true,
	JSON.stringify({ lastCall8 }),
);

// Test 9: Empty deltas do NOT start timing (two non-empty deltas)
const mock9 = makeMockPi();
fakeNow = 4000;
tokenSpeedExtension(mock9.pi as any, { clock: () => fakeNow });
mock9.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "", partial: {} },
	},
	mock9.context,
);
mock9.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_delta", delta: "", partial: {} },
	},
	mock9.context,
);
fakeNow = 5000;
mock9.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "re", partial: {} },
	},
	mock9.context,
);
// firstDeltaTime=5000, firstChunkEstimate=ceil(2/4)=1, warmUpUntil=6000
fakeNow = 5500;
mock9.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "al", partial: {} },
	},
	mock9.context,
);
// lastChunkTime=5500
fakeNow = 6000;
mock9.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { output: 100 },
		},
	},
	mock9.context,
);
// Duration = 5500 - 5000 = 500ms, Speed = (100 - 1) / 0.5 = 198 tok/s
const lastCall9 = mock9.statusCalls.find((c) => c.key === STATUS_KEY && c.text !== undefined);
assert(
	"empty deltas do not start timing, only first non-empty delta starts",
	lastCall9?.text?.includes("198 tok/s") === true,
	JSON.stringify({ lastCall9 }),
);

// Test 10: Error/abort stopReason clears and does not set status
const mock10 = makeMockPi();
fakeNow = 6000;
tokenSpeedExtension(mock10.pi as any, { clock: () => fakeNow });
fakeNow = 6100;
mock10.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "data", partial: {} },
	},
	mock10.context,
);
const statusBeforeError = mock10.statusCalls.length;
fakeNow = 7000;
mock10.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "error",
			usage: { output: 50 },
		},
	},
	mock10.context,
);
const clearCalls10 = mock10.statusCalls.slice(statusBeforeError);
assert(
	"error stopReason does not set token-speed status",
	clearCalls10.some((c) => c.key === STATUS_KEY && c.text === undefined) === true,
	JSON.stringify(clearCalls10),
);
assert(
	"error stopReason never sets a token-speed with tok/s",
	clearCalls10.some((c) => c.key === STATUS_KEY && c.text !== undefined) === false,
	JSON.stringify(clearCalls10),
);

// Test 11: Aborted stopReason clears too
const mock11 = makeMockPi();
fakeNow = 8000;
tokenSpeedExtension(mock11.pi as any, { clock: () => fakeNow });
fakeNow = 8100;
mock11.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "data", partial: {} },
	},
	mock11.context,
);
fakeNow = 9000;
mock11.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "aborted",
			usage: { output: 50 },
		},
	},
	mock11.context,
);
assert(
	"aborted stopReason does not set token-speed status",
	mock11.statusCalls.every((c) => c.key !== STATUS_KEY || c.text === undefined),
	JSON.stringify(mock11.statusCalls),
);

// Test 12: Duration below minimum produces no status
const mock12 = makeMockPi();
fakeNow = 0;
tokenSpeedExtension(mock12.pi as any, { clock: () => fakeNow });
// First delta at t=0
mock12.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "data", partial: {} },
	},
	mock12.context,
);
// End at t=50ms (below 100ms minimum)
fakeNow = 50;
mock12.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { output: 500 },
		},
	},
	mock12.context,
);
assert(
	"duration below 100ms does not set speed status",
	mock12.statusCalls.every((c) => c.key !== STATUS_KEY || c.text === undefined),
	JSON.stringify(mock12.statusCalls),
);

// Test 13: Hidden reasoning adjustment (no thinking_delta, reasoning reported, two deltas)
const mock13 = makeMockPi();
fakeNow = 10000;
tokenSpeedExtension(mock13.pi as any, { clock: () => fakeNow });
fakeNow = 10100;
mock13.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "Hello", partial: {} },
	},
	mock13.context,
);
// firstDeltaTime=10100, firstChunkEstimate=ceil(5/4)=2, warmUpUntil=11100
fakeNow = 11100;
mock13.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: " World", partial: {} },
	},
	mock13.context,
);
// lastChunkTime=11100
fakeNow = 12000;
mock13.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { output: 200, reasoning: 80 },
		},
	},
	mock13.context,
);
// No thinking_delta was streamed, so effective = 200 - 80 = 120
// Duration = 11100 - 10100 = 1000ms. Speed = (120 - 2) / 1.0 = 118 tok/s.
const lastCall13 = mock13.statusCalls.findLast((c) => c.key === STATUS_KEY && c.text !== undefined);
assert(
	"hidden reasoning adjustment subtracts reasoning from output",
	lastCall13?.text?.includes("118 tok/s") === true,
	JSON.stringify({ lastCall13 }),
);

// Test 14: Unknown stop reason does not finalize
const mock14 = makeMockPi();
fakeNow = 12000;
tokenSpeedExtension(mock14.pi as any, { clock: () => fakeNow });
fakeNow = 12100;
mock14.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "data", partial: {} },
	},
	mock14.context,
);
fakeNow = 13000;
mock14.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "invalid_reason",
			usage: { output: 100 },
		},
	},
	mock14.context,
);
assert(
	"unknown stop reason does not set token-speed status",
	mock14.statusCalls.every((c) => c.key !== STATUS_KEY || c.text === undefined),
	JSON.stringify(mock14.statusCalls),
);

// Test 15: Missing usage on message_end does not set status
const mock15 = makeMockPi();
fakeNow = 14000;
tokenSpeedExtension(mock15.pi as any, { clock: () => fakeNow });
fakeNow = 14100;
mock15.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "data", partial: {} },
	},
	mock15.context,
);
fakeNow = 15000;
mock15.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			// no usage
		},
	},
	mock15.context,
);
assert(
	"missing usage does not set speed status",
	mock15.statusCalls.every((c) => c.key !== STATUS_KEY || c.text === undefined),
	JSON.stringify(mock15.statusCalls),
);

// Test 16: No delta before message_end does not set status
const mock16 = makeMockPi();
fakeNow = 16000;
tokenSpeedExtension(mock16.pi as any, { clock: () => fakeNow });
mock16.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { output: 50 },
		},
	},
	mock16.context,
);
assert(
	"no delta before message_end does not set speed status",
	mock16.statusCalls.every((c) => c.key !== STATUS_KEY || c.text === undefined),
	JSON.stringify(mock16.statusCalls),
);

// Test 17: agent_end safety net clears dangling state
const mock17 = makeMockPi();
fakeNow = 17000;
tokenSpeedExtension(mock17.pi as any, { clock: () => fakeNow });
fakeNow = 17100;
mock17.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "data", partial: {} },
	},
	mock17.context,
);
// No message_end fires (abort during streaming)
mock17.handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, mock17.context);
const hasClear17 = mock17.statusCalls.some((c) => c.key === STATUS_KEY && c.text === undefined);
assert(
	"agent_end safety net clears dangling state on abort during streaming",
	hasClear17,
	JSON.stringify(mock17.statusCalls),
);

// Test 18: Warm-up, live estimates with baseline subtraction, throttling, abort restoration.
const mock18 = makeMockPi();
fakeNow = 0;
tokenSpeedExtension(mock18.pi as any, {
	clock: () => fakeNow,
	estimateTokens: (text) => text.length,
});

// ── First message: complete to establish lastFinalStatus (two non-empty deltas) ──
mock18.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "fi", partial: {} },
	},
	mock18.context,
);
// firstDeltaTime=0, firstChunkEstimate=2, warmUpUntil=1000
fakeNow = 1000;
mock18.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "rst", partial: {} },
	},
	mock18.context,
);
// lastChunkTime=1000
fakeNow = 1000;
mock18.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", usage: { output: 100 } },
	},
	mock18.context,
);
// adjusted = max(0, 100-2) = 98, dur=1000-0=1000ms, speed=98/1.0=98 tok/s
assert(
	"successful completion stores the adjusted final rate",
	mock18.statusCalls.at(-1)?.text === "98 tok/s",
	JSON.stringify(mock18.statusCalls),
);

mock18.handlers.get("message_start")?.(
	{ type: "message_start", message: { role: "assistant" } },
	mock18.context,
);
assert(
	"a new assistant message preserves the previous final rate",
	mock18.statusCalls.at(-1)?.text === "98 tok/s",
	JSON.stringify(mock18.statusCalls),
);

// ── Second message: warm-up, live, throttling, abort ──
fakeNow = 2000;
mock18.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "0123456789", partial: {} },
	},
	mock18.context,
);
// firstDeltaTime=2000, firstChunkEstimate=10, warmUpUntil=3000

// During warm-up: suppressed
fakeNow = 2500;
const afterWarmupEnable = mock18.statusCalls.length;
mock18.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "ABCDE", partial: {} },
	},
	mock18.context,
);
assert(
	"warm-up suppresses live estimates before 1000ms",
	mock18.statusCalls.length === afterWarmupEnable,
	JSON.stringify(mock18.statusCalls),
);

// After warm-up: first live estimate (warmUpUntil=3000, now=3000 is NOT < 3000)
fakeNow = 3000;
mock18.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "FGHIJ", partial: {} },
	},
	mock18.context,
);
// streamedOutput = "0123456789ABCDEFGHIJ" (20 chars), live num = 20-10 = 10
// duration = 3000-2000 = 1000ms, speed = 10/1.0 = 10 tok/s
assert(
	"first live after warm-up subtracts baseline estimate",
	mock18.statusCalls.at(-1)?.text === "10 tok/s",
	JSON.stringify(mock18.statusCalls),
);
assert(
	"token-speed statuses use the theme accent color",
	mock18.themeCalls.at(-1)?.color === "accent" && mock18.themeCalls.at(-1)?.text === "10 tok/s",
	JSON.stringify(mock18.themeCalls),
);

// Throttled: quick delta before 250ms
fakeNow = 3100;
const beforeThrottle = mock18.statusCalls.length;
mock18.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "KLMNO", partial: {} },
	},
	mock18.context,
);
assert(
	"live estimates throttled to 250ms interval",
	mock18.statusCalls.length === beforeThrottle,
	JSON.stringify(mock18.statusCalls),
);

// After throttle interval (250ms after last live at 3000)
fakeNow = 3250;
mock18.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "PQRST", partial: {} },
	},
	mock18.context,
);
// streamedOutput = 30 chars, live num = 30-10 = 20
// duration = 3250-2000 = 1250ms, speed = 20/1.25 = 16 tok/s
assert(
	"live estimate after throttle accumulates more text",
	mock18.statusCalls.at(-1)?.text === "16 tok/s",
	JSON.stringify(mock18.statusCalls),
);

// Abort restoration
fakeNow = 3300;
mock18.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "aborted", usage: { output: 8 } },
	},
	mock18.context,
);
assert(
	"an aborted stream restores the previous authoritative rate",
	mock18.statusCalls.at(-1)?.text === "98 tok/s",
	JSON.stringify(mock18.statusCalls),
);

// Test 19: A successful completion replaces the provisional estimate.
mock18.handlers.get("message_start")?.(
	{ type: "message_start", message: { role: "assistant" } },
	mock18.context,
);
fakeNow = 4000;
mock18.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "1234", partial: {} },
	},
	mock18.context,
);
// firstDeltaTime=4000, firstChunkEstimate=4, warmUpUntil=5000
fakeNow = 5000;
mock18.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "5678", partial: {} },
	},
	mock18.context,
);
// lastChunkTime=5000, streamedOutput = "12345678" (8 chars), live num = 8-4 = 4
// duration = 1000ms, speed = 4/1.0 = 4 tok/s
fakeNow = 6000;
mock18.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "length", usage: { output: 200 } },
	},
	mock18.context,
);
// adjusted = max(0, 200-4) = 196, duration = 5000-4000 = 1000ms
// speed = 196 / 1.0 = 196 tok/s
assert(
	"successful completion replaces the provisional rate with final usage",
	mock18.statusCalls.at(-1)?.text === "196 tok/s",
	JSON.stringify(mock18.statusCalls),
);

// ── New regression tests ──

// Test 20: One-chunk completion has no measurable arrival interval.
const mock20 = makeMockPi();
fakeNow = 20000;
tokenSpeedExtension(mock20.pi as any, { clock: () => fakeNow });
fakeNow = 20100;
mock20.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "Hi", partial: {} },
	},
	mock20.context,
);
// firstDeltaTime=20100, firstChunkEstimate=ceil(2/4)=1
fakeNow = 21000;
mock20.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", usage: { output: 100 } },
	},
	mock20.context,
);
// adjusted = 99, but first-to-last duration is 0ms, so no rate is measurable.
assert(
	"one-chunk completion produces no rate without an arrival interval",
	mock20.statusCalls.every((c) => c.key !== STATUS_KEY || c.text === undefined),
	JSON.stringify(mock20.statusCalls),
);

// Test 21: Live numerator explicitly excludes first-chunk baseline
const mock21 = makeMockPi();
fakeNow = 30000;
tokenSpeedExtension(mock21.pi as any, {
	clock: () => fakeNow,
	estimateTokens: (text) => text.length * 10,
});
mock21.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "AB", partial: {} },
	},
	mock21.context,
);
// firstDeltaTime=30000, firstChunkEstimate=20, warmUpUntil=31000
fakeNow = 31000;
mock21.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "C", partial: {} },
	},
	mock21.context,
);
// streamedOutput = "ABC" (3 chars), estimate=30, live num=max(0,30-20)=10
// duration=1000ms, speed=10/1.0=10 tok/s
assert(
	"live numerator excludes first-chunk baseline estimate",
	mock21.statusCalls.some((c) => c.key === STATUS_KEY && c.text === "10 tok/s"),
	JSON.stringify(mock21.statusCalls),
);

// Test 22: Final numerator explicitly excludes first-chunk baseline (two deltas)
const mock22 = makeMockPi();
fakeNow = 40000;
tokenSpeedExtension(mock22.pi as any, { clock: () => fakeNow });
fakeNow = 40100;
mock22.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "Tes", partial: {} },
	},
	mock22.context,
);
// firstDeltaTime=40100, firstChunkEstimate=ceil(3/4)=1
fakeNow = 41000;
mock22.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "t", partial: {} },
	},
	mock22.context,
);
// lastChunkTime=41000
fakeNow = 42000;
mock22.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", usage: { output: 100 } },
	},
	mock22.context,
);
// adjusted = max(0, 100-1) = 99, duration=41000-40100=900ms, speed=99/0.9=110 tok/s
assert(
	"final numerator excludes first-chunk baseline estimate",
	mock22.statusCalls.some((c) => c.key === STATUS_KEY && c.text === "110 tok/s"),
	JSON.stringify(mock22.statusCalls),
);

// Test 23: Final rate uses lastChunkTime, not message_end clock (regression)
const mock23 = makeMockPi();
fakeNow = 50000;
tokenSpeedExtension(mock23.pi as any, { clock: () => fakeNow });
fakeNow = 50100;
mock23.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "Fi", partial: {} },
	},
	mock23.context,
);
// firstDeltaTime=50100, firstChunkEstimate=ceil(2/4)=1, warmUpUntil=51100
fakeNow = 51000;
mock23.handlers.get("message_update")?.(
	{
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "nal", partial: {} },
	},
	mock23.context,
);
// lastChunkTime=51000 (warm-up period, so live estimate suppressed)
fakeNow = 60000; // message_end fires 9s after last chunk
mock23.handlers.get("message_end")?.(
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", usage: { output: 200 } },
	},
	mock23.context,
);
// Correct: duration = 51000-50100 = 900ms, NOT 60000-50100 = 9900ms
// adjusted = max(0, 200-1) = 199, speed = 199/0.9 ≈ 221 tok/s
const lastCall23 = mock23.statusCalls.find((c) => c.key === STATUS_KEY && c.text !== undefined);
assert(
	"final rate uses first-to-last chunk duration, ignores message_end clock",
	lastCall23?.text?.includes("221 tok/s") === true,
	JSON.stringify({ lastCall23 }),
);

console.log("\nAll token-speed tests passed.");
