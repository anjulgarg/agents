import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { visibleWidth } from "@earendil-works/pi-tui";
import claudeCodeUi, {
	contextRailPercent,
	createFooter,
	findEditorRuleIndex,
	formatEditorTopBorder,
	formatExtensionStatuses,
	formatGitBranch,
	formatModelStatus,
	getMemoizedSessionName,
	isBareSlashCommandContext,
	isEmptySlashArgumentContext,
	isSlashCommandNamePrefix,
	piLogo,
	readGitContext,
	splitContextRail,
} from "../claude-code-ui.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

assert(
	"empty slash-argument context requires trailing whitespace and no args",
	isEmptySlashArgumentContext("/git:branch ") &&
		isEmptySlashArgumentContext("/git:worktree   ") &&
		!isEmptySlashArgumentContext("/git:worktree") &&
		!isEmptySlashArgumentContext("/git:worktree feat") &&
		!isEmptySlashArgumentContext("not a command"),
	"isEmptySlashArgumentContext",
);
assert(
	"bare slash-command context is a completed name with no trailing space",
	isBareSlashCommandContext("/git:branch") &&
		!isBareSlashCommandContext("/git:branch ") &&
		!isBareSlashCommandContext("/git:branch main"),
	"isBareSlashCommandContext",
);
assert(
	"slash command-name prefixes stop at the first space",
	isSlashCommandNamePrefix("/git:br") &&
		isSlashCommandNamePrefix("/model") &&
		!isSlashCommandNamePrefix("main") &&
		!isSlashCommandNamePrefix("/git:branch "),
	"isSlashCommandNamePrefix",
);

assert(
	"uses one compact icon before the branch",
	formatGitBranch("main", false) === " main" &&
		formatGitBranch("feature/test", true) === "󰙅 feature/test",
	`${formatGitBranch("main", false)} | ${formatGitBranch("feature/test", true)}`,
);
assert(
	"formats model and thinking as compact lowercase text",
	formatModelStatus("GPT-5.6 Sol", "medium") === "gpt-5.6 sol medium",
	formatModelStatus("GPT-5.6 Sol", "medium"),
);
assert(
	"places the Fast mode lightning icon left of the model name",
	formatModelStatus("GPT-5.6 Sol", "medium", true) === "⚡ gpt-5.6 sol medium",
	formatModelStatus("GPT-5.6 Sol", "medium", true),
);
assert(
	"removes OpenRouter's redundant catalog prefix",
	formatModelStatus("DeepSeek: DeepSeek V4 Flash 0731", "xhigh", false, "openrouter") ===
		"deepseek v4 flash 0731 xhigh",
	formatModelStatus("DeepSeek: DeepSeek V4 Flash 0731", "xhigh", false, "openrouter"),
);
assert(
	"preserves colons for non-OpenRouter model names",
	formatModelStatus("Provider: Model", "high", false, "custom") === "provider: model high",
	formatModelStatus("Provider: Model", "high", false, "custom"),
);
const logo = piLogo({ fg: (_color: string, text: string) => text } as any);
assert(
	"aligns the Pi logo with the standard one-column header gutter",
	logo.length === 3 &&
		logo.every((line) => line.startsWith(" ")) &&
		logo.every((line) => visibleWidth(line) === 9),
	JSON.stringify(logo),
);
const titledBorder = formatEditorTopBorder(60, "publish-command-extension");
assert(
	"renders the current session title in the editor top border",
	titledBorder.length === 60 && titledBorder.endsWith(" publish-command-extension ──"),
	titledBorder,
);

// ---- Editor context rail tests ----

const rule = "─".repeat(20);
const empty = splitContextRail(rule, 0);
const quarter = splitContextRail(rule, 25);
const halfCell = splitContextRail(rule, 12.5);
const full = splitContextRail(rule, 100);
assert(
	"the rail fills in proportion and keeps the rule exactly as wide",
	empty.filled === "" &&
		empty.free.length === 20 &&
		quarter.filled === "━".repeat(5) &&
		quarter.free.length === 15 &&
		full.filled === "━".repeat(20) &&
		full.free === "" &&
		[empty, quarter, halfCell, full].every(
			(split) => visibleWidth(split.filled + split.free) === 20,
		),
	JSON.stringify({ empty, quarter, halfCell, full }),
);
assert(
	"a part-spent column renders as a half rule instead of rounding away",
	halfCell.filled === "━━╸" && halfCell.free.length === 17,
	JSON.stringify(halfCell),
);

const overflowRule = `─── ↓ 3 more ${"─".repeat(20)}`;
const overflow = splitContextRail(overflowRule, 30);
assert(
	"filling an overflow rule promotes its rules without eating the indicator",
	overflow.filled.startsWith("━━━") &&
		`${overflow.filled}${overflow.free}`.includes("↓ 3 more") &&
		visibleWidth(overflow.filled + overflow.free) === visibleWidth(overflowRule),
	JSON.stringify(overflow),
);

assert(
	"the rule is found above trailing autocomplete rows and never at the top border",
	findEditorRuleIndex(["─────", " > hi", "─────", " /model", " /help"]) === 2 &&
		findEditorRuleIndex(["─────", " > hi", `─── ↓ 2 more ──`]) === 2 &&
		findEditorRuleIndex(["─────", " > hi"]) === -1,
	JSON.stringify([
		findEditorRuleIndex(["─────", " > hi", "─────", " /model", " /help"]),
		findEditorRuleIndex(["─────", " > hi", "─── ↓ 2 more ──"]),
		findEditorRuleIndex(["─────", " > hi"]),
	]),
);

const railCtx = (tokens: number | undefined, contextWindow?: number) =>
	({
		getContextUsage: () =>
			tokens === undefined
				? undefined
				: { tokens, percent: contextWindow ? (tokens / contextWindow) * 100 : null },
		model: contextWindow ? { contextWindow } : undefined,
	}) as any;
assert(
	"the rail reads real usage and stays absent without a model or usage",
	contextRailPercent(railCtx(34_000, 272_000))?.toFixed(1) === "12.5" &&
		contextRailPercent(railCtx(undefined)) === undefined &&
		contextRailPercent(railCtx(34_000)) === undefined,
	JSON.stringify([
		contextRailPercent(railCtx(34_000, 272_000)),
		contextRailPercent(railCtx(34_000)),
	]),
);

const noop = (): any => undefined;
const alwaysFalse = () => false;
const emptyString = () => "";

// ---- Memoized context usage tests ----

let lookupCount = 0;
const memoCtx: any = {
	cwd: "/home/test",
	model: { name: "gpt-4", id: "gpt-4", provider: "openai", contextWindow: 272_000 },
	getContextUsage: () => {
		lookupCount++;
		return { tokens: 34_000, percent: 12.5 };
	},
};
const memoFooter = createFooter(
	memoCtx,
	makeFooterData([], null),
	alwaysFalse,
	emptyString,
	alwaysFalse,
	noop,
	noop,
	noop,
);
memoFooter.render(120);
contextRailPercent(memoCtx);
memoFooter.render(120);
contextRailPercent(memoCtx);
assert(
	"footer and editor context renders share one lookup inside the TTL",
	lookupCount === 1,
	`getContextUsage calls: ${lookupCount}`,
);
memoFooter.dispose();

const fixedFooterCtx: any = {
	cwd: "/home/test",
	model: { name: "gpt-4", id: "gpt-4", provider: "openai", contextWindow: 272_000 },
	getContextUsage: () => ({ tokens: 34_000, percent: 12.5 }),
};
const fixedFooter = createFooter(
	fixedFooterCtx,
	makeFooterData([], null),
	alwaysFalse,
	emptyString,
	alwaysFalse,
	noop,
	noop,
	noop,
);
const fixedFooterString = fixedFooter.render(120).join("");
assert(
	"fixed usage keeps the current rendered footer string",
	fixedFooterString ===
		"\x1b[38;5;78mauto\x1b[39m · " +
			"\x1b[38;5;117m/home/test\x1b[39m · " +
			"\x1b[38;5;183mgpt-4 \x1b[39m · " +
			"\x1b[38;5;117m34k/272k (13%)\x1b[39m",
	fixedFooterString,
);
fixedFooter.dispose();

let modelLookupCount = 0;
const modelCtx: any = {
	model: { name: "first", id: "first", provider: "openai", contextWindow: 100_000 },
	getContextUsage: () => {
		modelLookupCount++;
		return modelCtx.model.id === "first"
			? { tokens: 10_000, percent: 10 }
			: { tokens: 20_000, percent: 20 };
	},
};
const firstModelPercent = contextRailPercent(modelCtx);
modelCtx.model = { ...modelCtx.model, name: "second", id: "second" };
const secondModelPercent = contextRailPercent(modelCtx);
assert(
	"a changed model is reflected without waiting for the TTL",
	firstModelPercent === 10 && secondModelPercent === 20 && modelLookupCount === 2,
	JSON.stringify({ firstModelPercent, secondModelPercent, modelLookupCount }),
);

let windowLookupCount = 0;
const windowCtx: any = {
	model: { name: "gpt-4", id: "gpt-4", provider: "openai", contextWindow: 100_000 },
	getContextUsage: () => {
		windowLookupCount++;
		return windowCtx.model.contextWindow === 100_000
			? { tokens: 10_000, percent: 10 }
			: { tokens: 20_000, percent: 20 };
	},
};
const firstWindowPercent = contextRailPercent(windowCtx);
windowCtx.model.contextWindow = 200_000;
const secondWindowPercent = contextRailPercent(windowCtx);
assert(
	"a changed context window is reflected without waiting for the TTL",
	firstWindowPercent === 10 && secondWindowPercent === 20 && windowLookupCount === 2,
	JSON.stringify({ firstWindowPercent, secondWindowPercent, windowLookupCount }),
);

const handlers = new Map<string, (event: any, ctx: any) => unknown>();
claudeCodeUi({
	events: { on: () => {} },
	on: (event: string, handler: (event: any, ctx: any) => unknown) => {
		handlers.set(event, handler);
	},
	registerCommand: () => {},
	getThinkingLevel: () => "medium",
} as any);
const invalidationEvents = [
	"message_end",
	"agent_end",
	"agent_settled",
	"session_compact",
	"session_start",
	"model_select",
];
let eventLookupCount = 0;
const eventCtx: any = {
	mode: "cli",
	model: { name: "gpt-4", id: "gpt-4", provider: "openai", contextWindow: 100_000 },
	getContextUsage: () => {
		eventLookupCount++;
		return { tokens: 10_000, percent: 10 };
	},
};
contextRailPercent(eventCtx);
for (const event of invalidationEvents) {
	handlers.get(event)?.({}, eventCtx);
	contextRailPercent(eventCtx);
}
assert(
	"required lifecycle events invalidate context usage immediately",
	invalidationEvents.every((event) => handlers.has(event)) &&
		eventLookupCount === 1 + invalidationEvents.length,
	JSON.stringify({ events: [...handlers.keys()], eventLookupCount }),
);

let sessionNameReads = 0;
const readSessionName = (): string | undefined => {
	sessionNameReads++;
	return "session title";
};
const memoizedTitle = getMemoizedSessionName(readSessionName);
getMemoizedSessionName(readSessionName);
getMemoizedSessionName(readSessionName);
assert(
	"repeated editor renders share one session-name lookup inside the TTL",
	memoizedTitle === "session title" && sessionNameReads === 1,
	`session name reads: ${sessionNameReads}`,
);

for (const event of invalidationEvents) {
	handlers.get(event)?.({}, eventCtx);
	getMemoizedSessionName(readSessionName);
}
assert(
	"required lifecycle events invalidate the memoized session name",
	sessionNameReads === 1 + invalidationEvents.length,
	`session name reads: ${sessionNameReads}`,
);

const root = mkdtempSync(join(tmpdir(), "pi-footer-git-"));
const linked = join(root, "linked");
try {
	git(root, ["init", "-q", "-b", "main"]);
	git(root, ["config", "user.name", "Pi Test"]);
	git(root, ["config", "user.email", "pi@example.invalid"]);
	git(root, ["commit", "--allow-empty", "-qm", "initial"]);

	const primary = readGitContext(root);
	assert(
		"primary checkout shows its branch without a worktree marker",
		primary.branch === "main" && !primary.isLinkedWorktree,
		JSON.stringify(primary),
	);

	git(root, ["worktree", "add", "-qb", "feature/footer-icons", linked]);
	const worktree = readGitContext(linked);
	assert(
		"linked worktree reports its branch and worktree state",
		worktree.branch === "feature/footer-icons" && worktree.isLinkedWorktree,
		JSON.stringify(worktree),
	);

	const outside = readGitContext(tmpdir());
	assert(
		"non-repository paths have no git indicators",
		outside.branch === undefined && !outside.isLinkedWorktree,
		JSON.stringify(outside),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

// ---- Extension status footer inclusion tests ----

// Create a minimal context stub sufficient for createFooter.
const stubCtx: any = {
	cwd: "/home/test",
	model: { name: "gpt-4", id: "gpt-4", provider: "openai" },
	getContextUsage: () => undefined,
};

function makeFooterData(statuses: [string, string][], branch: string | null = "main"): any {
	return {
		getGitBranch: () => branch,
		getExtensionStatuses: () => new Map(statuses),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

const footer1 = createFooter(
	stubCtx,
	makeFooterData([
		["token-speed", "42.3 tok/s"],
		["model", "gpt-4"],
	]),
	alwaysFalse,
	emptyString,
	alwaysFalse,
	noop,
	noop,
	noop,
);
const rendered1 = footer1.render(120);
const joined1 = rendered1.join(" ");
const normalizedStatuses = formatExtensionStatuses(
	new Map([
		["z-status", "  second\nline  "],
		["a-status", "first\tstatus"],
	]),
);
assert(
	"normalizes extension statuses to one line in key order",
	normalizedStatuses.join("|") === "first status|second line",
	JSON.stringify(normalizedStatuses),
);
assert(
	"token-speed status appears in footer when set",
	joined1.includes("42.3 tok/s"),
	JSON.stringify(rendered1),
);
assert(
	"model extension status appears in footer",
	joined1.includes("gpt-4"),
	JSON.stringify(rendered1),
);

// Ordering: sorted by key. "model" < "token-speed" lexicographically.
const modelIdx = joined1.indexOf("gpt-4");
const speedIdx = joined1.indexOf("42.3 tok/s");
assert(
	"extension statuses appear sorted by key (model before token-speed)",
	modelIdx >= 0 && speedIdx >= 0 && modelIdx < speedIdx,
	`model at ${modelIdx}, speed at ${speedIdx}: ${JSON.stringify(rendered1)}`,
);

// No statuses registered: footer still renders without crash.
const footer2 = createFooter(
	stubCtx,
	makeFooterData([]),
	alwaysFalse,
	emptyString,
	alwaysFalse,
	noop,
	noop,
	noop,
);
const rendered2 = footer2.render(120);
assert(
	"footer renders without crashing when no extension statuses are set",
	Array.isArray(rendered2) &&
		rendered2.length > 0 &&
		rendered2.some((l) => l.includes("/home/test")),
	JSON.stringify(rendered2),
);

// FooterData with extension statuses that are undefined/falsy are skipped.
const footer3 = createFooter(
	stubCtx,
	makeFooterData([
		["empty", ""],
		["token-speed", "99.9 tok/s"],
	]),
	alwaysFalse,
	emptyString,
	alwaysFalse,
	noop,
	noop,
	noop,
);
const rendered3Lines = footer3.render(120);
assert(
	"empty extension status values are excluded from footer",
	!rendered3Lines.some((l) => l.includes("empty")),
	JSON.stringify(rendered3Lines),
);
assert(
	"non-empty extension status still appears when empty ones exist",
	rendered3Lines.some((l) => l.includes("99.9 tok/s")),
	JSON.stringify(rendered3Lines),
);

// MCP status key must be excluded from footer; other statuses remain sorted/rendered.
const footer5 = createFooter(
	stubCtx,
	makeFooterData([
		["mcp", "MCP: 0/1 servers"],
		["model", "gpt-4"],
		["token-speed", "42.3 tok/s"],
	]),
	alwaysFalse,
	emptyString,
	alwaysFalse,
	noop,
	noop,
	noop,
);
const rendered5Line = footer5.render(120).join(" ");
const mcpText = "MCP: 0/1 servers";
const mcpFragments = ["MCP:", "0/1", "servers"];
assert(
	"MCP server status is excluded from the footer",
	!rendered5Line.includes(mcpText) && mcpFragments.every((f) => !rendered5Line.includes(f)),
	`MCP text found in: ${JSON.stringify(rendered5Line)}`,
);
assert(
	"model extension status still appears alongside token-speed when MCP is excluded",
	rendered5Line.includes("gpt-4") && rendered5Line.includes("42.3 tok/s"),
	JSON.stringify(rendered5Line),
);
const modelIdx5 = rendered5Line.indexOf("gpt-4");
const speedIdx5 = rendered5Line.indexOf("42.3 tok/s");
assert(
	"non-MCP extension statuses remain sorted by key (model before token-speed)",
	modelIdx5 >= 0 && speedIdx5 >= 0 && modelIdx5 < speedIdx5,
	`model at ${modelIdx5}, speed at ${speedIdx5}: ${JSON.stringify(rendered5Line)}`,
);

// Three statuses: verify lexicographic order a < b < c.
const footer4 = createFooter(
	stubCtx,
	makeFooterData([
		["z-status", "last"],
		["a-status", "first"],
		["m-status", "middle"],
	]),
	alwaysFalse,
	emptyString,
	alwaysFalse,
	noop,
	noop,
	noop,
);
const rendered4Line = footer4.render(120).join(" ");
const aIdx = rendered4Line.indexOf("first");
const mIdx = rendered4Line.indexOf("middle");
const zIdx = rendered4Line.indexOf("last");
assert(
	"three extension statuses appear in lexicographic key order",
	aIdx >= 0 && mIdx >= 0 && zIdx >= 0 && aIdx < mIdx && mIdx < zIdx,
	`a=${aIdx} m=${mIdx} z=${zIdx}: ${JSON.stringify(rendered4Line)}`,
);
