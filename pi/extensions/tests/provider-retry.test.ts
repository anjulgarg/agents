import {
	DEFAULT_PROVIDER_RECOVERY_RETRIES,
	PROVIDER_RECOVERY_MESSAGE_TYPE,
	registerProviderRecovery,
} from "../lib/provider-recovery.ts";
import { isTransientProviderFailure, providerErrorText } from "../lib/provider-retry.ts";

let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
	console.log(
		`${condition ? "PASS" : "FAIL"}: ${name}${condition || !detail ? "" : ` -- ${detail}`}`,
	);
	if (!condition) failed++;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const unknownFailure = {
	stopReason: "error",
	errorMessage: "Unknown error (no error details in response)",
};
const resetFailure = {
	stopReason: "error",
	errorMessage:
		"Azure OpenAI API error (503): 503 upstream connect error or disconnect/reset before headers. reset reason: connection termination",
};

check(
	"empty Responses API failure is classified as transient",
	isTransientProviderFailure(unknownFailure),
);
check(
	"missing provider error details are classified as transient",
	isTransientProviderFailure({ stopReason: "error" }),
);
check(
	"Azure 503 connection reset is classified as transient",
	isTransientProviderFailure(resetFailure),
);
check(
	"Azure 5xx responses outside the common status list are classified as transient",
	isTransientProviderFailure({ stopReason: "error", errorMessage: "Azure OpenAI API error (599)" }),
);
check(
	"authentication failure is not classified as transient",
	!isTransientProviderFailure({ stopReason: "error", errorMessage: "401 authentication failed" }),
);
check(
	"quota exhaustion is not classified as transient",
	!isTransientProviderFailure({ stopReason: "error", errorMessage: "429 insufficient_quota" }),
);
check(
	"successful assistant response is not classified as transient",
	!isTransientProviderFailure({ stopReason: "stop", errorMessage: "503" }),
);
check("provider error text is trimmed", providerErrorText({ errorMessage: "  503  " }) === "503");

interface FakePi {
	handlers: Map<string, (event: any, ctx: any) => unknown>;
	sent: Array<{ message: any; options: any }>;
	on(event: string, handler: (event: any, ctx: any) => unknown): void;
	sendMessage(message: any, options?: any): void;
}

const pi: FakePi = {
	handlers: new Map(),
	sent: [],
	on(event, handler) {
		this.handlers.set(event, handler);
	},
	sendMessage(message, options) {
		this.sent.push({ message, options });
	},
};

const leaf = { type: "message", message: { role: "assistant", ...unknownFailure } };
const ctx = { sessionManager: { getLeafEntry: () => leaf } };
const dispose = registerProviderRecovery(pi as any, {
	maxRetries: DEFAULT_PROVIDER_RECOVERY_RETRIES,
	baseDelayMs: 1,
	maxDelayMs: 2,
});

const settled = pi.handlers.get("agent_settled")!;
const started = pi.handlers.get("agent_start")!;
const messageEnd = pi.handlers.get("message_end")!;

void (async () => {
	settled({}, ctx);
	await wait(10);
	check(
		"first exhausted native failure schedules hidden recovery",
		pi.sent.length === 1 &&
			pi.sent[0]?.message.customType === PROVIDER_RECOVERY_MESSAGE_TYPE &&
			pi.sent[0]?.message.display === false &&
			pi.sent[0]?.options.triggerTurn === true,
		JSON.stringify(pi.sent),
	);

	const cancelPi: FakePi = {
		handlers: new Map(),
		sent: [],
		on(event, handler) {
			this.handlers.set(event, handler);
		},
		sendMessage(message, options) {
			this.sent.push({ message, options });
		},
	};
	const cancelDispose = registerProviderRecovery(cancelPi as any, {
		maxRetries: 1,
		baseDelayMs: 5,
	});
	cancelPi.handlers.get("agent_settled")!({}, ctx);
	cancelPi.handlers.get("agent_start")!({}, ctx);
	await wait(10);
	check("normal turn cancels delayed recovery", cancelPi.sent.length === 0);
	cancelDispose();

	started({}, ctx);
	settled({}, ctx);
	await wait(10);
	check("second transient failure receives a bounded second recovery", pi.sent.length === 2);

	started({}, ctx);
	settled({}, ctx);
	await wait(5);
	check("recovery stops after the bounded retry budget", pi.sent.length === 2);

	started({}, ctx);
	settled({}, ctx);
	await wait(5);
	check("a new user turn reopens bounded recovery", pi.sent.length === 3);

	pi.handlers.get("model_select")!({}, ctx);
	started({}, ctx);
	settled({}, ctx);
	await wait(10);
	check("model changes reopen bounded recovery", pi.sent.length === 4);

	started({}, ctx);
	messageEnd({ message: { role: "assistant", stopReason: "stop" } }, ctx);
	leaf.message = { role: "assistant", ...resetFailure };
	started({}, ctx);
	settled({}, ctx);
	await wait(10);
	check("a successful assistant turn resets the recovery budget", pi.sent.length === 5);

	let windowNow = 0;
	const windowPi: FakePi & { notices: string[] } = {
		handlers: new Map(),
		sent: [],
		notices: [],
		on(event, handler) {
			this.handlers.set(event, handler);
		},
		sendMessage(message, options) {
			this.sent.push({ message, options });
		},
	};
	const windowLeaf = { type: "message", message: { role: "assistant", ...unknownFailure } };
	const windowCtx = {
		sessionManager: { getLeafEntry: () => windowLeaf },
		model: { provider: "azure", id: "gpt-luna" },
		ui: { notify: (message: string) => windowPi.notices.push(message) },
	};
	const windowDispose = registerProviderRecovery(windowPi as any, {
		baseDelayMs: 1,
		maxDelayMs: 1,
		retryWindowMs: 100,
		now: () => windowNow,
	});
	const windowSettled = windowPi.handlers.get("agent_settled")!;
	const windowStarted = windowPi.handlers.get("agent_start")!;
	windowSettled({}, windowCtx);
	await wait(5);
	windowStarted({}, windowCtx);
	windowNow = 20;
	windowSettled({}, windowCtx);
	await wait(5);
	windowStarted({}, windowCtx);
	windowNow = 40;
	windowSettled({}, windowCtx);
	await wait(5);
	check(
		"window-based recovery is not capped at two attempts",
		windowPi.sent.length === 3,
		JSON.stringify(windowPi.sent),
	);
	windowStarted({}, windowCtx);
	windowNow = 101;
	windowSettled({}, windowCtx);
	await wait(5);
	check(
		"recovery stops after the one-minute window",
		windowPi.sent.length === 3 && windowPi.notices.length === 1,
		JSON.stringify(windowPi.notices),
	);
	windowPi.handlers.get("message_end")!(
		{ message: { role: "assistant", stopReason: "stop" } },
		windowCtx,
	);
	windowLeaf.message = { role: "assistant", ...unknownFailure };
	windowStarted({}, windowCtx);
	windowNow = 110;
	windowSettled({}, windowCtx);
	await wait(5);
	check("successful calls reset the retry window", windowPi.sent.length === 4);
	windowDispose();

	dispose();
	if (failed > 0) {
		console.error(`\n${failed} provider retry test(s) failed`);
		process.exitCode = 1;
	} else {
		console.log("\nAll provider retry tests passed");
	}
})();
