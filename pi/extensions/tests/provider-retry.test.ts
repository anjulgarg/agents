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

	messageEnd({ message: { role: "assistant", stopReason: "stop" } }, ctx);
	leaf.message = { role: "assistant", ...resetFailure };
	started({}, ctx);
	settled({}, ctx);
	await wait(10);
	check("a successful assistant turn resets the recovery budget", pi.sent.length === 3);

	dispose();
	if (failed > 0) {
		console.error(`\n${failed} provider retry test(s) failed`);
		process.exitCode = 1;
	} else {
		console.log("\nAll provider retry tests passed");
	}
})();
