/**
 * Run: npm run test:extensions
 */

import { completeDirectRequest } from "../lib/direct-completion.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const model = {
	id: "test-model",
	name: "Test",
	api: "openai-responses",
	provider: "custom",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
	contextWindow: 100_000,
	maxTokens: 4_096,
};

const assistant = {
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "ok" }],
	api: "openai-responses",
	provider: "custom",
	model: "test-model",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: Date.now(),
};

async function testAuthPropagation(): Promise<void> {
	let captured: { model: typeof model; options: Record<string, unknown> } | undefined;
	const context = Object.freeze({
		systemPrompt: "sys",
		messages: Object.freeze([]),
	});
	const requestOptions = Object.freeze({ maxTokens: 50, signal: undefined, apiKey: "stale" });
	const response = await completeDirectRequest(
		{
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "secret-key",
				headers: { authorization: "Bearer x" },
				env: { PI_TEST: "1" },
			}),
			getProviderAuth: async () => ({
				auth: { baseUrl: "https://api.enterprise.githubcopilot.com" },
			}),
			getRegisteredProviderConfig: () => undefined,
		} as never,
		model as never,
		context as never,
		requestOptions as never,
		(async (requestModel, _context, options) => {
			captured = {
				model: requestModel as typeof model,
				options: options as Record<string, unknown>,
			};
			return assistant;
		}) as never,
	);
	assert(
		"propagates auth apiKey, headers, env, and credential-derived base URL",
		response.stopReason === "stop" &&
			captured?.model.baseUrl === "https://api.enterprise.githubcopilot.com" &&
			captured?.options.apiKey === "secret-key" &&
			(captured?.options.headers as { authorization?: string })?.authorization === "Bearer x" &&
			(captured?.options.env as { PI_TEST?: string })?.PI_TEST === "1" &&
			captured?.options.maxTokens === 50,
		JSON.stringify(captured),
	);
}

async function testRegisteredProviderPath(): Promise<void> {
	let registeredCalls = 0;
	let overrideCalls = 0;
	const response = await completeDirectRequest(
		{
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }),
			getProviderAuth: async () => undefined,
			getRegisteredProviderConfig: () => ({
				streamSimple: () => ({
					result: async () => {
						registeredCalls++;
						return { ...assistant, content: [{ type: "text", text: "registered" }] };
					},
				}),
			}),
		} as never,
		model as never,
		{ messages: [] } as never,
		{ maxTokens: 10 } as never,
		(async () => {
			overrideCalls++;
			return assistant;
		}) as never,
	);
	assert(
		"prefers runtime-registered streamSimple over override",
		registeredCalls === 1 &&
			overrideCalls === 0 &&
			response.content[0]?.type === "text" &&
			response.content[0].text === "registered",
		JSON.stringify({ registeredCalls, overrideCalls, response }),
	);
}

async function testOverridePath(): Promise<void> {
	let overrideCalls = 0;
	const response = await completeDirectRequest(
		{
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }),
			getProviderAuth: async () => undefined,
			getRegisteredProviderConfig: () => undefined,
		} as never,
		model as never,
		{ messages: [] } as never,
		{ maxTokens: 10 } as never,
		(async () => {
			overrideCalls++;
			return { ...assistant, content: [{ type: "text", text: "override" }] };
		}) as never,
	);
	assert(
		"uses override when no registered provider stream exists",
		overrideCalls === 1 &&
			response.content[0]?.type === "text" &&
			response.content[0].text === "override",
		JSON.stringify({ overrideCalls, response }),
	);
}

async function testAuthFailure(): Promise<void> {
	let threw = false;
	let message = "";
	try {
		await completeDirectRequest(
			{
				getApiKeyAndHeaders: async () => ({ ok: false, error: "missing credentials" }),
				getRegisteredProviderConfig: () => undefined,
			} as never,
			model as never,
			{ messages: [] } as never,
			{} as never,
			(async () => assistant) as never,
		);
	} catch (error) {
		threw = true;
		message = error instanceof Error ? error.message : String(error);
	}
	assert("throws visible auth errors", threw && message === "missing credentials", message);
}

async function testCancellationSettlesIgnoringOverride(): Promise<void> {
	const controller = new AbortController();
	let overrideStarted = false;
	const request = completeDirectRequest(
		{
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }),
			getProviderAuth: async () => undefined,
			getRegisteredProviderConfig: () => undefined,
		} as never,
		model as never,
		{ messages: [] } as never,
		{ signal: controller.signal } as never,
		(async () => {
			overrideStarted = true;
			return new Promise(() => {});
		}) as never,
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();
	let cancelled = false;
	try {
		await request;
	} catch {
		cancelled = true;
	}
	assert(
		"cancellation settles even when an override ignores the signal",
		cancelled && overrideStarted,
		JSON.stringify({ cancelled, overrideStarted }),
	);
}

async function testPreCancelledRequestSkipsAuth(): Promise<void> {
	const controller = new AbortController();
	controller.abort();
	let authCalls = 0;
	try {
		await completeDirectRequest(
			{
				getApiKeyAndHeaders: async () => {
					authCalls++;
					return { ok: true, apiKey: "k", headers: {}, env: {} };
				},
				getRegisteredProviderConfig: () => undefined,
			} as never,
			model as never,
			{ messages: [] } as never,
			{ signal: controller.signal } as never,
			(async () => assistant) as never,
		);
	} catch {}
	assert("pre-cancelled requests skip authentication", authCalls === 0, authCalls.toString());
}

async function testNoContextMutation(): Promise<void> {
	const context = {
		systemPrompt: "unchanged",
		messages: [{ role: "user" as const, content: "hi", timestamp: 1 }],
		tools: [{ name: "bash", description: "Run", parameters: { type: "object" } }],
	};
	const before = JSON.stringify(context);
	await completeDirectRequest(
		{
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }),
			getProviderAuth: async () => undefined,
			getRegisteredProviderConfig: () => undefined,
		} as never,
		model as never,
		context as never,
		{ maxTokens: 5 } as never,
		(async (_model, usedContext) => {
			assert(
				"does not add tools via helper; passes caller context as-is",
				JSON.stringify(usedContext) === before,
				JSON.stringify(usedContext),
			);
			return assistant;
		}) as never,
	);
	assert(
		"does not mutate the caller context object",
		JSON.stringify(context) === before,
		JSON.stringify(context),
	);
}

await testAuthPropagation();
await testRegisteredProviderPath();
await testOverridePath();
await testAuthFailure();
await testCancellationSettlesIgnoringOverride();
await testPreCancelledRequestSkipsAuth();
await testNoContextMutation();
console.log("All direct-completion tests passed.");
