import { appendFileSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

import findExtension, {
	createSessionPinStore,
	discoverSessionFiles,
	FindSessionsView,
	extractEntryText,
	findTextMatchRanges,
	resolveSessionSearchRoot,
	SessionSearchIndex,
} from "../find/index.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function entry(type: string, values: Record<string, unknown>): Record<string, unknown> {
	return {
		type,
		id: Math.random().toString(16).slice(2, 10),
		parentId: null,
		timestamp: new Date().toISOString(),
		...values,
	};
}

function writeSession(
	path: string,
	options: { id: string; cwd: string; name?: string; user: string; assistant: string },
): void {
	const records: unknown[] = [
		{
			type: "session",
			version: 3,
			id: options.id,
			cwd: options.cwd,
			timestamp: "2026-01-01T00:00:00.000Z",
		},
		...(options.name ? [entry("session_info", { name: options.name })] : []),
		entry("message", { message: { role: "user", content: options.user, timestamp: Date.now() } }),
		entry("message", {
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: options.assistant },
					{
						type: "toolCall",
						id: "tool-1",
						name: "read",
						arguments: { path: "/tool-call-only-secret" },
					},
					{ type: "thinking", thinking: "reasoning-only-secret" },
				],
				timestamp: Date.now(),
			},
		}),
		entry("message", {
			message: {
				role: "toolResult",
				toolName: "read",
				toolCallId: "tool-1",
				content: [{ type: "text", text: "tool-result-only-secret" }],
				isError: false,
				timestamp: Date.now(),
			},
		}),
	];
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const assistantExtraction = extractEntryText(
	entry("message", {
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "visible answer" },
				{ type: "toolCall", name: "bash", arguments: { command: "hidden command" } },
				{ type: "thinking", thinking: "hidden reasoning" },
			],
		},
	}),
);
assert(
	"assistant extraction keeps text but excludes tool calls and thinking",
	assistantExtraction.length === 1 && assistantExtraction[0]?.text === "visible answer",
	JSON.stringify(assistantExtraction),
);
const indexRanges = findTextMatchRanges("…loaded from src/index.ts", "index");
assert(
	"exact highlight ranges preserve indices after a Unicode ellipsis",
	indexRanges.length === 1 &&
		"…loaded from src/index.ts".slice(indexRanges[0]!.start, indexRanges[0]!.end) === "index",
	JSON.stringify(indexRanges),
);
assert(
	"tool results are excluded from extraction",
	extractEntryText(
		entry("message", {
			message: { role: "toolResult", content: [{ type: "text", text: "hidden result" }] },
		}),
	).length === 0,
	"tool result was indexed",
);
const bashExtraction = extractEntryText(
	entry("message", {
		message: { role: "bashExecution", command: "gh pr view 123", output: "private output" },
	}),
);
assert(
	"user-entered shell commands are searchable without indexing their output",
	bashExtraction.length === 1 &&
		bashExtraction[0]?.text === "gh pr view 123" &&
		!bashExtraction[0]?.text.includes("private output"),
	JSON.stringify(bashExtraction),
);

const tempRoot = mkdtempSync(join(tmpdir(), "pi-find-extension-"));
try {
	const projectA = join(tempRoot, "project-a");
	const projectB = join(tempRoot, "project-b");
	const sessionsA = join(tempRoot, "sessions-a");
	const sessionsB = join(tempRoot, "sessions-b");
	mkdirSync(projectA);
	mkdirSync(projectB);
	mkdirSync(sessionsA);
	mkdirSync(sessionsB);
	const firstPath = join(sessionsA, "first.jsonl");
	const secondPath = join(sessionsB, "second.jsonl");
	writeSession(firstPath, {
		id: "first-session",
		cwd: projectA,
		name: "Historic Finder",
		user: "Working on https://github.com/acme/widgets/pull/123 and session discovery",
		assistant:
			"Implementing the historic session finder now; the real corpus indexes in under a second",
	});
	writeSession(secondPath, {
		id: "second-session",
		cwd: projectB,
		name: "Authentication Rewrite",
		user: "Please redesign the authentication middleware for the service",
		assistant:
			"The authentication middleware redesign is complete; this corpus mentions an unrelated search index",
	});
	writeFileSync(join(sessionsA, "broken.jsonl"), "{not-json}\n");
	const linked = join(sessionsA, "linked.jsonl");
	symlinkSync(secondPath, linked, "file");

	const discoveredA = await discoverSessionFiles(sessionsA);
	assert(
		"discovery ignores symlinked session files",
		discoveredA.some(({ path }) => path === firstPath) &&
			!discoveredA.some(({ path }) => path === linked || path === secondPath),
		JSON.stringify(discoveredA),
	);

	const index = new SessionSearchIndex();
	const initial = await index.refresh(tempRoot);
	assert(
		"initial refresh indexes all regular historical session files and tolerates malformed files",
		index.size === 3 && initial.indexed === 3 && initial.malformedLines === 1,
		JSON.stringify({ size: index.size, initial }),
	);

	const pinStatePath = join(tempRoot, "state", "session-pins.json");
	const pinStore = createSessionPinStore(pinStatePath);
	assert(
		"pin store starts empty",
		(await pinStore.read()).size === 0,
		JSON.stringify([...(await pinStore.read())]),
	);
	assert(
		"pin store persists an absolute session path atomically",
		(await pinStore.setPinned(secondPath, true)) &&
			(await pinStore.read()).has(secondPath) &&
			(statSync(pinStatePath).mode & 0o777) === 0o600,
		JSON.stringify([...(await pinStore.read())]),
	);
	assert(
		"pin updates are idempotent",
		!(await pinStore.setPinned(secondPath, true)),
		"duplicate pin reported a change",
	);
	const pinnedOrder = index.search("", { pinnedPaths: await pinStore.read() });
	assert(
		"pinned sessions rank before newer unpinned sessions",
		pinnedOrder[0]?.path === secondPath && pinnedOrder[0].pinned,
		JSON.stringify(pinnedOrder.map(({ path, pinned }) => ({ path, pinned }))),
	);
	const exact = index.search("https://github.com/acme/widgets/pull/123");
	assert(
		"exact pull request URLs rank their matching session first with a contextual snippet",
		exact[0]?.path === firstPath && exact[0].snippet.includes("pull/123"),
		JSON.stringify(exact),
	);
	const incomplete = index.search("hist sess find");
	assert(
		"incomplete words find the intended session",
		incomplete[0]?.path === firstPath,
		JSON.stringify(incomplete),
	);
	const typo = index.search("autentication midleware");
	const typoHighlights = typo[0]?.matchRanges.map(({ start, end }) =>
		typo[0]!.snippet.slice(start, end).toLowerCase(),
	);
	assert(
		"misspelled words find and identify the corrected source words",
		typo[0]?.path === secondPath &&
			typoHighlights?.includes("authentication") === true &&
			typoHighlights.includes("middleware"),
		JSON.stringify({ typo, typoHighlights }),
	);
	assert(
		"tool calls, tool results, and assistant reasoning are absent from search",
		index.search("tool-call-only-secret").length === 0 &&
			index.search("tool-result-only-secret").length === 0 &&
			index.search("reasoning-only-secret").length === 0,
		JSON.stringify({
			call: index.search("tool-call-only-secret"),
			result: index.search("tool-result-only-secret"),
			reasoning: index.search("reasoning-only-secret"),
		}),
	);
	const corpusResults = index.search("corpus indexes");
	assert(
		"an exact phrase in the active session outranks loose fuzzy terms elsewhere",
		corpusResults[0]?.path === firstPath &&
			corpusResults[0].snippet.toLowerCase().includes("corpus indexes") &&
			!corpusResults.some(({ path }) => path === secondPath),
		JSON.stringify(corpusResults),
	);
	assert(
		"current-project scope includes the active session",
		index.search("session discovery", { cwd: projectA })[0]?.path === firstPath &&
			index.search("authentication", { cwd: projectA }).length === 0 &&
			index.search("authentication", { cwd: projectB })[0]?.path === secondPath,
		"scope mismatch",
	);
	const currentStyles: string[] = [];
	const currentTheme = {
		fg: (color: string, text: string) => {
			currentStyles.push(`fg:${color}:${text}`);
			return text;
		},
		bg: (color: string, text: string) => {
			currentStyles.push(`bg:${color}:${text}`);
			return text;
		},
		bold: (text: string) => text,
		inverse: (text: string) => {
			currentStyles.push(`inverse:${text}`);
			return text;
		},
	} as any;
	const currentTui = { terminal: { rows: 18 }, requestRender: () => undefined } as any;
	const currentView = new FindSessionsView(
		index,
		currentTheme,
		"corpus indexes",
		projectA,
		firstPath,
		new Set(),
		async () => undefined,
		() => undefined,
		currentTui,
	);
	currentView.setReady(initial);
	const currentRendered = currentView.render(80);
	const currentTitleLine = currentRendered.findIndex((line) => line.includes("Historic Finder"));
	assert(
		"session cards identify the active session, highlight matched text, and add separation",
		currentRendered.join("\n").includes("current · project-a") &&
			currentRendered.join("\n").includes("corpus indexes") &&
			currentStyles.some((style) => style === "inverse:corpus indexes") &&
			currentStyles.some((style) => style === "fg:accent:project-a") &&
			currentStyles.some((style) => style === "fg:success:current") &&
			currentTitleLine >= 0 &&
			currentRendered[currentTitleLine + 2]?.trim() === "",
		currentRendered.join("\\n"),
	);

	appendFileSync(
		firstPath,
		`${JSON.stringify(entry("message", { message: { role: "user", content: "newly appended searchable phrase" } }))}\n`,
	);
	const refreshed = await index.refresh(tempRoot);
	assert(
		"incremental refresh reparses only changed files and exposes appended conversation text",
		refreshed.indexed === 1 &&
			refreshed.unchanged === 2 &&
			index.search("newly appended")[0]?.path === firstPath,
		JSON.stringify(refreshed),
	);
	rmSync(secondPath);
	const removed = await index.refresh(tempRoot);
	assert(
		"refresh removes deleted sessions from the in-memory index",
		removed.removed === 1 && index.search("authentication").length === 0,
		JSON.stringify(removed),
	);

	const agentRoot = join(tempRoot, "agent-sessions");
	assert(
		"default project session directories resolve to the all-project root",
		resolveSessionSearchRoot(join(agentRoot, "--project--"), agentRoot) === agentRoot &&
			resolveSessionSearchRoot(sessionsA, agentRoot) === sessionsA,
		"root resolution mismatch",
	);

	const commands = new Map<string, any>();
	findExtension(
		{
			registerCommand(name: string, definition: any) {
				commands.set(name, definition);
			},
		} as any,
		pinStore,
	);
	const command = commands.get("session:find");
	const pinCommand = commands.get("session:pin");
	const unpinCommand = commands.get("session:unpin");
	assert(
		"registers finder pin commands without retaining the /find alias",
		Boolean(command) && Boolean(pinCommand) && Boolean(unpinCommand) && !commands.has("find"),
		JSON.stringify([...commands.keys()]),
	);

	const notifications: Array<{ message: string; type?: string }> = [];
	const pinCommandContext = {
		sessionManager: { getSessionFile: () => firstPath },
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	};
	await pinCommand.handler("", pinCommandContext);
	await pinCommand.handler("", pinCommandContext);
	assert(
		"/session:pin pins the active session idempotently",
		(await pinStore.read()).has(firstPath) &&
			notifications.some(({ message }) => message === "Session is already pinned"),
		JSON.stringify({ pins: [...(await pinStore.read())], notifications }),
	);
	await unpinCommand.handler("", pinCommandContext);
	await unpinCommand.handler("", pinCommandContext);
	assert(
		"/session:unpin removes only the active session idempotently",
		!(await pinStore.read()).has(firstPath) &&
			(await pinStore.read()).has(secondPath) &&
			notifications.some(({ message }) => message === "Session is not pinned"),
		JSON.stringify({ pins: [...(await pinStore.read())], notifications }),
	);
	let switchedPath: string | undefined;
	let overlayOptions: any;
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => text,
	} as any;
	const tui = { terminal: { rows: 18 }, requestRender: () => undefined } as any;
	const selected = secondPath;
	writeSession(selected, {
		id: "second-session-restored",
		cwd: projectB,
		user: "resume target conversation with authentication middleware",
		assistant: "ready to resume",
	});
	await command.handler("authentication middleware", {
		mode: "tui",
		cwd: projectA,
		sessionManager: {
			getSessionFile: () => firstPath,
			getSessionDir: () => tempRoot,
		},
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			custom: async (factory: any, options: any) => {
				overlayOptions = options;
				return new Promise<string | null>((resolveResult, reject) => {
					const component = factory(tui, theme, undefined, resolveResult);
					let attempts = 0;
					let toggledPin = false;
					const choose = () => {
						try {
							const rendered = component.render(80);
							const output = rendered.join("\n");
							assert(
								"find view remains width-bounded",
								rendered.every((line: string) => visibleWidth(line) === 80),
								rendered.map((line: string) => visibleWidth(line)).join(","),
							);
							if (output.includes("Indexing historical sessions")) {
								if (++attempts > 100) throw new Error("find view did not finish indexing");
								setTimeout(choose, 5);
								return;
							}
							if (!toggledPin) {
								assert(
									"find view marks pinned results and offers in-place unpinning",
									output.includes("📌") && output.includes("Ctrl+P") && output.includes("unpin"),
									output,
								);
								toggledPin = true;
								component.handleInput("\x10");
								setTimeout(choose, 5);
								return;
							}
							if (output.includes("📌")) {
								if (++attempts > 100) throw new Error("find view did not finish unpinning");
								setTimeout(choose, 5);
								return;
							}
							assert(
								"find view updates the selected result after unpinning",
								output.includes("Ctrl+P") && output.includes("pin"),
								output,
							);
							component.handleInput("\r");
						} catch (error) {
							reject(error);
						}
					};
					choose();
				});
			},
		},
		switchSession: async (path: string, options: any) => {
			switchedPath = path;
			await options.withSession({
				ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
			});
			return { cancelled: false };
		},
	});
	assert(
		"finder unpins the selected session before resuming it",
		switchedPath === selected &&
			overlayOptions?.overlay === true &&
			!(await pinStore.read()).has(selected) &&
			notifications.some(({ message }) => message === "Resumed matching session"),
		JSON.stringify({
			switchedPath,
			overlayOptions,
			pins: [...(await pinStore.read())],
			notifications,
		}),
	);

	let nonInteractiveNotified = false;
	await command.handler("query", {
		mode: "print",
		ui: { notify: () => (nonInteractiveNotified = true) },
	});
	assert(
		"noninteractive /session:find fails before indexing",
		nonInteractiveNotified,
		"missing error",
	);
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("All find extension tests passed.");
