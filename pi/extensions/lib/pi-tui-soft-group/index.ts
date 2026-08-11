import {
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";

/** Matches host TOOL_CHAT_PADDING / MCP CHAT_PADDING. */
const CHAT_PADDING = 1;
/** ~30fps. Position is interpolated in colour, so extra frames buy nothing. */
const SHIMMER_FRAME_INTERVAL_MS = 33;
/** Rows that settle faster than this never animate, so they cannot flash. */
const SHIMMER_DELAY_MS = 220;
/** Amplitude ramp so the band grows in instead of popping on. */
const SHIMMER_FADE_IN_MS = 300;
/** One travel across the row, then a rest with the band parked off-screen. */
const SHIMMER_SWEEP_MS = 1_250;
const SHIMMER_REST_MS = 320;
const SHIMMER_CYCLE_MS = SHIMMER_SWEEP_MS + SHIMMER_REST_MS;
/** Band half-width relative to row width, clamped for narrow and wide rows. */
const SHIMMER_BAND_RATIO = 0.2;
const SHIMMER_BAND_MIN_COLUMNS = 6;
const SHIMMER_BAND_MAX_COLUMNS = 22;
/** The trailing edge lingers, which reads as motion instead of a blob. */
const SHIMMER_TRAIL_STRETCH = 1.75;
/** Quantisation steps between resting colour and highlight core. */
const SHIMMER_LEVELS = 24;
/** Share of an elided tail spent on its end, where the basename lives. */
const TAIL_END_SHARE = 0.6;
/** Floor for the elidable head, so a search always shows part of its pattern. */
const MIN_HEAD_COLUMNS = 12;
/** Room the tail needs before the head is entitled to its floor. */
const MIN_TAIL_COLUMNS = 16;
const ANSI_PATTERN =
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const ACTIVITY_STATE_KEY = "__piToolActivity";

export type ToolActivityTheme = {
	fg: (name: string, text: string) => string;
	bold?: (text: string) => string;
	/**
	 * Optional shimmer endpoints as `[resting, highlight]` hex colours.
	 * When omitted the ramp is probed from `fg("muted")` and `fg("text")`.
	 */
	shimmerRamp?: readonly [string, string];
};

export type ToolActivityRenderContext = {
	toolCallId?: string;
	executionStarted?: boolean;
	isPartial?: boolean;
	state?: Record<string, unknown>;
	invalidate?: () => void;
};

export type ToolActivitySnapshot = {
	active: boolean;
	elapsedMs?: number;
	startedAt?: number;
	endedAt?: number;
};

type ToolActivityState = {
	startedAt?: number;
	endedAt?: number;
};

const activeInvalidators = new Map<string, () => void>();
const fallbackActivityStates = new Map<string, ToolActivityState>();
let shimmerTimer: ReturnType<typeof setInterval> | undefined;

function startShimmerClock(): void {
	if (shimmerTimer || activeInvalidators.size === 0) return;
	shimmerTimer = setInterval(() => {
		for (const [toolCallId, invalidate] of activeInvalidators) {
			try {
				invalidate();
			} catch {
				activeInvalidators.delete(toolCallId);
			}
		}
		if (activeInvalidators.size === 0) stopShimmerClock();
	}, SHIMMER_FRAME_INTERVAL_MS);
	const timer = shimmerTimer as ReturnType<typeof setInterval> & { unref?: () => void };
	timer.unref?.();
}

function stopShimmerClock(): void {
	if (shimmerTimer) clearInterval(shimmerTimer);
	shimmerTimer = undefined;
}

function activityState(context: ToolActivityRenderContext): ToolActivityState | undefined {
	const toolCallId = context.toolCallId?.trim();
	if (!toolCallId) return undefined;
	if (context.state && typeof context.state === "object") {
		const carrier = context.state as Record<string, unknown>;
		const existing = carrier[ACTIVITY_STATE_KEY];
		if (existing && typeof existing === "object") return existing as ToolActivityState;
		const created: ToolActivityState = {};
		carrier[ACTIVITY_STATE_KEY] = created;
		return created;
	}
	let fallback = fallbackActivityStates.get(toolCallId);
	if (!fallback) {
		fallback = {};
		fallbackActivityStates.set(toolCallId, fallback);
	}
	return fallback;
}

/** Synchronize row-local timing and the single process-wide shimmer clock. */
export function syncToolActivity(
	context: ToolActivityRenderContext,
	now = Date.now(),
): ToolActivitySnapshot {
	const toolCallId = context.toolCallId?.trim();
	const state = activityState(context);
	const active = context.executionStarted === true && context.isPartial === true;
	if (active && state) {
		state.startedAt ??= now;
		state.endedAt = undefined;
		if (toolCallId && context.invalidate) {
			activeInvalidators.set(toolCallId, context.invalidate);
			startShimmerClock();
		}
	} else if (state?.startedAt !== undefined && state.endedAt === undefined) {
		state.endedAt = now;
		if (toolCallId) activeInvalidators.delete(toolCallId);
		if (activeInvalidators.size === 0) stopShimmerClock();
	} else if (toolCallId && !active) {
		activeInvalidators.delete(toolCallId);
		if (activeInvalidators.size === 0) stopShimmerClock();
	}
	const end = active ? now : state?.endedAt;
	return {
		active,
		startedAt: state?.startedAt,
		endedAt: state?.endedAt,
		elapsedMs:
			state?.startedAt === undefined || end === undefined
				? undefined
				: Math.max(0, end - state.startedAt),
	};
}

export function formatToolDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	return `${(Math.max(0, durationMs) / 1000).toFixed(1)}s`;
}

/** Read the current elapsed time for a live activity row, with a snapshot fallback. */
export function liveToolElapsedMs(activity: ToolActivitySnapshot): number {
	if (activity.active && activity.startedAt !== undefined && Number.isFinite(activity.startedAt)) {
		return Math.max(0, Date.now() - activity.startedAt);
	}
	return Math.max(0, activity.elapsedMs ?? 0);
}

/** Format the elapsed time shown beside a live activity row. */
export function formatLiveToolDuration(activity: ToolActivitySnapshot): string {
	return formatToolDuration(liveToolElapsedMs(activity)) ?? "0.0s";
}

function liveDurationSuffix(activity: ToolActivitySnapshot): string {
	return ` · ${formatLiveToolDuration(activity)}`;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function trimRenderedLineEnd(text: string): string {
	return text.replace(/\s+((?:\x1b\[[0-9;]*m)*)$/, "$1");
}

type Rgb = readonly [number, number, number];

/** A rendered character plus the SGR attributes it inherited from the row. */
type StyledCharacter = { text: string; attrs: string; width: number };

/** Pre-rendered foreground escapes, index `0` resting to `SHIMMER_LEVELS` lit. */
type ShimmerPalette = readonly string[];

const XTERM_CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;
const XTERM_SYSTEM_RGB: readonly Rgb[] = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];
/** SGR attributes worth carrying through the sweep, keyed by set/reset code. */
const SGR_ATTRIBUTES = new Map([
	[1, "1"],
	[3, "3"],
	[4, "4"],
	[7, "7"],
	[9, "9"],
]);
const SGR_ATTRIBUTE_RESETS = new Map([
	[22, "1"],
	[23, "3"],
	[24, "4"],
	[27, "7"],
	[29, "9"],
]);
const PROBE_MARKER = "\u0000";

const shimmerPalettes = new WeakMap<object, ShimmerPalette | null>();

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Read per palette build (once per theme), so tests can vary the terminal. */
function colorDepth(): 24 | 8 | 0 {
	const env =
		(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
	const term = (env.TERM ?? "").toLowerCase();
	const colorterm = (env.COLORTERM ?? "").toLowerCase();
	if (env.NO_COLOR !== undefined || term === "dumb") return 0;
	return colorterm.includes("truecolor") || colorterm.includes("24bit") || term.includes("direct")
		? 24
		: 8;
}

function xtermRgb(index: number): Rgb {
	if (index < 16) return XTERM_SYSTEM_RGB[index] ?? [128, 128, 128];
	if (index < 232) {
		const offset = index - 16;
		const channel = (value: number): number => XTERM_CUBE_STEPS[value] ?? 0;
		return [
			channel(Math.floor(offset / 36) % 6),
			channel(Math.floor(offset / 6) % 6),
			channel(offset % 6),
		];
	}
	const gray = 8 + Math.min(23, index - 232) * 10;
	return [gray, gray, gray];
}

function nearestXtermIndex(color: Rgb): number {
	const cube = color.map((channel) => {
		let best = 0;
		for (let step = 1; step < XTERM_CUBE_STEPS.length; step++) {
			const candidate = XTERM_CUBE_STEPS[step] ?? 0;
			if (Math.abs(candidate - channel) < Math.abs((XTERM_CUBE_STEPS[best] ?? 0) - channel)) {
				best = step;
			}
		}
		return best;
	});
	const cubeIndex = 16 + (cube[0] ?? 0) * 36 + (cube[1] ?? 0) * 6 + (cube[2] ?? 0);
	const average = ((color[0] ?? 0) + (color[1] ?? 0) + (color[2] ?? 0)) / 3;
	const grayIndex = 232 + Math.round(clamp01((average - 8) / 230) * 23);
	const distance = (index: number): number => {
		const candidate = xtermRgb(index);
		return (
			(candidate[0] - color[0]) ** 2 +
			(candidate[1] - color[1]) ** 2 +
			(candidate[2] - color[2]) ** 2
		);
	};
	return distance(grayIndex) <= distance(cubeIndex) ? grayIndex : cubeIndex;
}

/**
 * Interpolate in sRGB. Linear-light blending would brighten the faint tail of
 * the band far more than the intensity curve intends, giving it a hard edge.
 */
function mixColors(from: Rgb, to: Rgb, ratio: number): Rgb {
	const channel = (start: number, end: number): number =>
		Math.round(start + (end - start) * clamp01(ratio));
	return [channel(from[0], to[0]), channel(from[1], to[1]), channel(from[2], to[2])];
}

function relativeLuminance(color: Rgb): number {
	return (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
}

/** Light resting colours imply a light terminal, where a glare would vanish. */
function highlightFor(base: Rgb): Rgb {
	return relativeLuminance(base) > 0.62
		? mixColors(base, [12, 12, 12], 0.72)
		: mixColors(base, [255, 255, 255], 0.82);
}

function parseHexColor(value: string): Rgb | undefined {
	const digits = value.trim().replace(/^#/, "");
	const expanded =
		digits.length === 3 ? digits.replace(/./g, (character) => character + character) : digits;
	if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return undefined;
	return [
		Number.parseInt(expanded.slice(0, 2), 16),
		Number.parseInt(expanded.slice(2, 4), 16),
		Number.parseInt(expanded.slice(4, 6), 16),
	];
}

function foregroundFromSgr(text: string): Rgb | undefined {
	let found: Rgb | undefined;
	for (const match of text.matchAll(/\x1b\[([\d;]*)m/g)) {
		const params = (match[1] ?? "").split(";").map((part) => Number.parseInt(part, 10) || 0);
		for (let index = 0; index < params.length; index++) {
			const code = params[index] ?? 0;
			if (code === 0 || code === 39) found = undefined;
			else if (code >= 30 && code <= 37) found = xtermRgb(code - 30);
			else if (code >= 90 && code <= 97) found = xtermRgb(code - 90 + 8);
			else if (code === 38 && params[index + 1] === 5) {
				found = xtermRgb(params[index + 2] ?? 0);
				index += 2;
			} else if (code === 38 && params[index + 1] === 2) {
				found = [params[index + 2] ?? 0, params[index + 3] ?? 0, params[index + 4] ?? 0];
				index += 4;
			}
		}
	}
	return found;
}

function probeThemeColor(theme: ToolActivityTheme, name: string): Rgb | undefined {
	let painted: string;
	try {
		painted = theme.fg(name, PROBE_MARKER);
	} catch {
		return undefined;
	}
	const marker = painted.indexOf(PROBE_MARKER);
	return foregroundFromSgr(marker < 0 ? painted : painted.slice(0, marker));
}

function buildShimmerPalette(theme: ToolActivityTheme): ShimmerPalette | undefined {
	const depth = colorDepth();
	if (depth === 0) return undefined;
	const ramp = theme.shimmerRamp;
	const base =
		(ramp && parseHexColor(ramp[0])) ??
		probeThemeColor(theme, "muted") ??
		probeThemeColor(theme, "dim");
	if (!base) return undefined;
	const peak =
		(ramp && parseHexColor(ramp[1])) ?? probeThemeColor(theme, "text") ?? highlightFor(base);
	const sequences: string[] = [];
	for (let step = 0; step <= SHIMMER_LEVELS; step++) {
		const color = mixColors(base, peak, step / SHIMMER_LEVELS);
		sequences.push(
			depth === 24
				? `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`
				: `\x1b[38;5;${nearestXtermIndex(color)}m`,
		);
	}
	return sequences;
}

function shimmerPalette(theme: ToolActivityTheme): ShimmerPalette | undefined {
	const cached = shimmerPalettes.get(theme);
	if (cached !== undefined) return cached ?? undefined;
	const palette = buildShimmerPalette(theme);
	shimmerPalettes.set(theme, palette ?? null);
	return palette;
}

/**
 * Split a rendered row into characters, keeping bold/italic/underline while
 * dropping colour. Static attributes stay put across frames, so glyph weight
 * never flickers as the band passes.
 */
function styledCharacters(line: string, maxWidth: number): StyledCharacter[] {
	const characters: StyledCharacter[] = [];
	const active = new Set<string>();
	let attrs = "";
	let column = 0;
	let cursor = 0;
	let full = false;

	const appendPlain = (text: string): void => {
		for (const character of text) {
			if (full) return;
			const characterWidth = Math.max(0, visibleWidth(character));
			const previous = characters.at(-1);
			if (characterWidth === 0 && previous) {
				previous.text += character;
				continue;
			}
			if (column + characterWidth > maxWidth) {
				full = true;
				return;
			}
			characters.push({ text: character, attrs, width: characterWidth });
			column += characterWidth;
		}
	};

	ANSI_PATTERN.lastIndex = 0;
	for (const match of line.matchAll(ANSI_PATTERN)) {
		const sequence = match[0] ?? "";
		appendPlain(line.slice(cursor, match.index));
		cursor = (match.index ?? 0) + sequence.length;
		if (full) break;
		if (!sequence.endsWith("m")) continue;
		for (const part of sequence.slice(2, -1).split(";")) {
			const code = Number.parseInt(part, 10) || 0;
			const set = SGR_ATTRIBUTES.get(code);
			const cleared = SGR_ATTRIBUTE_RESETS.get(code);
			if (code === 0) active.clear();
			else if (set) active.add(set);
			else if (cleared) active.delete(cleared);
		}
		attrs = [...active].join(";");
	}
	if (!full) appendPlain(line.slice(cursor));
	return characters;
}

/**
 * Raised-cosine window with a stretched trailing edge. A continuous falloff is
 * what separates a light sweep from the hard colour bands of a step palette.
 */
function bandIntensity(offset: number, radius: number): number {
	const reach = offset >= 0 ? radius * SHIMMER_TRAIL_STRETCH : radius;
	const normalized = Math.abs(offset) / reach;
	if (normalized >= 1) return 0;
	return 0.5 * (1 + Math.cos(Math.PI * normalized));
}

/**
 * Travel from fully off the row on the left to fully off on the right, then
 * rest. Easing is only half smoothstep: full smoothstep parks the band off the
 * row for too much of the cycle, while pure linear reads as a machine part.
 */
function sweepCenter(now: number, width: number, radius: number): number {
	const phase = ((now % SHIMMER_CYCLE_MS) + SHIMMER_CYCLE_MS) % SHIMMER_CYCLE_MS;
	const progress = Math.min(1, phase / SHIMMER_SWEEP_MS);
	const eased = 0.5 * progress + 0.5 * (progress * progress * (3 - 2 * progress));
	const start = -radius;
	const end = width + radius * SHIMMER_TRAIL_STRETCH;
	return start + eased * (end - start);
}

function styledShimmerRun(theme: ToolActivityTheme, style: string, text: string): string {
	if (!text) return "";
	if (style === "highlight") {
		const highlighted = theme.bold ? theme.bold(text) : text;
		return theme.fg("text", highlighted);
	}
	return theme.fg(style, text);
}

function renderGradientLine(
	characters: readonly StyledCharacter[],
	palette: ShimmerPalette,
	center: number,
	radius: number,
	strength: number,
): string {
	let out = "";
	let column = 0;
	let currentAttrs: string | undefined;
	let currentLevel = -1;
	for (const character of characters) {
		const intensity = bandIntensity(center - (column + character.width / 2), radius);
		const level = Math.round(intensity * strength * SHIMMER_LEVELS);
		if (character.attrs !== currentAttrs) {
			out += character.attrs ? `\x1b[0;${character.attrs}m` : "\x1b[0m";
			currentAttrs = character.attrs;
			currentLevel = -1;
		}
		if (level !== currentLevel) {
			out += palette[level] ?? "";
			currentLevel = level;
		}
		out += character.text;
		column += character.width;
	}
	return `${out}\x1b[0m`;
}

/** Colour-free fallback: three theme buckets, used when no ramp can be built. */
function renderNamedLine(
	theme: ToolActivityTheme,
	characters: readonly StyledCharacter[],
	center: number,
	radius: number,
	strength: number,
): string {
	const runs: Array<{ style: string; text: string }> = [];
	let column = 0;
	for (const character of characters) {
		const intensity = bandIntensity(center - (column + character.width / 2), radius) * strength;
		const style = intensity > 0.6 ? "highlight" : intensity > 0.15 ? "text" : "muted";
		const previous = runs.at(-1);
		if (previous?.style === style) previous.text += character.text;
		else runs.push({ style, text: character.text });
		column += character.width;
	}
	return runs.map((run) => styledShimmerRun(theme, run.style, run.text)).join("");
}

/**
 * Apply one shared light sweep to a rendered terminal row.
 *
 * Rows of equal width share a phase, so a panel of live tool rows reads as a
 * single light passing over all of them. `amplitude` scales the highlight for
 * the fade-in envelope.
 */
export function renderSynchronizedShimmerLine(
	line: string,
	width: number,
	theme: ToolActivityTheme,
	now = Date.now(),
	amplitude = 1,
): string {
	const renderWidth = Math.max(1, Math.floor(width));
	const strength = clamp01(amplitude);
	const characters = styledCharacters(line, renderWidth);
	if (characters.length === 0 || strength === 0) return line;
	// Travel spans the row's own content, not the panel. Rows still enter and
	// leave together because the phase comes from the clock, so a stack of live
	// rows pulses as one even when their summaries differ in length.
	const contentWidth = Math.max(
		1,
		characters.reduce((total, item) => total + item.width, 0),
	);
	const radius = Math.min(
		SHIMMER_BAND_MAX_COLUMNS,
		Math.max(SHIMMER_BAND_MIN_COLUMNS, contentWidth * SHIMMER_BAND_RATIO),
	);
	const center = sweepCenter(now, contentWidth, radius);
	const palette = shimmerPalette(theme);
	return palette
		? renderGradientLine(characters, palette, center, radius, strength)
		: renderNamedLine(theme, characters, center, radius, strength);
}

export class SynchronizedShimmerRender implements Component {
	constructor(
		private readonly content: Component,
		private readonly theme: ToolActivityTheme,
		private readonly activity: ToolActivitySnapshot,
		private readonly showLiveDuration = false,
	) {}

	render(width: number): string[] {
		let lines = this.content.render(width);
		const liveSuffix = liveDurationSuffix(this.activity);
		if (this.activity.active && this.showLiveDuration && lines.length > 0) {
			// The timer belongs on the title row: appending it to the last row
			// would tack the live duration onto the final detail line of expanded chrome.
			const firstContentLine = lines.findIndex((line) => stripAnsi(line).trim() !== "");
			const index = firstContentLine === -1 ? lines.length - 1 : firstContentLine;
			const suffixWidth = visibleWidth(liveSuffix);
			const content = trimRenderedLineEnd(lines[index] ?? "");
			lines = [...lines];
			if (width <= suffixWidth) {
				lines[index] = this.theme.fg("muted", truncateToWidth(liveSuffix.trim(), width, "…"));
			} else {
				const available = width - suffixWidth;
				// Ellipsis, not a bare cut, so a clipped row still reads as clipped.
				const fitted =
					visibleWidth(content) <= available ? content : truncateToWidth(content, available, "…");
				lines[index] = `${fitted}${this.theme.fg("muted", liveSuffix)}`;
			}
		}
		const elapsedMs = this.activity.active
			? liveToolElapsedMs(this.activity)
			: (this.activity.elapsedMs ?? 0);
		if (!this.activity.active || elapsedMs < SHIMMER_DELAY_MS) return lines;
		const amplitude = clamp01((elapsedMs - SHIMMER_DELAY_MS) / SHIMMER_FADE_IN_MS);
		const now = Date.now();
		return lines.map((line: string) =>
			renderSynchronizedShimmerLine(line, width, this.theme, now, amplitude),
		);
	}

	invalidate(): void {
		this.content.invalidate?.();
	}
}

/** Clear animation resources during session replacement or reload. */
export function resetToolActivity(): void {
	activeInvalidators.clear();
	fallbackActivityStates.clear();
	stopShimmerClock();
}

export type SoftGroupItem = {
	toolCallId: string;
	summary: string;
	/** Trailing segment that keeps its width first, e.g. `in <path>`. */
	summaryTail?: string;
	/** Per-tool title, so a mixed streak can still name its leader's tool. */
	label?: string;
	unitCount: number;
	activity?: ToolActivitySnapshot;
};

export type SoftGroupStreak = {
	items: SoftGroupItem[];
	isLeader: boolean;
	totalUnits: number;
	lastSummary: string;
	lastSummaryTail?: string;
	lastLabel?: string;
	/** Set only when every item shares one label; undefined once tools mix. */
	uniformLabel?: string;
	activity: ToolActivitySnapshot;
};

type SoftGroupEvent = { kind: "break" } | { kind: "item"; groupId: string; toolCallId: string };

type TrackedItem = SoftGroupItem & {
	groupId: string;
	invalidate?: () => void;
};

export type SoftGroupRenderContext = ToolActivityRenderContext & {
	expanded?: boolean;
	/** Host `ToolRenderContext.isError`. Failed calls never join a streak. */
	isError?: boolean;
	/**
	 * Host `ToolRenderContext.executionStarted`.
	 * - `true` / omitted: may append live soft-group state
	 * - `false`: may hydrate session topology pre-seeded by bindSoftGroupTracker,
	 *   but cannot append or reorder it during repaint
	 */
	executionStarted?: boolean;
};

/**
 * Tracks consecutive tool calls so collapsed TUI rows can soft-group.
 * Use one tracker per extension (or shared across tools that share a groupId).
 *
 * Example for read:
 *   tracker.noteItem({ groupId: "read", toolCallId, summary: path, unitCount: 1, invalidate })
 *   collapsed leader -> `read` with one `├─` / `└─` child row per call
 */
export class SoftGroupTracker {
	private events: SoftGroupEvent[] = [];
	private items = new Map<string, TrackedItem>();

	constructor(private readonly options: { allowInterleavedGroups?: boolean } = {}) {}

	reset(): void {
		this.events = [];
		this.items.clear();
	}

	has(toolCallId: string): boolean {
		return this.items.has(toolCallId);
	}

	/**
	 * Remove a call from every streak it takes part in. Used when a call turns
	 * out to have failed: it must keep its own row so its error has a subject,
	 * and it must stop counting toward a leader that hides it.
	 */
	drop(toolCallId: string): void {
		if (!this.items.delete(toolCallId)) return;
		const events: SoftGroupEvent[] = [];
		for (const event of this.events) {
			const next: SoftGroupEvent =
				event.kind === "item" && event.toolCallId === toolCallId ? { kind: "break" } : event;
			if (next.kind === "break" && events.at(-1)?.kind === "break") continue;
			events.push(next);
		}
		this.events = events;
		for (const item of this.items.values()) {
			item.invalidate?.();
		}
	}

	/** Seed immutable call order before historical rows repaint in arbitrary order. */
	seedItem(input: { groupId: string; toolCallId: string; label?: string }): void {
		const toolCallId = input.toolCallId.trim();
		if (!toolCallId || this.items.has(toolCallId)) return;
		this.items.set(toolCallId, {
			groupId: input.groupId,
			toolCallId,
			summary: "",
			label: input.label,
			unitCount: 1,
		});
		this.events.push({ kind: "item", groupId: input.groupId, toolCallId });
	}

	/** Insert a streak boundary, for example visible prose or an ungrouped tool. */
	noteBreak(): void {
		const last = this.events.at(-1);
		if (last?.kind === "break") {
			return;
		}
		this.events.push({ kind: "break" });
	}

	noteItem(input: {
		groupId: string;
		toolCallId: string;
		summary: string;
		summaryTail?: string;
		label?: string;
		unitCount?: number;
		invalidate?: () => void;
		activity?: ToolActivitySnapshot;
	}): SoftGroupStreak {
		const unitCount = Math.max(1, input.unitCount ?? 1);
		const existing = this.items.get(input.toolCallId);
		const isNewItem = !existing;
		const activityChanged = Boolean(
			existing && existing.activity?.active !== input.activity?.active,
		);
		if (existing) {
			existing.summary = input.summary;
			existing.summaryTail = input.summaryTail;
			existing.label = input.label ?? existing.label;
			existing.unitCount = unitCount;
			existing.invalidate = input.invalidate ?? existing.invalidate;
			existing.activity = input.activity ?? existing.activity;
		} else {
			this.items.set(input.toolCallId, {
				groupId: input.groupId,
				toolCallId: input.toolCallId,
				summary: input.summary,
				summaryTail: input.summaryTail,
				label: input.label,
				unitCount,
				invalidate: input.invalidate,
				activity: input.activity,
			});
			this.events.push({
				kind: "item",
				groupId: input.groupId,
				toolCallId: input.toolCallId,
			});
		}

		const streak = this.getStreak(input.toolCallId);
		if (!streak) {
			return {
				items: [],
				isLeader: true,
				totalUnits: unitCount,
				lastSummary: input.summary,
				lastSummaryTail: input.summaryTail,
				lastLabel: input.label,
				uniformLabel: input.label,
				activity: input.activity ?? { active: false },
			};
		}

		// Previous leaders must redraw only when this is a new item. Repeating
		// this during a TUI render would invalidate neighboring rows in both
		// directions and can recurse until the stack overflows.
		if (isNewItem || activityChanged) {
			for (const item of streak.items) {
				if (item.toolCallId !== input.toolCallId) {
					this.items.get(item.toolCallId)?.invalidate?.();
				}
			}
		}
		return streak;
	}

	getStreak(toolCallId: string): SoftGroupStreak | undefined {
		const streaks: SoftGroupItem[][] = [];
		let current: SoftGroupItem[] = [];
		let currentGroup: string | null = null;
		const targetGroup = this.items.get(toolCallId)?.groupId;

		for (const event of this.events) {
			if (event.kind === "break") {
				if (current.length > 0) {
					streaks.push(current);
				}
				current = [];
				currentGroup = null;
				continue;
			}

			const item = this.items.get(event.toolCallId);
			if (!item) {
				continue;
			}
			if (
				this.options.allowInterleavedGroups === true &&
				targetGroup !== undefined &&
				event.groupId !== targetGroup
			) {
				continue;
			}
			if (currentGroup !== null && event.groupId !== currentGroup) {
				if (current.length > 0) {
					streaks.push(current);
				}
				current = [];
			}
			currentGroup = event.groupId;
			current.push({
				toolCallId: item.toolCallId,
				summary: item.summary,
				summaryTail: item.summaryTail,
				label: item.label,
				unitCount: item.unitCount,
				activity: item.activity,
			});
		}
		if (current.length > 0) {
			streaks.push(current);
		}

		const streak = streaks.find((items) => items.some((item) => item.toolCallId === toolCallId));
		if (!streak || streak.length === 0) {
			return undefined;
		}
		const last = streak[streak.length - 1]!;
		const activeItems = streak.filter((item) => item.activity?.active);
		const longestActive = activeItems.reduce<SoftGroupItem | undefined>((longest, item) => {
			if (!longest) return item;
			return (item.activity?.elapsedMs ?? 0) >= (longest.activity?.elapsedMs ?? 0) ? item : longest;
		}, undefined);
		const labels = new Set(streak.map((item) => item.label));
		return {
			items: streak,
			isLeader: last.toolCallId === toolCallId,
			totalUnits: streak.reduce((sum, item) => sum + item.unitCount, 0),
			lastSummary: last.summary,
			lastSummaryTail: last.summaryTail,
			lastLabel: last.label,
			uniformLabel: labels.size === 1 ? last.label : undefined,
			activity: longestActive
				? {
						active: true,
						elapsedMs: longestActive.activity?.elapsedMs ?? 0,
						startedAt: longestActive.activity?.startedAt,
					}
				: { active: false },
		};
	}
}

export type SoftGroupedCallTheme = {
	fg: (name: string, text: string) => string;
	bold?: (text: string) => string;
};

function titleText(theme: SoftGroupedCallTheme, label: string): string {
	return theme.fg("toolTitle", theme.bold ? theme.bold(label) : label);
}

function clipEnd(text: string, width: number): string {
	if (width <= 1) return "…";
	const clipped = stripAnsi(truncateToWidth(text, width - 1, ""))
		.replace(/\s*·\s*$/u, "")
		.trimEnd();
	return `${clipped}…`;
}

/** Keep the leading token and the identifying end, e.g. `in ~/…/core/tools`. */
function clipMiddle(text: string, width: number): string {
	if (width <= 1) return "…";
	const endWidth = Math.max(1, Math.floor((width - 1) * TAIL_END_SHARE));
	const startWidth = Math.max(0, width - 1 - endWidth);
	let end = "";
	for (const char of [...stripAnsi(text)].reverse()) {
		const next = char + end;
		if (visibleWidth(next) > endWidth) break;
		end = next;
	}
	// Resume at a path boundary when one is in reach, so the elision reads as
	// `…/core/tools` rather than `…re/tools`.
	end = end.replace(/^[^/]+(?=\/)/, "");
	const start = startWidth > 0 ? stripAnsi(truncateToWidth(text, startWidth, "")).trimEnd() : "";
	return `${start}…${end}`;
}

/**
 * Render `head tail` inside `width`. The tail names what was inspected, so it
 * is served first; once it needs the whole row a few surviving head characters
 * say nothing, and the head is dropped rather than shrunk.
 */
function summaryText(
	theme: SoftGroupedCallTheme,
	summary: string,
	tail: string | undefined,
	width: number,
): string {
	const trimmedTail = tail?.replace(/\s+/g, " ").trim();
	const full = [summary, trimmedTail].filter(Boolean).join(" ");
	if (!full) return "";
	if (visibleWidth(full) <= width) return theme.fg("muted", full);
	if (width <= 1) return theme.fg("muted", "…");
	if (!trimmedTail) return theme.fg("muted", clipEnd(summary, width));

	if (!summary) return theme.fg("muted", clipMiddle(trimmedTail, width));

	// The tail is served first, but on any row wide enough to carry both it may
	// not erase the head: saying where it searched without saying what it
	// searched for is not worth the width it saves. Narrower than that, the
	// pattern is unreadable anyway and the path takes everything.
	const floor = width >= MIN_HEAD_COLUMNS + MIN_TAIL_COLUMNS + 1 ? MIN_HEAD_COLUMNS : 0;
	const headBudget = Math.min(
		visibleWidth(summary),
		Math.max(floor, width - visibleWidth(trimmedTail) - 1),
	);
	if (headBudget < 1) return theme.fg("muted", clipMiddle(trimmedTail, width));
	const head = visibleWidth(summary) <= headBudget ? summary : clipEnd(summary, headBudget);
	const tailBudget = width - visibleWidth(head) - 1;
	const fittedTail =
		visibleWidth(trimmedTail) <= tailBudget ? trimmedTail : clipMiddle(trimmedTail, tailBudget);
	return theme.fg("muted", `${head} ${fittedTail}`);
}

function emptyCollapsed(): Component {
	return {
		render: () => [],
		invalidate() {},
	};
}

function collapsedChrome(
	theme: SoftGroupedCallTheme,
	label: string,
	count: number,
	summary: string,
	tail?: string,
	/** Tool name for a mixed streak. Short and identifying, so never elided. */
	toolName?: string,
	activity: ToolActivitySnapshot = { active: false },
): Component {
	const last = summary.replace(/\s+/g, " ").trim() || (tail ? "" : "...");
	const content: Component = {
		render(width: number): string[] {
			// A count of one says nothing; only real groups earn a number.
			// Separators and the count match the muted summary/path styling; only
			// the group label keeps toolTitle emphasis.
			const sep = theme.fg("muted", " · ");
			const chrome =
				count > 1
					? ` ${titleText(theme, label)}${sep}${theme.fg("muted", String(count))}${sep}`
					: ` ${titleText(theme, label)} `;
			const name = toolName ? `${theme.fg("muted", toolName)} ` : "";
			// Budget for the live timer so the summary keeps its own ellipsis
			// instead of being cut mid-word by the shimmer wrapper.
			const reserved = activity.active ? visibleWidth(liveDurationSuffix(activity)) : 0;
			const available = Math.max(1, width - visibleWidth(chrome) - visibleWidth(name) - reserved);
			return [`${chrome}${name}${summaryText(theme, last, tail, available)}`];
		},
		invalidate() {},
	};
	return new SynchronizedShimmerRender(content, theme, activity, true);
}

function clipStart(text: string, width: number): string {
	if (width <= 1) return "…";
	let end = "";
	for (const char of [...stripAnsi(text)].reverse()) {
		const next = char + end;
		if (visibleWidth(next) > width - 1) break;
		end = next;
	}
	return `…${end}`;
}

/** Wrap a tree leaf to at most two lines while retaining its identifying end. */
function treeSummaryLines(
	theme: SoftGroupedCallTheme,
	item: SoftGroupItem,
	width: number,
): string[] {
	const summary = item.summary.replace(/\s+/g, " ").trim();
	const tail = item.summaryTail?.replace(/\s+/g, " ").trim();
	const full = [summary, tail].filter(Boolean).join(" ") || "...";
	if (visibleWidth(full) <= width) return [theme.fg("muted", full)];
	if (width <= 1) return [theme.fg("muted", "…")];

	// A separate tail usually names a path. Give the query and path one line
	// each rather than allowing either to consume both available rows.
	if (summary && tail) {
		// Keep both the query's leading token and trailing limit qualifier;
		// clipping that summary from the end hides a useful control.
		const summaryLine = /\s·\s+limit\s+\d+\s*$/u.test(summary)
			? summaryText(theme, "", summary, width)
			: summaryText(theme, summary, undefined, width);
		return [summaryLine, summaryText(theme, "", tail, width)];
	}

	const wrapped = wrapTextWithAnsi(full, width);
	if (wrapped.length <= 2) return wrapped.map((line) => theme.fg("muted", line));
	return [theme.fg("muted", wrapped[0] ?? ""), theme.fg("muted", clipStart(full, width))];
}

function treeChrome(
	theme: SoftGroupedCallTheme,
	label: string,
	items: SoftGroupItem[],
	mixed: boolean,
	activity: ToolActivitySnapshot,
): Component {
	const content: Component = {
		render(width: number): string[] {
			if (width <= 0) return [];
			const reserved = activity.active ? visibleWidth(liveDurationSuffix(activity)) : 0;
			const parentWidth = Math.max(1, width - reserved);
			const parent = ` ${titleText(theme, label)}`;
			const lines = [
				visibleWidth(parent) <= parentWidth ? parent : truncateToWidth(parent, parentWidth, "…"),
			];

			for (const [index, item] of items.entries()) {
				const glyph = index === items.length - 1 ? "└─" : "├─";
				const branch = ` ${glyph} `;
				const branchWidth = visibleWidth(branch);
				if (width <= branchWidth) {
					lines.push(theme.fg("muted", truncateToWidth(branch, width, "")));
					continue;
				}

				const available = width - branchWidth;
				let childLabel = "";
				let summaryWidth = available;
				if (mixed && item.label) {
					const fullLabel = `${item.label} `;
					const minimumSummary = Math.min(12, Math.max(1, available - 1));
					const labelBudget = Math.min(
						visibleWidth(fullLabel),
						Math.max(0, available - minimumSummary),
					);
					if (labelBudget > 0) {
						childLabel =
							visibleWidth(fullLabel) <= labelBudget
								? fullLabel
								: `${clipEnd(item.label, labelBudget).trimEnd()} `;
						summaryWidth = Math.max(1, available - visibleWidth(childLabel));
					}
				}
				const summaryLines = treeSummaryLines(theme, item, summaryWidth);
				for (const [lineIndex, summaryLine] of summaryLines.entries()) {
					const rail = lineIndex === 0 ? branch : index === items.length - 1 ? "    " : " │  ";
					const label = lineIndex === 0 ? childLabel : " ".repeat(visibleWidth(childLabel));
					lines.push(`${theme.fg("muted", `${rail}${label}`)}${summaryLine}`);
				}
			}
			return lines.map((line) =>
				visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…"),
			);
		},
		invalidate() {},
	};
	return new SynchronizedShimmerRender(content, theme, activity, true);
}

function expandedChrome(
	theme: SoftGroupedCallTheme,
	label: string,
	summary: string,
	unitCount: number,
	expandedLines?: string[],
): Component {
	const lines = expandedLines?.length
		? expandedLines
		: unitCount > 1
			? [`${label} · ${unitCount}`, summary]
			: [`${label} ${summary}`];
	const [head = label, ...rest] = lines;
	const styled = [titleText(theme, head), ...rest.map((line) => theme.fg("muted", line))];
	return new Text(styled.join("\n"), CHAT_PADDING, 0);
}

/**
 * Consecutive calls collapse into a parent plus one branch row per call.
 * Non-leaders render nothing while collapsed. Expanded rows show only local content.
 * Session-history rows join only topology pre-seeded by bindSoftGroupTracker, so
 * repaint order cannot duplicate or reorder restored streaks.
 */
export function renderSoftGroupedCall(options: {
	tracker: SoftGroupTracker;
	groupId: string;
	label: string;
	/** Title for streaks that mix tools. Defaults to `label`. */
	groupLabel?: string;
	summary: string;
	/** Protected trailing segment, kept while `summary` elides on narrow rows. */
	summaryTail?: string;
	unitCount?: number;
	theme: SoftGroupedCallTheme;
	context: SoftGroupRenderContext;
	expandedLines?: string[];
}): Component {
	const summaryTail = options.summaryTail?.replace(/\s+/g, " ").trim() || undefined;
	// Path-only rows carry everything in the tail, so an empty head is valid.
	const summary = options.summary.replace(/\s+/g, " ").trim() || (summaryTail ? "" : "...");
	const expandedSummary = [summary, summaryTail].filter(Boolean).join(" ");
	const unitCount = Math.max(1, options.unitCount ?? 1);
	const activity = syncToolActivity(options.context);
	const toolCallId =
		typeof options.context.toolCallId === "string" ? options.context.toolCallId.trim() : "";

	const historical = options.context.executionStarted === false;
	const seededHistorical = historical && Boolean(toolCallId) && options.tracker.has(toolCallId);

	// A failed call keeps its own row, so the error beneath it has a subject.
	// Dropping it also leaves a boundary between otherwise matching neighbors.
	if (options.context.isError && toolCallId) {
		options.tracker.drop(toolCallId);
	}

	if (options.context.expanded) {
		// Expanded chrome is always per-row. Historical rows may hydrate existing
		// seeded items, but never append topology during repaint.
		if (toolCallId && !options.context.isError && (!historical || seededHistorical)) {
			options.tracker.noteItem({
				groupId: options.groupId,
				toolCallId,
				summary,
				summaryTail,
				label: options.label,
				unitCount,
				invalidate: options.context.invalidate,
				activity,
			});
		}
		return new SynchronizedShimmerRender(
			expandedChrome(
				options.theme,
				options.label,
				expandedSummary,
				unitCount,
				options.expandedLines,
			),
			options.theme,
			activity,
			true,
		);
	}

	if (!toolCallId) {
		return historical
			? collapsedChrome(options.theme, options.label, unitCount, summary, summaryTail)
			: emptyCollapsed();
	}

	if (options.context.isError) {
		return collapsedChrome(options.theme, options.label, unitCount, summary, summaryTail);
	}

	if (historical && !seededHistorical) {
		return collapsedChrome(options.theme, options.label, unitCount, summary, summaryTail);
	}

	const streak = options.tracker.noteItem({
		groupId: options.groupId,
		toolCallId,
		summary,
		summaryTail,
		label: options.label,
		unitCount,
		invalidate: options.context.invalidate,
		activity,
	});

	if (!streak.isLeader) {
		return emptyCollapsed();
	}

	// A single call keeps the established compact chrome. Real streaks render a
	// dense tree, with child labels only when a generic group mixes tools.
	const mixed = streak.uniformLabel === undefined;
	const leaderLabel = mixed ? (options.groupLabel ?? options.label) : streak.uniformLabel!;
	if (streak.items.length === 1) {
		const leaderSummary =
			streak.lastSummary.replace(/\s+/g, " ").trim() || (streak.lastSummaryTail ? "" : summary);
		return collapsedChrome(
			options.theme,
			leaderLabel,
			streak.totalUnits,
			leaderSummary,
			streak.lastSummaryTail,
			streak.lastLabel === leaderLabel ? undefined : streak.lastLabel,
			streak.activity,
		);
	}
	return treeChrome(options.theme, leaderLabel, streak.items, mixed, streak.activity);
}

function hasVisibleContent(content: any): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some(
		(part) =>
			part?.type === "image" ||
			(part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) ||
			(part?.type === "thinking" &&
				typeof part.thinking === "string" &&
				part.thinking.trim().length > 0),
	);
}

function hasVisibleMessageProse(message: any): boolean {
	if (!message || message.role === "toolResult") return false;
	if (message.role === "assistant" || message.role === "user") {
		return hasVisibleContent(message.content);
	}
	if (message.role === "custom") {
		return message.display !== false && hasVisibleContent(message.content);
	}
	return false;
}

/**
 * Seed immutable call order from an ordered transcript before historical rows
 * repaint in arbitrary order. Accepts pi-ai `Message` values directly, or the
 * session-branch envelope `{ type: "message", message }` when feeding manager
 * entries. Structural records (compaction, custom, ...) interrupt what the user
 * sees as consecutive tool rows, so they are conservative breaks.
 *
 * Boundaries follow the parent live rules: consecutive eligible tool calls
 * (groupToolNames) group, `nonBreakingToolNames` (for example `announce_step`)
 * never break a streak, and visible prose, user content, other tools, and
 * failed calls break it. Failed calls are never seeded, so repaint cannot
 * promote them into a group and their error keeps its own row.
 */
export function seedSessionTopology(
	messages: readonly unknown[],
	tracker: SoftGroupTracker,
	groupToolNames: Iterable<string>,
	options: { nonBreakingToolNames?: Iterable<string> } = {},
): void {
	const grouped = new Set(groupToolNames);
	const nonBreaking = new Set(options.nonBreakingToolNames ?? []);
	const failedCalls = new Set<string>();

	// Failures keep their own row: collect the tool calls that errored so their
	// streak boundary is known before the leaders are chosen.
	for (const entry of messages) {
		const message = sessionMessage(entry);
		if (!message || message.role !== "toolResult") continue;
		if (message.isError === true && typeof message.toolCallId === "string") {
			failedCalls.add(message.toolCallId);
		}
	}

	for (const entry of messages) {
		if (isStructuralEntry(entry)) {
			tracker.noteBreak();
			continue;
		}
		const message = sessionMessage(entry);
		if (!message || message.role === "toolResult") continue;
		if (message.role !== "assistant") {
			if (hasVisibleMessageProse(message)) tracker.noteBreak();
			continue;
		}

		const content = Array.isArray(message.content) ? message.content : [];
		// Pi renders assistant prose before its separate tool rows regardless of
		// provider content-part order, so the prose boundary precedes every call.
		if (hasVisibleContent(content)) tracker.noteBreak();
		for (const part of content) {
			if (part?.type !== "toolCall") continue;
			const toolName = typeof part.name === "string" ? part.name : "";
			const toolCallId = typeof part.id === "string" ? part.id : "";
			// Hidden progress announcements never interrupt an eligible streak.
			if (nonBreaking.has(toolName)) continue;
			if (toolCallId && failedCalls.has(toolCallId)) {
				tracker.noteBreak();
				continue;
			}
			if (!grouped.has(toolName) || !toolCallId) {
				tracker.noteBreak();
				continue;
			}
			tracker.seedItem({ groupId: toolName, toolCallId, label: toolName });
		}
	}
}

/** Unwrap `{ type: "message", message }` envelopes; raw messages pass through. */
function sessionMessage(entry: unknown): any {
	if (!entry || typeof entry !== "object") return undefined;
	const candidate = entry as Record<string, unknown>;
	if (candidate.type === "message" && candidate.message !== undefined) {
		return candidate.message;
	}
	return candidate;
}

/** Structural session records carry a type but no message body. */
function isStructuralEntry(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as Record<string, unknown>;
	return (
		typeof candidate.type === "string" && candidate.type !== "message" && !("role" in candidate)
	);
}

function seedSessionTopologyFromEntries(
	ctx: any,
	tracker: SoftGroupTracker,
	grouped: Set<string>,
	nonBreaking: Set<string>,
): void {
	const manager = ctx?.sessionManager;
	const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
	if (!Array.isArray(entries)) return;

	let run: unknown[] = [];
	const flush = (): void => {
		if (run.length > 0) {
			seedSessionTopology(run, tracker, grouped, { nonBreakingToolNames: nonBreaking });
			run = [];
		}
	};
	for (const entry of entries) {
		if (entry?.type !== "message") {
			// Custom prose and structural records both interrupt what the user sees
			// as consecutive tool rows. Invisible records are conservative breaks.
			flush();
			tracker.noteBreak();
			continue;
		}
		run.push(entry.message);
	}
	flush();
}

/** Bind tracker lifecycle to common Pi extension events. */
export function bindSoftGroupTracker(
	pi: {
		on: (event: string, handler: (event: any, ctx: any) => void | Promise<void>) => void;
	},
	tracker: SoftGroupTracker,
	groupToolNames: Iterable<string>,
	options: { nonBreakingToolNames?: Iterable<string> } = {},
): void {
	const grouped = new Set(groupToolNames);
	const nonBreaking = new Set(options.nonBreakingToolNames ?? []);
	let assistantProseBroken = false;
	pi.on("session_start", (_event, ctx) => {
		tracker.reset();
		resetToolActivity();
		assistantProseBroken = false;
		seedSessionTopologyFromEntries(ctx, tracker, grouped, nonBreaking);
	});
	pi.on("session_shutdown", () => {
		resetToolActivity();
	});
	// Tool-only assistant turns remain consecutive. A turn only resets the
	// streaming-message guard; visible prose creates the actual boundary.
	pi.on("turn_start", () => {
		assistantProseBroken = false;
	});
	pi.on("message_start", (event) => {
		const message = event?.message;
		if (message?.role === "assistant") assistantProseBroken = false;
		if (!hasVisibleMessageProse(message)) return;
		tracker.noteBreak();
		if (message.role === "assistant") assistantProseBroken = true;
	});
	pi.on("message_update", (event) => {
		const message = event?.message;
		if (message?.role !== "assistant" || assistantProseBroken) return;
		if (!hasVisibleMessageProse(message)) return;
		tracker.noteBreak();
		assistantProseBroken = true;
	});
	pi.on("message_end", (event) => {
		const message = event?.message;
		if (message?.role === "assistant") {
			if (!assistantProseBroken && hasVisibleMessageProse(message)) tracker.noteBreak();
			assistantProseBroken = assistantProseBroken || hasVisibleMessageProse(message);
			return;
		}
		if (hasVisibleMessageProse(message)) tracker.noteBreak();
	});
	pi.on("tool_execution_start", (event) => {
		const toolName = typeof event?.toolName === "string" ? event.toolName : "";
		if (!grouped.has(toolName) && !nonBreaking.has(toolName)) tracker.noteBreak();
	});
}
