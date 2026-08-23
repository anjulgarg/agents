/**
 * Token-Speed Extension Tests.
 *
 * Covers helper math, event wiring / state reset, the generation-window rate
 * (message_start to last chunk), live estimates, and the failure modes that
 * used to over-report: burst delivery and reasoning tokens generated before the
 * first visible delta.
 *
 * Run: npm run test:extensions
 */

import tokenSpeedExtension, {
	formatTokenSpeed,
	isSuccessfulStopReason,
	MIN_REPORT_DURATION_MS,
	STATUS_KEY,
} from "../token-speed.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

// ---- Pure helper tests ----

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

// ---- Harness ----

interface StatusCall {
	key: string;
	text: string | undefined;
}

type DeltaKind = "text_delta" | "thinking_delta" | "toolcall_delta";

interface Harness {
	handlers: Map<string, (event: any, ctx?: any) => void>;
	statusCalls: StatusCall[];
	themeCalls: Array<{ color: string; text: string }>;
	context: any;
	at(time: number): void;
	messageStart(role?: string): void;
	delta(text: string, kind?: DeltaKind): void;
	messageEnd(usage: any, stopReason?: string): void;
	emit(event: string, payload?: any): void;
	last(): string | undefined;
}

function makeHarness(options: { estimateTokens?: (text: string) => number } = {}): Harness {
	const handlers = new Map<string, (event: any, ctx?: any) => void>();
	const statusCalls: StatusCall[] = [];
	const themeCalls: Array<{ color: string; text: string }> = [];
	let now = 0;

	const context: any = {
		mode: "tui",
		ui: {
			setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
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
			on: (event: string, handler: (event: any, ctx?: any) => void) => handlers.set(event, handler),
		},
		{
			get(target: any, property: string) {
				return property in target ? target[property] : () => undefined;
			},
		},
	);

	tokenSpeedExtension(pi as any, { clock: () => now, estimateTokens: options.estimateTokens });

	return {
		handlers,
		statusCalls,
		themeCalls,
		context,
		at(time) {
			now = time;
		},
		messageStart(role = "assistant") {
			handlers.get("message_start")?.({ type: "message_start", message: { role } }, context);
		},
		delta(text, kind = "text_delta") {
			handlers.get("message_update")?.(
				{
					type: "message_update",
					message: { role: "assistant" },
					assistantMessageEvent: { type: kind, delta: text, partial: {} },
				},
				context,
			);
		},
		messageEnd(usage, stopReason = "stop") {
			handlers.get("message_end")?.(
				{ type: "message_end", message: { role: "assistant", stopReason, usage } },
				context,
			);
		},
		emit(event, payload = {}) {
			handlers.get(event)?.({ type: event, ...payload }, context);
		},
		last() {
			return statusCalls.findLast((call) => call.key === STATUS_KEY && call.text !== undefined)
				?.text;
		},
	};
}

/** Stream `chars` characters as `chunks` evenly spaced deltas across `spanMs`. */
function stream(
	harness: Harness,
	from: number,
	spanMs: number,
	chunks: number,
	chars: number,
): void {
	const perChunk = Math.max(1, Math.round(chars / chunks));
	for (let index = 0; index < chunks; index++) {
		harness.at(from + Math.round((spanMs * index) / Math.max(1, chunks - 1)));
		harness.delta("x".repeat(perChunk));
	}
}

// ---- Event wiring ----

const wiring = makeHarness();
for (const event of [
	"session_start",
	"session_shutdown",
	"session_compact",
	"message_start",
	"message_update",
	"message_end",
	"agent_end",
]) {
	assert(
		`registers ${event} handler`,
		wiring.handlers.has(event),
		[...wiring.handlers.keys()].join(", "),
	);
}

const sessionStart = makeHarness();
sessionStart.emit("session_start", { reason: "startup" });
assert(
	"session_start clears status",
	sessionStart.statusCalls.some((call) => call.key === STATUS_KEY && call.text === undefined),
	JSON.stringify(sessionStart.statusCalls),
);

const shutdown = makeHarness();
shutdown.emit("session_shutdown", { reason: "reload" });
assert(
	"session_shutdown clears status",
	shutdown.statusCalls.some((call) => call.key === STATUS_KEY && call.text === undefined),
	JSON.stringify(shutdown.statusCalls),
);

const compact = makeHarness();
compact.emit("session_compact", { reason: "threshold" });
assert(
	"session_compact clears in-flight measurement",
	compact.statusCalls.some((call) => call.key === STATUS_KEY && call.text === undefined),
	JSON.stringify(compact.statusCalls),
);

// ---- Generation-window rate ----

// 400 output tokens: stream opens at t=0, first delta after 800 ms of prefill,
// last delta at t=5000, message_end 900 ms later.
const steady = makeHarness();
steady.at(0);
steady.messageStart();
stream(steady, 800, 4200, 40, 1600);
steady.at(5900);
steady.messageEnd({ output: 400 });
assert(
	"final rate divides provider output tokens by the whole generation window",
	steady.last() === "80 tok/s",
	`${steady.last()} (expected 400 / 5.0s)`,
);

// Same message, but the transport hands Pi three buffered flushes 60 ms apart.
const bursty = makeHarness();
bursty.at(0);
bursty.messageStart();
bursty.at(4880);
bursty.delta("x".repeat(200));
bursty.at(4940);
bursty.delta("x".repeat(700));
bursty.at(5000);
bursty.delta("x".repeat(700));
bursty.at(5900);
bursty.messageEnd({ output: 400 });
assert(
	"buffered burst delivery cannot inflate the rate",
	bursty.last() === "80 tok/s",
	`${bursty.last()} (expected 400 / 5.0s, not 400 / 0.12s)`,
);

// Reasoning model: hidden reasoning tokens are generated before the first delta.
const reasoning = makeHarness();
reasoning.at(0);
reasoning.messageStart();
stream(reasoning, 18_000, 4000, 20, 800);
reasoning.at(23_000);
reasoning.messageEnd({ output: 1500, reasoning: 1200 });
assert(
	"reasoning tokens count toward the rate over the window that produced them",
	reasoning.last() === "68 tok/s",
	`${reasoning.last()} (expected 1500 / 22.0s)`,
);

// Tool call whose arguments arrive in two late chunks.
const toolCall = makeHarness();
toolCall.at(0);
toolCall.messageStart();
toolCall.at(8600);
toolCall.delta('{"path":"', "toolcall_delta");
toolCall.at(9000);
toolCall.delta('src/app.ts"}', "toolcall_delta");
toolCall.at(9400);
toolCall.messageEnd({ output: 600 }, "toolUse");
assert(
	"tool-call messages use the same window, not the argument-delta span",
	toolCall.last() === "67 tok/s",
	`${toolCall.last()} (expected 600 / 9.0s)`,
);

// Post-stream processing latency must not deflate the rate.
const lateEnd = makeHarness();
lateEnd.at(0);
lateEnd.messageStart();
stream(lateEnd, 100, 1900, 10, 400);
lateEnd.at(11_000);
lateEnd.messageEnd({ output: 200 });
assert(
	"window ends at the last chunk, not the message_end clock",
	lateEnd.last() === "100 tok/s",
	`${lateEnd.last()} (expected 200 / 2.0s)`,
);

// ---- Guards ----

const noStart = makeHarness();
noStart.at(1000);
noStart.delta("hello");
noStart.at(2000);
noStart.delta("world");
noStart.at(2100);
noStart.messageEnd({ output: 500 });
assert(
	"deltas without a stream-open timestamp report nothing",
	noStart.statusCalls.every((call) => call.key !== STATUS_KEY || call.text === undefined),
	JSON.stringify(noStart.statusCalls),
);

const tooShort = makeHarness();
tooShort.at(0);
tooShort.messageStart();
tooShort.at(50);
tooShort.delta("hi");
tooShort.at(80);
tooShort.messageEnd({ output: 500 });
assert(
	"windows below the minimum duration report nothing",
	tooShort.statusCalls.every((call) => call.key !== STATUS_KEY || call.text === undefined),
	JSON.stringify(tooShort.statusCalls),
);

const noDelta = makeHarness();
noDelta.at(0);
noDelta.messageStart();
noDelta.at(3000);
noDelta.messageEnd({ output: 50 });
assert(
	"a message with no streamed delta reports nothing",
	noDelta.statusCalls.every((call) => call.key !== STATUS_KEY || call.text === undefined),
	JSON.stringify(noDelta.statusCalls),
);

const missingUsage = makeHarness();
missingUsage.at(0);
missingUsage.messageStart();
stream(missingUsage, 100, 1900, 10, 400);
const beforeMissingUsageEnd = missingUsage.statusCalls.length;
missingUsage.at(2100);
missingUsage.messageEnd(undefined);
assert(
	"missing usage publishes no final rate and drops the provisional one",
	missingUsage.statusCalls
		.slice(beforeMissingUsageEnd)
		.every((call) => call.key === STATUS_KEY && call.text === undefined),
	JSON.stringify(missingUsage.statusCalls.slice(beforeMissingUsageEnd)),
);

for (const stopReason of ["error", "aborted", "invalid_reason"]) {
	const stopped = makeHarness();
	stopped.at(0);
	stopped.messageStart();
	stream(stopped, 100, 1900, 10, 400);
	const beforeStoppedEnd = stopped.statusCalls.length;
	stopped.at(2100);
	stopped.messageEnd({ output: 400 }, stopReason);
	assert(
		`stop reason ${stopReason} publishes no final rate`,
		stopped.statusCalls
			.slice(beforeStoppedEnd)
			.every((call) => call.key === STATUS_KEY && call.text === undefined),
		JSON.stringify(stopped.statusCalls.slice(beforeStoppedEnd)),
	);
}

// ---- Live estimates ----

const live = makeHarness({ estimateTokens: (text) => text.length });
live.at(0);
live.messageStart();
live.at(500);
live.delta("0123456789");
const duringWarmUp = live.statusCalls.length;
live.at(900);
live.delta("ABCDE");
assert(
	"warm-up measured from stream open suppresses early live estimates",
	live.statusCalls.length === duringWarmUp,
	JSON.stringify(live.statusCalls),
);
live.at(1000);
live.delta("FGHIJ");
assert(
	"first live estimate divides streamed tokens by the window since stream open",
	live.last() === "20 tok/s",
	`${live.last()} (expected 20 chars / 1.0s)`,
);
assert(
	"token-speed statuses use the theme accent color",
	live.themeCalls.at(-1)?.color === "accent" && live.themeCalls.at(-1)?.text === "20 tok/s",
	JSON.stringify(live.themeCalls),
);
const beforeThrottle = live.statusCalls.length;
live.at(1100);
live.delta("KLMNO");
assert(
	"live estimates stay throttled to the update interval",
	live.statusCalls.length === beforeThrottle,
	JSON.stringify(live.statusCalls),
);
live.at(1250);
live.delta("PQRST");
assert(
	"live estimate refreshes after the throttle interval",
	live.last() === "24 tok/s",
	`${live.last()} (expected 30 chars / 1.25s)`,
);
live.at(1300);
live.messageEnd({ output: 130 });
assert(
	"final usage replaces the provisional estimate",
	live.last() === "104 tok/s",
	`${live.last()} (expected 130 / 1.25s, the window up to the last chunk)`,
);

// ---- Cross-message behavior ----

const across = makeHarness();
across.at(0);
across.messageStart();
stream(across, 100, 1900, 10, 400);
across.at(2100);
across.messageEnd({ output: 200 });
assert(
	"first message publishes its rate",
	across.last() === "100 tok/s",
	`${across.last()} (expected 200 / 2.0s)`,
);
across.at(3000);
across.messageStart();
assert(
	"a new assistant message keeps showing the previous rate",
	across.statusCalls.at(-1)?.text === "100 tok/s",
	JSON.stringify(across.statusCalls.at(-1)),
);
across.at(3100);
across.messageStart("user");
assert(
	"a user message does not reset the measurement",
	across.statusCalls.at(-1)?.text === "100 tok/s",
	JSON.stringify(across.statusCalls.at(-1)),
);
across.at(4000);
across.delta("partial output");
across.at(4500);
across.emit("agent_end", { messages: [] });
assert(
	"agent_end restores the last authoritative rate after an aborted stream",
	across.statusCalls.at(-1)?.text === "100 tok/s",
	JSON.stringify(across.statusCalls.at(-1)),
);

console.log("\nAll token-speed tests passed.");
