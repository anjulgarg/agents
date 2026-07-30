import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { codexComplete } from "./lib/codex-backend.ts";
import {
	SoftGroupTracker,
	TOOL_CHAT_PADDING,
	bindSoftGroupTracker,
	emptyCollapsedToolRender,
	renderSoftGroupedCall,
	shouldRevealToolDetails,
	type SoftGroupRenderContext,
} from "./lib/tui/index.ts";

// Provider web tools for pi:
// - codex_web_search: ChatGPT/Codex OAuth + native web_search
// - ollama_web_search / ollama_web_fetch: local Ollama experimental APIs
//
// Ollama tools are owned here (not npm:@ollama/pi-web-search) so we can use
// distinct tool names without colliding on the generic `web_search` tool name.

const REASONING_EFFORT = process.env.PI_CODEX_SEARCH_EFFORT ?? "low";
const SEARCH_MODEL = process.env.PI_CODEX_SEARCH_MODEL;
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const INSTRUCTIONS = [
	"You are a web search assistant. Use the web_search tool to research the",
	"user's query, then reply with a concise summary of the findings. Cite each",
	"claim with its source URL.",
].join(" ");

type SearchResponse = {
	results: Array<{
		title: string;
		url: string;
		content: string;
	}>;
};

type FetchResponse = {
	title: string;
	content: string;
	links: string[];
};

export function normalizeSearchQueries(params: { query?: string; queries?: string[] }): string[] {
	if (Array.isArray(params.queries)) {
		const listed = params.queries.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean);
		if (listed.length > 0) {
			return listed;
		}
	}
	if (typeof params.query === "string") {
		const single = params.query.replace(/\s+/g, " ").trim();
		if (single) {
			return [single];
		}
	}
	return [];
}

async function runCodexSearchQuery(query: string, signal?: AbortSignal): Promise<string> {
	const answer = await codexComplete({
		instructions: INSTRUCTIONS,
		input: query,
		tools: [{ type: "web_search" }],
		model: SEARCH_MODEL,
		effort: REASONING_EFFORT,
		signal,
	});
	return answer || "No results returned.";
}

async function runOllamaSearchQuery(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<{ text: string; results: SearchResponse["results"] }> {
	try {
		const response = await fetch(`${OLLAMA_HOST}/api/experimental/web_search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query, max_results: maxResults }),
			signal,
		});
		if (!response.ok) {
			if (response.status === 401) {
				throw new Error("Unauthorized. Run `ollama signin` to authenticate.");
			}
			const errorText = await response.text().catch(() => "");
			throw new Error(
				`Search API error (status ${response.status}): ${errorText || response.statusText}`,
			);
		}
		const data = (await response.json()) as SearchResponse;
		const formatted = data.results
			.map(
				(result, index) =>
					`${index + 1}. ${result.title}\n   URL: ${result.url}\n   ${result.content}`,
			)
			.join("\n\n");
		return { text: formatted || "No results found.", results: data.results };
	} catch (error) {
		if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
			throw new Error(
				`Could not connect to Ollama at ${OLLAMA_HOST}. Make sure Ollama is running and web_search is enabled.`,
			);
		}
		throw error;
	}
}

function renderSearchCall(
	toolName: string,
	tracker: SoftGroupTracker,
	args: { query?: string; queries?: string[] },
	theme: Theme,
	context: SoftGroupRenderContext,
) {
	const queries = normalizeSearchQueries(args);
	const expandedLines =
		queries.length > 1
			? [
					`web search · ${queries.length} queries`,
					...queries.map((query, index) => `${index + 1}. ${query}`),
				]
			: [`web search ${queries.at(-1) || "..."}`];
	return renderSoftGroupedCall({
		tracker,
		groupId: toolName,
		label: "web search",
		summary: queries.length > 1 ? `${queries.length} queries` : queries.at(-1) || "...",
		summaryTail: queries.length > 1 ? queries.at(-1) : undefined,
		unitCount: 1,
		theme: {
			fg: (name, text) => theme.fg(name as Parameters<Theme["fg"]>[0], text),
			bold: (text) => theme.bold(text),
		},
		context,
		expandedLines,
	});
}

function renderSearchResult(result: any, expanded: boolean, theme: any, context: any) {
	const raw = result.content.find((part: any) => part.type === "text")?.text ?? "";
	if (!shouldRevealToolDetails({ expanded, isError: context.isError })) {
		return emptyCollapsedToolRender();
	}
	if (!expanded) {
		const message = raw.replace(/\s+/g, " ").trim() || "Web search failed";
		return new Text(theme.fg("error", message), TOOL_CHAT_PADDING, 0);
	}
	return raw
		? new Text(`\n${theme.fg(context.isError ? "error" : "toolOutput", raw)}`, TOOL_CHAT_PADDING, 0)
		: emptyCollapsedToolRender();
}

export default function (pi: ExtensionAPI) {
	const webToolGroupTracker = new SoftGroupTracker();
	bindSoftGroupTracker(pi as any, webToolGroupTracker, [
		"codex_web_search",
		"ollama_web_search",
		"ollama_web_fetch",
	]);
	const webToolNames = new Set([
		"codex_web_search",
		"ollama_web_search",
		"ollama_web_fetch",
		// Legacy names from npm:@ollama/pi-web-search, kept out of the active set.
		"web_search",
		"web_fetch",
	]);
	const activateProviderTools = (provider: string | undefined): void => {
		const active = pi.getActiveTools().filter((name) => !webToolNames.has(name));
		const selected =
			provider === "openai-codex"
				? ["codex_web_search"]
				: provider === "ollama"
					? ["ollama_web_search", "ollama_web_fetch"]
					: [];
		pi.setActiveTools([...active, ...selected]);
	};

	pi.registerTool({
		name: "codex_web_search",
		label: "Codex Web Search",
		renderShell: "self",
		description:
			"Search the web for real-time information using Codex's native web_search tool. Reuses your existing codex (ChatGPT OAuth) login; no API key required. Prefer `queries` when several searches are known up front.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description: "A single search query. Ignored when `queries` is provided.",
				}),
			),
			queries: Type.Optional(
				Type.Array(
					Type.String({
						description: "Multiple search queries to run in one tool call.",
					}),
					{ minItems: 1 },
				),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const queries = normalizeSearchQueries(params);
			if (queries.length === 0) {
				throw new Error("Provide query or queries.");
			}
			if (queries.length === 1) {
				return {
					content: [{ type: "text", text: await runCodexSearchQuery(queries[0]!, signal) }],
					details: { queries },
				};
			}
			const sections: string[] = [];
			for (const query of queries) {
				sections.push(`### ${query}\n\n${await runCodexSearchQuery(query, signal)}`);
			}
			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: { queries },
			};
		},
		renderCall: (args, theme, context) =>
			renderSearchCall("codex_web_search", webToolGroupTracker, args, theme, context),
		renderResult: (result, { expanded }, theme, context) =>
			renderSearchResult(result, expanded, theme, context),
	});

	pi.registerTool({
		name: "ollama_web_search",
		label: "Ollama Web Search",
		renderShell: "self",
		description:
			"Search the web via local Ollama's experimental web_search API. Requires Ollama running with web search enabled. Prefer `queries` when several searches are known up front.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description: "A single search query. Ignored when `queries` is provided.",
				}),
			),
			queries: Type.Optional(
				Type.Array(
					Type.String({
						description: "Multiple search queries to run in one tool call.",
					}),
					{ minItems: 1 },
				),
			),
			max_results: Type.Optional(
				Type.Number({
					description: "Maximum number of search results per query (default: 5)",
					default: 5,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const queries = normalizeSearchQueries(params);
			if (queries.length === 0) {
				throw new Error("Provide query or queries.");
			}
			const maxResults = params.max_results ?? 5;
			if (queries.length === 1) {
				const single = await runOllamaSearchQuery(queries[0]!, maxResults, signal);
				return {
					content: [{ type: "text", text: single.text }],
					details: { queries, results: single.results },
				};
			}
			const sections: string[] = [];
			const allResults: SearchResponse["results"] = [];
			for (const query of queries) {
				const result = await runOllamaSearchQuery(query, maxResults, signal);
				sections.push(`### ${query}\n\n${result.text}`);
				allResults.push(...result.results);
			}
			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: { queries, results: allResults },
			};
		},
		renderCall: (args, theme, context) =>
			renderSearchCall("ollama_web_search", webToolGroupTracker, args, theme, context),
		renderResult: (result, { expanded }, theme, context) =>
			renderSearchResult(result, expanded, theme, context),
	});

	pi.registerTool({
		name: "ollama_web_fetch",
		label: "Ollama Web Fetch",
		renderShell: "self",
		description:
			"Fetch and extract text content from a URL via local Ollama's experimental web_fetch API.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch and extract content from" }),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const response = await fetch(`${OLLAMA_HOST}/api/experimental/web_fetch`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ url: params.url }),
					signal,
				});
				if (!response.ok) {
					if (response.status === 401) {
						throw new Error("Unauthorized. Run `ollama signin` to authenticate.");
					}
					const errorText = await response.text().catch(() => "");
					throw new Error(
						`Fetch API error (status ${response.status}): ${errorText || response.statusText}`,
					);
				}
				const data = (await response.json()) as FetchResponse;
				const formatted = [
					`Title: ${data.title}`,
					"",
					"Content:",
					data.content,
					"",
					`Links found: ${data.links?.length ?? 0}`,
					...(data.links?.slice(0, 10).map((link) => `  - ${link}`) ?? []),
				].join("\n");
				return {
					content: [{ type: "text", text: formatted }],
					details: {
						title: data.title,
						content: data.content,
						links: data.links,
					},
				};
			} catch (error) {
				if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
					throw new Error(
						`Could not connect to Ollama at ${OLLAMA_HOST}. Make sure Ollama is running and web_fetch is enabled.`,
					);
				}
				throw error;
			}
		},
		renderCall(args, theme, context) {
			const url = typeof args.url === "string" ? args.url.replace(/\s+/g, " ").trim() : "...";
			return renderSoftGroupedCall({
				tracker: webToolGroupTracker,
				groupId: "ollama_web_fetch",
				label: "web fetch",
				summary: url,
				theme: {
					fg: (name, text) => theme.fg(name as Parameters<typeof theme.fg>[0], text),
					bold: (text) => theme.bold(text),
				},
				context,
			});
		},
		renderResult: (result, { expanded }, theme, context) =>
			renderSearchResult(result, expanded, theme, context),
	});

	pi.on("session_start", (_event, ctx) => activateProviderTools(ctx.model?.provider));
	pi.on("model_select", (event) => activateProviderTools(event.model?.provider));
}
