import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	CustomEditor,
	getAgentDir,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

import {
	codexQuotaFromUsage,
	codexUsageClient,
	resolveCodexCredentials,
	type CodexQuota,
} from "./lib/codex-usage.ts";
import { MODE_EVENT } from "./plan-mode/index.ts";

/**
 * Cursor sits on `/command` plus at least one trailing space and no argument
 * text yet. That is the state Tab-complete leaves behind, and where Space/Tab
 * should open getArgumentCompletions instead of inserting another space or files.
 */
export function isEmptySlashArgumentContext(textBeforeCursor: string): boolean {
	return /^\/\S+\s+$/.test(textBeforeCursor.trimStart());
}

/** Fully typed slash command name with no trailing space yet. */
export function isBareSlashCommandContext(textBeforeCursor: string): boolean {
	return /^\/\S+$/.test(textBeforeCursor.trimStart());
}

/** Autocomplete prefix for a slash command name (not yet its arguments). */
export function isSlashCommandNamePrefix(prefix: string | undefined): boolean {
	return typeof prefix === "string" && prefix.startsWith("/") && !prefix.slice(1).includes(" ");
}

const RESET_FG = "\x1b[39m";
const FAST_MODE_PATH = join(getAgentDir(), "state", "fast-mode.json");
const FAST_CREDIT_WARNING = "Fast mode uses 2x to 2.5x Codex credits.";
const CODEX_USAGE_POLL_INTERVAL_MS = 60_000;
const CODEX_USAGE_TIMEOUT_MS = 10_000;
const BRANCH_ICON = "";
const WORKTREE_ICON = "󰙅";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const RAIL_LIGHT = "─";
const RAIL_HEAVY = "━";
/** Heavy left half, so the rail creeps by half a column instead of jumping. */
const RAIL_HALF = "╸";
/** An editor border rule, including its `↓ N more` overflow form. */
const EDITOR_RULE_PATTERN = /^[─━╸]+(?: ↓ \d+ more [─━╸]*)?$/u;

export interface GitContext {
	branch?: string;
	isLinkedWorktree: boolean;
}

function color(index: number, text: string): string {
	return `\x1b[38;5;${index}m${text}${RESET_FG}`;
}

function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "");
}

export function wrapFooterSegments(segments: readonly string[], width: number): string[] {
	if (width <= 0) return [""];
	const separator = " · ";
	const lines: string[] = [];
	let current = "";

	for (const segment of segments) {
		if (visibleWidth(segment) > width) {
			if (current) lines.push(current);
			const wrapped = wrapTextWithAnsi(segment, width);
			lines.push(...wrapped.slice(0, -1));
			current = wrapped.at(-1) ?? "";
			continue;
		}

		if (!current) {
			current = segment;
			continue;
		}

		const candidate = `${current}${separator}${segment}`;
		if (visibleWidth(candidate) <= width) current = candidate;
		else {
			lines.push(current);
			current = segment;
		}
	}

	if (current || lines.length === 0) lines.push(current);
	return lines;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

export function formatGitBranch(branch: string, isLinkedWorktree: boolean): string {
	return `${isLinkedWorktree ? WORKTREE_ICON : BRANCH_ICON} ${branch}`;
}

export function formatModelStatus(
	model: string,
	thinkingLevel: string,
	fastMode = false,
	provider?: string,
): string {
	const displayModel = provider === "openrouter" ? model.replace(/^[^:]+:\s*/, "").trim() : model;
	return `${fastMode ? "⚡ " : ""}${displayModel.toLowerCase()} ${thinkingLevel.toLowerCase()}`;
}

export function formatExtensionStatuses(statuses: ReadonlyMap<string, string>): string[] {
	return [...statuses.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, text]) =>
			text
				.replace(/[\r\n\t]/g, " ")
				.replace(/ +/g, " ")
				.trim(),
		)
		.filter(Boolean);
}

export function formatEditorTopBorder(width: number, sessionTitle: string | undefined): string {
	const title = sessionTitle?.trim();
	if (!title || width < 8) return "─".repeat(Math.max(0, width));
	const compactTitle = truncateToWidth(title, Math.max(1, width - 6), "…");
	const suffix = ` ${compactTitle} ──`;
	return `${"─".repeat(Math.max(2, width - visibleWidth(suffix)))}${suffix}`;
}

const CONTEXT_USAGE_TTL_MS = 200;
const SESSION_USAGE_TTL_MS = 200;

type ContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;

interface ContextUsageMemo {
	ctx: ExtensionContext;
	model: ExtensionContext["model"];
	modelId: string | undefined;
	modelName: string | undefined;
	modelProvider: string | undefined;
	contextWindow: number | undefined;
	usage: ContextUsage;
	expiresAt: number;
}

let contextUsageMemo: ContextUsageMemo | undefined;

function getMemoizedContextUsage(ctx: ExtensionContext): ContextUsage {
	const model = ctx.model;
	const modelId = model?.id;
	const modelName = model?.name;
	const modelProvider = model?.provider;
	const contextWindow = model?.contextWindow;
	const now = Date.now();
	if (
		!contextUsageMemo ||
		contextUsageMemo.ctx !== ctx ||
		contextUsageMemo.model !== model ||
		contextUsageMemo.modelId !== modelId ||
		contextUsageMemo.modelName !== modelName ||
		contextUsageMemo.modelProvider !== modelProvider ||
		contextUsageMemo.contextWindow !== contextWindow ||
		now >= contextUsageMemo.expiresAt
	) {
		contextUsageMemo = {
			ctx,
			model,
			modelId,
			modelName,
			modelProvider,
			contextWindow,
			usage: ctx.getContextUsage(),
			expiresAt: now + CONTEXT_USAGE_TTL_MS,
		};
	}
	return contextUsageMemo.usage;
}

/**
 * The host resolves the session name by filtering every session entry and
 * scanning the copy in reverse, so a per-frame call is O(session). The title
 * only changes on rename or when the title extension names a new session, and
 * a sub-second refresh is imperceptible on the editor border.
 */
const SESSION_NAME_TTL_MS = 500;

let sessionNameMemo: { name: string | undefined; expiresAt: number } | undefined;

export function getMemoizedSessionName(read: () => string | undefined): string | undefined {
	const now = Date.now();
	if (!sessionNameMemo || now >= sessionNameMemo.expiresAt) {
		sessionNameMemo = { name: read(), expiresAt: now + SESSION_NAME_TTL_MS };
	}
	return sessionNameMemo.name;
}

/** Drop every per-frame memo whose input a lifecycle event can have changed. */
function invalidateFrameCaches(ctx: ExtensionContext): void {
	if (contextUsageMemo?.ctx === ctx) contextUsageMemo = undefined;
	if (sessionUsageMemo?.ctx === ctx) sessionUsageMemo = undefined;
	sessionNameMemo = undefined;
}

export interface SessionUsageTotals {
	/** Uncached prompt tokens. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Total session cost in USD, zero for subscription-backed models. */
	cost: number;
}

function usageOf(entry: SessionEntry) {
	if (entry.type === "message") {
		if (entry.message.role === "assistant") return entry.message.usage;
		if (entry.message.role === "toolResult") return entry.message.usage;
		return undefined;
	}
	if (entry.type === "branch_summary" || entry.type === "compaction") return entry.usage;
	return undefined;
}

/**
 * Sum every usage-bearing session entry, matching the host footer: assistant
 * messages, summarizing tool results, branch summaries, and compactions.
 */
export function computeSessionUsage(entries: readonly SessionEntry[]): SessionUsageTotals {
	const totals: SessionUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries) {
		const usage = usageOf(entry);
		if (!usage) continue;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		totals.cost += usage.cost?.total ?? 0;
	}
	return totals;
}

/**
 * Session-wide cache hit rate: cache reads over all prompt tokens. Undefined
 * until the session has prompt traffic, so the segment stays hidden.
 */
export function formatCacheHitRate(totals: SessionUsageTotals): string | undefined {
	const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return `cache ${Math.round((totals.cacheRead / promptTokens) * 100)}%`;
}

/** Total session cost, hidden while it is zero (subscription-backed models). */
export function formatSessionCost(totals: SessionUsageTotals): string | undefined {
	if (!(totals.cost > 0)) return undefined;
	return `$${totals.cost.toFixed(2)}`;
}

interface SessionUsageMemo {
	ctx: ExtensionContext;
	totals: SessionUsageTotals;
	expiresAt: number;
}

let sessionUsageMemo: SessionUsageMemo | undefined;

/**
 * Totalling usage walks every session entry, so cache it briefly instead of
 * repeating the scan on each render frame.
 */
function getMemoizedSessionUsage(ctx: ExtensionContext): SessionUsageTotals {
	const now = Date.now();
	if (!sessionUsageMemo || sessionUsageMemo.ctx !== ctx || now >= sessionUsageMemo.expiresAt) {
		const entries = ctx.sessionManager?.getEntries() ?? [];
		sessionUsageMemo = {
			ctx,
			totals: computeSessionUsage(entries),
			expiresAt: now + SESSION_USAGE_TTL_MS,
		};
	}
	return sessionUsageMemo.totals;
}

export function contextRailPercent(ctx: ExtensionContext): number | undefined {
	const usage = getMemoizedContextUsage(ctx);
	const contextWindow = ctx.model?.contextWindow;
	if (!usage || usage.percent === null || !contextWindow) return undefined;
	return Math.min(100, Math.max(0, usage.percent));
}

/**
 * Locate the editor's bottom rule. Autocomplete rows render below it, so the
 * rule is not reliably the last line; index 0 is the top border and is skipped.
 */
export function findEditorRuleIndex(lines: readonly string[]): number {
	for (let index = lines.length - 1; index > 0; index--) {
		if (EDITOR_RULE_PATTERN.test((lines[index] ?? "").replace(ANSI_PATTERN, ""))) return index;
	}
	return -1;
}

/**
 * Split a border rule at `percent`, promoting spent columns to a heavy rule.
 * Only rule glyphs change, so the `↓ N more` indicator survives the overlay.
 */
export function splitContextRail(rule: string, percent: number): { filled: string; free: string } {
	const columns = [...rule];
	const cells = (Math.min(100, Math.max(0, percent)) / 100) * columns.length;
	let cut = Math.floor(cells);
	const filled = columns
		.slice(0, cut)
		.map((column) => (column === RAIL_LIGHT ? RAIL_HEAVY : column));
	if (cells - cut >= 0.5 && columns[cut] === RAIL_LIGHT) {
		filled.push(RAIL_HALF);
		cut += 1;
	}
	return { filled: filled.join(""), free: columns.slice(cut).join("") };
}

export function readGitContext(cwd: string): GitContext {
	try {
		const branch =
			execFileSync("git", ["branch", "--show-current"], {
				cwd,
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined;
		const [gitDir, commonDir] = execFileSync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
			{
				cwd,
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
			},
		)
			.trim()
			.split(/\r?\n/);
		return {
			branch,
			isLinkedWorktree: Boolean(gitDir && commonDir && gitDir !== commonDir),
		};
	} catch {
		return { isLinkedWorktree: false };
	}
}

function formatContext(ctx: ExtensionContext): string | undefined {
	const usage = getMemoizedContextUsage(ctx);
	const contextWindow = ctx.model?.contextWindow;
	if (!usage || usage.percent === null || !contextWindow) return undefined;
	const used = Math.round(usage.tokens / 1000);
	const total = Math.round(contextWindow / 1000);
	return `${used}k/${total}k (${Math.round(usage.percent)}%)`;
}

function isCodexModel(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex";
}

function supportsFastMode(ctx: ExtensionContext): boolean {
	if (!isCodexModel(ctx)) return false;
	const id = ctx.model?.id;
	return id === "gpt-5.4" || id === "gpt-5.5" || id?.startsWith("gpt-5.6-") === true;
}

function quotaColor(remaining: number, healthyColor: number): number {
	if (remaining <= 10) return 203;
	if (remaining <= 30) return 220;
	return healthyColor;
}

function loadFastMode(): boolean {
	try {
		const state = JSON.parse(readFileSync(FAST_MODE_PATH, "utf8")) as { enabled?: unknown };
		return state.enabled === true;
	} catch {
		return false;
	}
}

function saveFastMode(enabled: boolean): void {
	mkdirSync(dirname(FAST_MODE_PATH), { recursive: true });
	const temporary = `${FAST_MODE_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporary, FAST_MODE_PATH);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function piLogo(theme: Theme): string[] {
	const accent = (text: string) => theme.fg("accent", text);
	const padding = " ";
	return [accent(`${padding}████████`), accent(`${padding}  ██  ██`), accent(`${padding}  ██  ██`)];
}

function createHeader(theme: Theme, ctx: ExtensionContext): Component {
	return {
		render(width: number): string[] {
			const logo = piLogo(theme);
			const model = ctx.model?.name ?? ctx.model?.id ?? "No model";
			const provider = ctx.model?.provider ?? "";
			const details = provider ? `${model} · ${provider}` : model;
			const rows = [
				`${logo[0]}  ${theme.bold("Pi Coding Agent")}  ${theme.fg("muted", `v${VERSION}`)}`,
				`${logo[1]}  ${theme.fg("muted", details)}`,
				`${logo[2]}  ${theme.fg("muted", formatCwd(ctx.cwd))}`,
			];
			return ["", ...rows.map((row) => fit(row, width)), ""];
		},
		invalidate() {},
	};
}

class PiEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getSessionTitle: () => string | undefined,
		private readonly getContextRailPercent: () => number | undefined,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
	}

	private textBeforeCursor(): string {
		const { line, col } = this.getCursor();
		return (this.getLines()[line] ?? "").slice(0, col);
	}

	/** Upstream Editor keeps these private; invoke through the instance. */
	private triggerArgumentAutocomplete(explicitTab = false): void {
		(
			this as unknown as { tryTriggerAutocomplete: (explicitTab?: boolean) => void }
		).tryTriggerAutocomplete(explicitTab);
	}

	handleInput(data: string): void {
		const editor = this as unknown as { autocompletePrefix?: string };
		const acceptingCommandName =
			this.isShowingAutocomplete() && isSlashCommandNamePrefix(editor.autocompletePrefix);

		// Tab on `/cmd ` (picker closed) should open argument completions,
		// not fall through to file-path autocomplete.
		if (
			!this.isShowingAutocomplete() &&
			this.keybindings.matches(data, "tui.input.tab") &&
			isEmptySlashArgumentContext(this.textBeforeCursor())
		) {
			this.triggerArgumentAutocomplete(true);
			return;
		}

		const isSpace = data === " " || matchesKey(data, "space");
		if (!this.isShowingAutocomplete() && isSpace) {
			const before = this.textBeforeCursor();
			// Space after Tab-complete (`/cmd `): open args, don't add another space.
			if (isEmptySlashArgumentContext(before)) {
				this.triggerArgumentAutocomplete(false);
				return;
			}
			// Space after a fully typed `/cmd`: insert it, then open args.
			// insertCharacter does not auto-trigger on whitespace.
			if (isBareSlashCommandContext(before)) {
				super.handleInput(data);
				this.triggerArgumentAutocomplete(false);
				return;
			}
		}

		super.handleInput(data);

		// Tab-accepting a command name leaves `/cmd ` with the picker closed.
		// Chain into getArgumentCompletions so branch/worktree/model dropdowns
		// appear without deleting and retyping the space.
		if (
			acceptingCommandName &&
			this.keybindings.matches(data, "tui.input.tab") &&
			!this.isShowingAutocomplete() &&
			isEmptySlashArgumentContext(this.textBeforeCursor())
		) {
			this.triggerArgumentAutocomplete(false);
		}
	}

	render(width: number): string[] {
		const lines = super.render(width);
		const sessionTitle = this.getSessionTitle();
		if (lines.length > 0 && sessionTitle) {
			lines[0] = this.borderColor(formatEditorTopBorder(width, sessionTitle));
		}
		// The bottom rule doubles as a context-usage gauge: spent width is drawn
		// heavy, free width keeps the ordinary border. Same border colour throughout.
		const percent = this.getContextRailPercent();
		const ruleIndex = percent === undefined ? -1 : findEditorRuleIndex(lines);
		if (percent !== undefined && ruleIndex > 0) {
			const rule = (lines[ruleIndex] ?? "").replace(ANSI_PATTERN, "");
			const { filled, free } = splitContextRail(rule, percent);
			lines[ruleIndex] = this.borderColor(`${filled}${free}`);
		}
		return lines;
	}
}

export function createFooter(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	isLinkedWorktree: () => boolean,
	getThinkingLevel: () => string,
	isFastMode: () => boolean,
	getCodexQuota: () => CodexQuota | undefined,
	requestRender: () => void,
	getMode: () => string,
): Component & { dispose: () => void } {
	const unsubscribe = footerData.onBranchChange(requestRender);
	return {
		dispose: unsubscribe,
		render(width: number): string[] {
			const model = ctx.model?.name ?? ctx.model?.id ?? "No model";
			const quota = isCodexModel(ctx) ? getCodexQuota() : undefined;
			const branch = footerData.getGitBranch();
			const mode = getMode();
			const context = formatContext(ctx);
			const sessionUsage = getMemoizedSessionUsage(ctx);
			const cacheHitRate = formatCacheHitRate(sessionUsage);
			const sessionCost = formatSessionCost(sessionUsage);
			const segments = [
				mode === "plan" ? color(214, "plan") : color(78, "auto"),
				branch ? color(150, formatGitBranch(branch, isLinkedWorktree())) : undefined,
				color(117, formatCwd(ctx.cwd)),
				color(
					183,
					formatModelStatus(
						model,
						getThinkingLevel(),
						isFastMode() && supportsFastMode(ctx),
						ctx.model?.provider,
					),
				),
				context ? color(117, context) : undefined,
				cacheHitRate ? color(122, cacheHitRate) : undefined,
				sessionCost ? color(211, sessionCost) : undefined,
				quota?.fiveHourRemaining !== undefined
					? color(quotaColor(quota.fiveHourRemaining, 222), `5h ${quota.fiveHourRemaining}%`)
					: undefined,
				quota?.weeklyRemaining !== undefined
					? color(quotaColor(quota.weeklyRemaining, 150), `7d ${quota.weeklyRemaining}%`)
					: undefined,
			].filter((segment): segment is string => Boolean(segment));

			const extensionStatuses = footerData.getExtensionStatuses();
			const filteredStatuses = new Map(
				[...extensionStatuses].filter(([key]) => key !== "mcp" && key !== "plan-mode"),
			);
			segments.push(...formatExtensionStatuses(filteredStatuses));

			return wrapFooterSegments(segments, width);
		},
		invalidate() {},
	};
}

export default function (pi: ExtensionAPI) {
	let fastMode = loadFastMode();
	let linkedWorktree = false;
	let codexQuota: CodexQuota | undefined;
	let usagePollTimer: ReturnType<typeof setInterval> | undefined;
	let usagePollAbort: AbortController | undefined;
	let usagePollInFlight = false;
	let agentMode = "auto";
	let footerCtx: ExtensionContext | undefined;

	const installFooter = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, _theme, footerData) =>
			createFooter(
				ctx,
				footerData,
				() => linkedWorktree,
				() => pi.getThinkingLevel(),
				() => fastMode,
				() => codexQuota,
				() => tui.requestRender(),
				() => agentMode,
			),
		);
	};

	// plan-mode publishes the active mode; render it far-left in the footer.
	pi.events.on(MODE_EVENT, (data) => {
		const mode = (data as { mode?: string }).mode;
		if (typeof mode !== "string" || mode === agentMode) return;
		agentMode = mode;
		if (footerCtx) installFooter(footerCtx);
	});

	const refreshCodexQuota = async (ctx: ExtensionContext): Promise<void> => {
		if (!isCodexModel(ctx) || usagePollInFlight) return;
		usagePollInFlight = true;
		usagePollAbort = new AbortController();
		const timeout = setTimeout(() => usagePollAbort?.abort(), CODEX_USAGE_TIMEOUT_MS);
		try {
			const credentials = await resolveCodexCredentials(ctx);
			if (!credentials) return;
			const report = await codexUsageClient.getUsage(credentials, {
				signal: usagePollAbort.signal,
			});
			const nextQuota = codexQuotaFromUsage(report);
			if (!nextQuota) return;
			codexQuota = nextQuota;
			installFooter(ctx);
		} catch {
			// Keep the last successful snapshot during transient failures.
		} finally {
			clearTimeout(timeout);
			usagePollAbort = undefined;
			usagePollInFlight = false;
		}
	};

	pi.registerCommand("fast", {
		description: "Toggle Codex Fast mode (higher credit usage)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status") {
				const availability = supportsFastMode(ctx) ? "available" : "unavailable for this model";
				ctx.ui.notify(`Fast mode is ${fastMode ? "on" : "off"} (${availability}).`, "info");
				return;
			}
			if (action && action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "error");
				return;
			}

			const enabled = action === "on" ? true : action === "off" ? false : !fastMode;
			if (enabled && !supportsFastMode(ctx)) {
				ctx.ui.notify("Fast mode requires a supported OpenAI Codex model.", "error");
				return;
			}

			const previous = fastMode;
			fastMode = enabled;
			try {
				saveFastMode(fastMode);
			} catch (error) {
				fastMode = previous;
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save Fast mode: ${message}`, "error");
				return;
			}
			installFooter(ctx);
			ctx.ui.notify(
				fastMode ? `Fast mode enabled. ${FAST_CREDIT_WARNING}` : "Fast mode disabled.",
				fastMode ? "warning" : "info",
			);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fastMode || !supportsFastMode(ctx)) return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		return { ...event.payload, service_tier: "priority" };
	});

	pi.on("message_end", (_event, ctx) => {
		invalidateFrameCaches(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		invalidateFrameCaches(ctx);
		void refreshCodexQuota(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		invalidateFrameCaches(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		invalidateFrameCaches(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		invalidateFrameCaches(ctx);
		installFooter(ctx);
		void refreshCodexQuota(ctx);
	});

	pi.on("session_shutdown", () => {
		if (usagePollTimer) clearInterval(usagePollTimer);
		usagePollTimer = undefined;
		usagePollAbort?.abort();
		usagePollAbort = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		invalidateFrameCaches(ctx);
		if (ctx.mode !== "tui") return;

		if (usagePollTimer) clearInterval(usagePollTimer);
		usagePollTimer = setInterval(() => void refreshCodexQuota(ctx), CODEX_USAGE_POLL_INTERVAL_MS);

		linkedWorktree = readGitContext(ctx.cwd).isLinkedWorktree;

		ctx.ui.setTheme("claude-code");
		ctx.ui.setHeader((_tui, theme) => createHeader(theme, ctx));
		footerCtx = ctx;
		installFooter(ctx);
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new PiEditor(
					tui,
					theme,
					keybindings,
					() => getMemoizedSessionName(() => pi.getSessionName()),
					() => contextRailPercent(ctx),
				),
		);
		void refreshCodexQuota(ctx);
	});
}
