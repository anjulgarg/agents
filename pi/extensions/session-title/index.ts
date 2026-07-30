import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { extractTitleText, normalizeSessionTitle } from "./core.ts";

export { extractTitleText, normalizeSessionTitle } from "./core.ts";

const SYSTEM_PROMPT = `Create a concise title for a coding-agent session.
Infer the session's primary task from the conversation. Ignore acknowledgements, greetings, and trivial follow-up messages.
Output only a descriptive title containing at most three words. Do not add quotes, punctuation, commentary, or a prefix.`;
const MAX_CONTEXT_LENGTH = 6_000;

function messageText(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const sessionEntry = entry as {
		type?: string;
		message?: { role?: string; content?: string | Array<{ type: string; text?: string }> };
	};
	if (sessionEntry.type !== "message" || !sessionEntry.message) return undefined;
	const { role, content } = sessionEntry.message;
	if (role !== "user" && role !== "assistant") return undefined;
	const text =
		typeof content === "string" ? content : Array.isArray(content) ? extractTitleText(content) : "";
	const compact = text.replace(/\s+/g, " ").trim();
	return compact ? `${role}: ${compact.slice(0, 1_000)}` : undefined;
}

function buildConversationContext(ctx: ExtensionContext, prompt: string): string {
	const messages = ctx.sessionManager
		.getBranch()
		.map(messageText)
		.filter((line): line is string => Boolean(line));
	const firstUser = messages.find((line) => line.startsWith("user:"));
	const recent = messages.slice(-8).map((line) => line.slice(0, 500));
	const selected =
		firstUser && !recent.includes(firstUser) ? [firstUser.slice(0, 800), ...recent] : recent;
	selected.push(`user: ${prompt.replace(/\s+/g, " ").trim().slice(0, 800)}`);
	return selected.join("\n").slice(0, MAX_CONTEXT_LENGTH);
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	let namingInFlight = false;
	let namingAbort: AbortController | undefined;

	pi.on("before_agent_start", (event, ctx) => {
		if (pi.getSessionName() || !ctx.model || namingInFlight) return;
		namingInFlight = true;
		namingAbort = new AbortController();
		ctx.ui.setStatus("session-title", "Naming session…");

		void (async () => {
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
				if (!auth.ok || !auth.apiKey) return;
				const message: UserMessage = {
					role: "user",
					content: [{ type: "text", text: buildConversationContext(ctx, event.prompt) }],
					timestamp: Date.now(),
				};
				const response = await complete(
					ctx.model!,
					{ systemPrompt: SYSTEM_PROMPT, messages: [message] },
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						signal: namingAbort?.signal,
					},
				);
				const title = normalizeSessionTitle(extractTitleText(response.content));
				if (title && !pi.getSessionName()) pi.setSessionName(title);
			} catch (error) {
				if (!namingAbort?.signal.aborted) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not generate session title: ${message}`, "warning");
				}
			} finally {
				namingInFlight = false;
				namingAbort = undefined;
				ctx.ui.setStatus("session-title", undefined);
			}
		})();
	});

	pi.on("session_shutdown", () => namingAbort?.abort());
}
