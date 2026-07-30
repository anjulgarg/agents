import codexUsageExtension, {
	formatUsageReport,
	registerCodexUsageExtension,
} from "../codex-usage.ts";
import {
	codexQuotaFromUsage,
	CodexUsageClient,
	parseCodexResetCredits,
	parseCodexUsage,
	selectResetCredit,
	type CodexCredentials,
	type CodexUsageReport,
} from "../lib/codex-usage.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const now = 1_800_000_000_000;
const usagePayload = {
	plan_type: "pro",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: {
			used_percent: 25.5,
			limit_window_seconds: 5 * 60 * 60,
			reset_after_seconds: 120,
		},
		secondary_window: {
			used_percent: 70,
			limit_window_seconds: 7 * 24 * 60 * 60,
			reset_at: Math.floor((now + 3_600_000) / 1000),
		},
	},
	additional_rate_limits: [
		{
			limit_name: "Codex Spark",
			metered_feature: "codex_spark",
			rate_limit: {
				primary_window: {
					used_percent: 10,
					limit_window_seconds: 5 * 60 * 60,
				},
			},
		},
	],
	rate_limit_reset_credits: { available_count: 2 },
};

const parsed = parseCodexUsage(usagePayload, now);
assert(
	"parses plan, standard windows, resets, extra limits, and saved resets",
	parsed?.planType === "pro" &&
		parsed.primary?.remainingPercent === 74.5 &&
		parsed.primary.resetsAt === now + 120_000 &&
		parsed.secondary?.remainingPercent === 30 &&
		parsed.secondary.resetsAt === now + 3_600_000 &&
		parsed.additionalLimits[0]?.name === "Codex Spark" &&
		parsed.resetCreditsAvailable === 2,
	JSON.stringify(parsed),
);
const footerQuota = codexQuotaFromUsage(parsed!);
assert(
	"derives the existing footer percentages from the shared report",
	footerQuota?.fiveHourRemaining === 75 && footerQuota.weeklyRemaining === 30,
	JSON.stringify(footerQuota),
);

const creditPayload = {
	available_count: 3,
	credits: [
		{ id: "later", status: "available", expires_at: "2030-02-01T00:00:00Z" },
		{ id: "used", status: "redeemed", expires_at: "2029-01-01T00:00:00Z" },
		{ id: "sooner", status: "available", expires_at: "2030-01-01T00:00:00Z" },
	],
};
const credits = parseCodexResetCredits(creditPayload);
assert(
	"selects the earliest-expiring available reset credit",
	credits?.availableCount === 3 && selectResetCredit(credits)?.id === "sooner",
	JSON.stringify(credits),
);

const credentials: CodexCredentials = { access: "test-token", accountId: "account-1" };
let usageRequests = 0;
let consumeBody: Record<string, unknown> | undefined;
const client = new CodexUsageClient({
	now: () => now,
	randomUUID: () => "request-uuid",
	fetch: async (input, init) => {
		const url = String(input);
		if (url.endsWith("/wham/usage")) {
			usageRequests++;
			return new Response(JSON.stringify(usagePayload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.endsWith("/wham/rate-limit-reset-credits/consume")) {
			consumeBody = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ code: "reset" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.endsWith("/wham/rate-limit-reset-credits")) {
			return new Response(JSON.stringify(creditPayload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`Unexpected URL: ${url}`);
	},
});

await client.getUsage(credentials);
await client.getUsage(credentials);
await client.getUsage(credentials, { force: true });
assert(
	"caches ordinary usage reads and honors forced refresh",
	usageRequests === 2,
	`usage requests: ${usageRequests}`,
);
const listedCredits = await client.listResetCredits(credentials);
const selectedCredit = selectResetCredit(listedCredits);
const consumed = selectedCredit
	? await client.consumeResetCredit(credentials, selectedCredit.id)
	: undefined;
assert(
	"consumes a selected reset with an idempotency key and invalidates usage cache",
	consumed?.ok === true &&
		consumeBody?.credit_id === "sooner" &&
		consumeBody?.redeem_request_id === "request-uuid",
	JSON.stringify({ consumed, consumeBody }),
);
await client.getUsage(credentials);
assert(
	"successful reset consumption invalidates cached usage",
	usageRequests === 3,
	`usage requests: ${usageRequests}`,
);

assert(
	"formats standard and provider-specific quota details",
	formatUsageReport(parsed!).some((line) => line.includes("5 hours")) &&
		formatUsageReport(parsed!).some((line) => line.includes("7 days")) &&
		formatUsageReport(parsed!).some((line) => line.includes("Codex Spark")) &&
		formatUsageReport(parsed!).some((line) => line.includes("Saved resets: 2")),
	formatUsageReport(parsed!).join("\n"),
);

const commands = new Map<string, any>();
codexUsageExtension({
	registerCommand(name: string, definition: any) {
		commands.set(name, definition);
	},
} as any);
assert("registers the /usage command", commands.has("usage"), [...commands.keys()].join(", "));

const report: CodexUsageReport = parsed!;
let consumeCalls = 0;
let confirmations = 0;
const commandClient = {
	getUsage: async () => report,
	listResetCredits: async () => credits!,
	consumeResetCredit: async () => {
		consumeCalls++;
		return { ok: true, code: "reset", status: 200 };
	},
};
const registered = new Map<string, any>();
registerCodexUsageExtension(
	{
		registerCommand(name: string, definition: any) {
			registered.set(name, definition);
		},
	} as any,
	commandClient as any,
);
const resetCommand = registered.get("usage");
const notifications: string[] = [];
const ctx = {
	mode: "print",
	hasUI: true,
	modelRegistry: {
		getProviderAuth: async () => ({
			auth: { apiKey: "test-token", headers: { "ChatGPT-Account-Id": "account-1" } },
			source: "OAuth",
		}),
	},
	ui: {
		confirm: async () => {
			confirmations++;
			return false;
		},
		notify: (message: string) => notifications.push(message),
	},
};
await resetCommand.handler("reset", ctx);
assert(
	"never consumes a reset when confirmation is declined",
	confirmations === 1 && consumeCalls === 0,
	JSON.stringify({ confirmations, consumeCalls, notifications }),
);
ctx.ui.confirm = async () => true;
await resetCommand.handler("reset", ctx);
assert(
	"consumes exactly one reset after explicit confirmation",
	consumeCalls === 1 && notifications.some((message) => message.includes("consumed")),
	JSON.stringify({ consumeCalls, notifications }),
);
