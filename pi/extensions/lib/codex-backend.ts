// Shared helper: one-shot completions against the codex backend Responses
// endpoint, reusing the ChatGPT OAuth login that pi's openai-codex provider
// stores in ~/.pi/agent/auth.json. Handles token refresh and persistence.
// No codex CLI and no API key required.
//
// This file lives under pi/extensions/lib/ (no index.ts) so pi does NOT auto-load
// it as an extension; it is imported by extensions that need it.

import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_PATH = process.env.PI_CODEX_AUTH_PATH ?? join(homedir(), ".pi", "agent", "auth.json");
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const EXPIRY_SKEW_MS = 60_000;

export const DEFAULT_CODEX_MODEL = process.env.PI_CODEX_MODEL ?? "gpt-5.6-sol";

interface CodexAuth {
	type?: string;
	access: string;
	refresh: string;
	expires: number;
	accountId: string;
}

export interface CodexCompleteOptions {
	/** System instructions for the turn. */
	instructions: string;
	/** The user message text. */
	input: string;
	/** Optional native tools, e.g. [{ type: "web_search" }]. */
	tools?: Array<Record<string, unknown>>;
	/** Model id (default gpt-5.6-sol or PI_CODEX_MODEL). */
	model?: string;
	/** Reasoning effort (default "low"). */
	effort?: string;
	signal?: AbortSignal;
}

async function loadAuth(): Promise<{ store: Record<string, unknown>; codex: CodexAuth }> {
	let store: Record<string, unknown>;
	try {
		store = JSON.parse(await readFile(AUTH_PATH, "utf8"));
	} catch (error) {
		throw new Error(`Could not read codex auth at ${AUTH_PATH}: ${(error as Error).message}`);
	}
	const codex = store["openai-codex"] as CodexAuth | undefined;
	if (!codex?.access || !codex?.accountId) {
		throw new Error(
			`No codex login found in ${AUTH_PATH}. Log in with pi (openai-codex) or codex first.`,
		);
	}
	return { store, codex };
}

async function refreshAuth(codex: CodexAuth): Promise<CodexAuth> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: codex.refresh,
			client_id: CLIENT_ID,
		}),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`Codex token refresh failed (${response.status}): ${text || response.statusText}`,
		);
	}
	const json = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};
	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new Error("Codex token refresh response missing fields");
	}
	return {
		...codex,
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

async function persistAuth(store: Record<string, unknown>, codex: CodexAuth): Promise<void> {
	store["openai-codex"] = {
		...(store["openai-codex"] as CodexAuth),
		access: codex.access,
		refresh: codex.refresh,
		expires: codex.expires,
	};
	const tmp = `${AUTH_PATH}.pi-codex-${process.pid}`;
	await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
	await rename(tmp, AUTH_PATH);
}

function buildBody(opts: CodexCompleteOptions) {
	return {
		model: opts.model ?? DEFAULT_CODEX_MODEL,
		store: false,
		stream: true,
		instructions: opts.instructions,
		input: [{ type: "message", role: "user", content: [{ type: "input_text", text: opts.input }] }],
		...(opts.tools ? { tools: opts.tools } : {}),
		tool_choice: "auto",
		parallel_tool_calls: true,
		include: [],
		text: { verbosity: "low" },
		reasoning: { effort: opts.effort ?? "low", summary: "auto" },
	};
}

async function requestResponses(codex: CodexAuth, opts: CodexCompleteOptions): Promise<Response> {
	return fetch(RESPONSES_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${codex.access}`,
			"chatgpt-account-id": codex.accountId,
			originator: "pi",
			"OpenAI-Beta": "responses=experimental",
			accept: "text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify(buildBody(opts)),
		signal: opts.signal,
	});
}

async function readAnswer(response: Response): Promise<string> {
	if (!response.body) throw new Error("Codex response had no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let failure: string | undefined;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buffer.indexOf("\n\n")) !== -1) {
			const chunk = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const data = chunk
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trim())
				.join("\n")
				.trim();
			if (!data || data === "[DONE]") continue;
			let event: any;
			try {
				event = JSON.parse(data);
			} catch {
				continue;
			}
			if (event.type === "response.output_text.delta") {
				text += event.delta ?? "";
			} else if (event.type === "response.failed") {
				failure = event.response?.error?.message ?? "Codex reported response.failed";
			} else if ((event.type === "response.completed" || event.type === "response.done") && !text) {
				for (const item of event.response?.output ?? []) {
					if (item.type === "message") {
						for (const part of item.content ?? []) {
							if (part.type === "output_text") text += part.text ?? "";
						}
					}
				}
			}
		}
	}

	if (failure && !text) throw new Error(`Codex request failed: ${failure}`);
	return text.trim();
}

/**
 * Run a one-shot completion against the codex backend and return the final
 * assistant text. Pass `tools: [{ type: "web_search" }]` to enable native web
 * search.
 */
export async function codexComplete(opts: CodexCompleteOptions): Promise<string> {
	let { store, codex } = await loadAuth();
	if (codex.expires && Date.now() >= codex.expires - EXPIRY_SKEW_MS) {
		codex = await refreshAuth(codex);
		await persistAuth(store, codex).catch(() => {});
	}

	let response = await requestResponses(codex, opts);
	if (response.status === 401) {
		codex = await refreshAuth(codex);
		await persistAuth(store, codex).catch(() => {});
		response = await requestResponses(codex, opts);
	}
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`Codex request failed (${response.status}): ${detail || response.statusText}`);
	}

	return readAnswer(response);
}
