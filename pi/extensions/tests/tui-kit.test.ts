/**
 * Reusable TUI primitive tests.
 *
 * Run: npm run test:extensions
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function ensurePiModulePath(): void {
	if (process.env.PI_TUI_KIT_TEST_READY === "1") return;

	const candidates: string[] = [];
	const piBin = spawnSync("which", ["pi"], { encoding: "utf8" }).stdout?.trim();
	if (piBin) {
		try {
			candidates.push(path.resolve(path.dirname(fs.realpathSync(piBin)), ".."));
		} catch {}
	}
	try {
		const require = createRequire(import.meta.url);
		candidates.push(path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")));
	} catch {}
	const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout?.trim();
	if (npmRoot) candidates.push(path.join(npmRoot, "@earendil-works/pi-coding-agent"));

	const piRoot = candidates.find((candidate) =>
		fs.existsSync(path.join(candidate, "node_modules", "@earendil-works", "pi-tui")),
	);
	if (!piRoot) throw new Error("Cannot locate @earendil-works/pi-tui");

	const nodePath = [
		path.join(piRoot, "node_modules"),
		path.dirname(path.dirname(piRoot)),
		process.env.NODE_PATH,
	]
		.filter(Boolean)
		.join(path.delimiter);
	const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
		stdio: "inherit",
		env: { ...process.env, NODE_PATH: nodePath, PI_TUI_KIT_TEST_READY: "1" },
	});
	process.exit(result.status ?? 1);
}

ensurePiModulePath();

const {
	createTuiStyles,
	ExpandableToolRender,
	emptyCollapsedToolRender,
	fillLine,
	formatModelUsageLines,
	frameScreen,
	getContentWidth,
	insetLine,
	renderDivider,
	renderFooter,
	renderFullscreenScreen,
	renderKeyHints,
	renderMetadata,
	renderSplitPane,
	getSplitPaneLayout,
	fullscreenOverlayOptions,
	ScrollViewportState,
	SelectableViewportState,
	shouldRevealToolDetails,
	SoftGroupTracker,
	SHIMMER_TIMING,
	bindSoftGroupTracker,
	formatToolDuration,
	renderSoftGroupedCall,
	renderSynchronizedShimmerLine,
	resetToolActivity,
	syncToolActivity,
} = await import("../lib/tui/index.ts");
const { Text, visibleWidth } = await import("@earendil-works/pi-tui");

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function testLineAndFrameBounds(): void {
	const styled = "\x1b[31mabcdefgh\x1b[0m";
	const line = fillLine(styled, 6);
	const frame = frameScreen({
		width: 8,
		height: 5,
		header: ["header"],
		body: ["one", styled, "clipped"],
		footer: ["footer"],
	});
	assert(
		"line filling and screen framing preserve exact bounds",
		visibleWidth(line) === 6 &&
			frame.length === 5 &&
			frame.every((entry) => visibleWidth(entry) === 8) &&
			frame[0]?.includes("header") &&
			frame.at(-1)?.includes("footer") &&
			frame.some((entry) => entry.includes("one")),
		JSON.stringify({ line, frame }),
	);
}

function testChromeAndTinyFrames(): void {
	const styled = "\x1b[35mwide title\x1b[0m";
	const hints = renderFooter({
		width: 12,
		hints: [{ key: "Esc", label: "close" }],
		padding: 0,
	});
	const wrappedHints = renderFooter({
		width: 12,
		hints: [
			{ key: "PgUp", label: "page" },
			{ key: "End", label: "jump" },
		],
	});
	const screen = renderFullscreenScreen({
		width: 12,
		height: 5,
		title: styled,
		body: ["content"],
		keyHints: [{ key: "q", label: "quit" }],
	});
	const tiny = renderFullscreenScreen({
		width: 3,
		height: 1,
		title: "Title",
		body: ["body"],
		keyHints: [{ key: "q", label: "quit" }],
	});
	assert(
		"standard chrome keeps ANSI lines exact-width and pads below key hints",
		hints.length >= 3 &&
			wrappedHints.length > 3 &&
			wrappedHints.some((line) => line.includes("End")) &&
			visibleWidth(hints.at(-1) ?? "") === 12 &&
			(hints.at(-1) ?? "").trim() === "" &&
			screen.length === 5 &&
			screen.every((line) => visibleWidth(line) === 12) &&
			screen.some((line) => line.includes("wide title")) &&
			tiny.length === 1 &&
			tiny.every((line) => visibleWidth(line) === 3),
		JSON.stringify({ hints, wrappedHints, screen, tiny }),
	);
}

function testChromeHelpers(): void {
	const divider = renderDivider({ width: 7, character: "═" });
	const hint = renderKeyHints([{ key: "Enter", label: "open" }]);
	const overlay = fullscreenOverlayOptions({ anchor: "center" });
	const frame = frameScreen({
		width: 4,
		height: 3,
		body: ["body"],
		footer: ["hint"],
		footerPadding: 1,
	});
	assert(
		"chrome helpers provide visible hints, overlay defaults, and footer padding",
		visibleWidth(divider) === 7 &&
			hint.includes("Enter") &&
			hint.includes("open") &&
			overlay.overlay &&
			overlay.overlayOptions.anchor === "center" &&
			overlay.overlayOptions.width === "100%" &&
			frame.at(-1)?.trim() === "" &&
			frame.every((line) => visibleWidth(line) === 4),
		JSON.stringify({ divider, hint, overlay, frame }),
	);
}

function testPiThreadStyleParity(): void {
	const colors: string[] = [];
	let boldCalls = 0;
	const theme = {
		fg: (color: string, text: string) => {
			colors.push(color);
			return text;
		},
		bold: (text: string) => {
			boldCalls++;
			return text;
		},
	};
	const hints = renderKeyHints(
		[
			{ key: "Esc", label: "close" },
			{ key: "Enter", label: "select" },
		],
		undefined,
		theme,
	);
	createTuiStyles(theme).selected("row");
	const screen = renderFullscreenScreen({
		width: 12,
		height: 6,
		title: "Title",
		body: ["content"],
		keyHints: [{ key: "q", label: "quit" }],
	});
	const contentLine = screen.find((line) => line.includes("content"));
	const divider = renderDivider({ width: 12 });
	assert(
		"shared screens match Pi thread gutters and restrained control styling",
		getContentWidth(12) === 10 &&
			insetLine("body", 8) === " body   " &&
			screen.every((line) => line.startsWith(" ") && line.endsWith(" ")) &&
			contentLine?.trim() === "content" &&
			divider.startsWith(" ") &&
			divider.endsWith(" ") &&
			divider.trim().length === 10 &&
			hints === "Esc close  Enter select" &&
			colors.join(",") === "dim,muted,dim,muted,accent" &&
			boldCalls === 0,
		JSON.stringify({ colors, contentLine, divider, hints, screen }),
	);
}

function testModelUsageFormatting(): void {
	const hit = formatModelUsageLines({
		input: 100,
		output: 20,
		cacheRead: 900,
		cacheWrite: 0,
		cost: 0.00039,
		model: "openai/test",
		effort: "low",
	});
	const miss = formatModelUsageLines({
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 4,
		cost: 0.00002,
	});
	const metadata = renderMetadata({ width: 24, lines: hit });
	const pending = formatModelUsageLines(undefined, {
		model: "openai/pending",
		effort: "off",
		pending: true,
	});
	assert(
		"model usage metadata has one consistent identity and metrics pattern",
		hit[0] === "Model openai/test · Effort low" &&
			hit[1] === "Input 1,000 · Output 20 · Cache hit 900 (90%) · Cost $0.0004" &&
			miss[1] === "Input 14 · Output 2 · Cache miss · wrote 4 · Cost $0.000020" &&
			metadata.every((line) => visibleWidth(line) === 24) &&
			metadata.some((line) => line.includes("Model openai/test")) &&
			metadata.some((line) => line.includes("Cache hit")) &&
			pending[0] === "Model openai/pending · Effort off" &&
			pending[1]?.includes("Input pending") &&
			pending[1]?.includes("Cache pending"),
		JSON.stringify({ hit, miss, metadata, pending }),
	);
}

function testScrollingViewport(): void {
	const viewport = new ScrollViewportState();
	viewport.update(10, 3);
	viewport.scrollBy(2);
	const scrolled = viewport.range;
	viewport.end();
	viewport.update(12, 3);
	const followed = viewport.range;
	viewport.pageBy(-1);
	assert(
		"scroll viewport clamps, pages, and follows appended content",
		scrolled.start === 2 &&
			scrolled.end === 5 &&
			followed.start === 9 &&
			followed.end === 12 &&
			viewport.range.start === 6 &&
			!viewport.followEnd,
		JSON.stringify({ scrolled, followed, current: viewport.range }),
	);
}

function testSelectableViewport(): void {
	const selection = new SelectableViewportState();
	selection.update(10, 3);
	selection.moveBy(4, 10);
	const moved = selection.viewport.range;
	selection.pageBy(1, 10);
	const paged = selection.viewport.range;
	selection.end(10);
	assert(
		"selectable viewport keeps selection bounded and visible",
		selection.selected === 9 &&
			moved.start === 2 &&
			moved.end === 5 &&
			paged.start === 5 &&
			paged.end === 8 &&
			selection.viewport.range.start === 7,
		JSON.stringify({ selected: selection.selected, moved, paged, end: selection.viewport.range }),
	);
}

function testResponsiveSplitPane(): void {
	const widths: number[] = [];
	const left = (width: number) => {
		widths.push(width);
		return ["left", "L"];
	};
	const right = (width: number) => {
		widths.push(width);
		return ["right"];
	};
	const wide = renderSplitPane({
		width: 20,
		height: 2,
		left,
		right,
		narrowPane: "right",
		breakpoint: 12,
		leftRatio: 0.4,
		minLeftWidth: 4,
		maxLeftWidth: 8,
		minRightWidth: 4,
		divider: " | ",
	});
	const narrow = renderSplitPane({
		width: 8,
		height: 2,
		left,
		right,
		narrowPane: "right",
		breakpoint: 12,
	});
	const layout = getSplitPaneLayout({
		width: 20,
		height: 2,
		left,
		right,
		narrowPane: "right",
		breakpoint: 12,
		leftRatio: 0.4,
		minLeftWidth: 4,
		maxLeftWidth: 8,
		minRightWidth: 4,
		divider: " | ",
	});
	assert(
		"split pane composes wide panes and collapses to the focused narrow pane",
		wide.length === 2 &&
			wide.every((line) => visibleWidth(line) === 20) &&
			wide[0]?.includes("left") &&
			wide[0]?.includes("right") &&
			narrow.length === 2 &&
			narrow.every((line) => visibleWidth(line) === 8) &&
			narrow[0]?.includes("right") &&
			!narrow[0]?.includes("left") &&
			layout.mode === "split" &&
			layout.leftWidth === 6 &&
			layout.rightWidth === 11 &&
			widths.join(",") === "6,11,8",
		JSON.stringify({ wide, narrow, layout, widths }),
	);
}

function testShimmerTimingContract(): void {
	assert(
		"shared shimmer timing is frozen at a 150ms repaint cadence",
		Object.isFrozen(SHIMMER_TIMING) &&
			SHIMMER_TIMING.frameIntervalMs === 150 &&
			SHIMMER_TIMING.delayMs === 220 &&
			SHIMMER_TIMING.fadeInMs === 300,
		JSON.stringify(SHIMMER_TIMING),
	);
}

function testSynchronizedToolActivity(): void {
	resetToolActivity();
	const stateA: Record<string, unknown> = {};
	const stateB: Record<string, unknown> = {};
	const base = {
		executionStarted: true,
		isPartial: true,
		invalidate: () => undefined,
	};
	const activeA = syncToolActivity({ ...base, toolCallId: "active-a", state: stateA }, 1_000);
	const activeB = syncToolActivity({ ...base, toolCallId: "active-b", state: stateB }, 1_000);
	const callsA: Array<{ name: string; text: string }> = [];
	const callsB: Array<{ name: string; text: string }> = [];
	const callsLater: Array<{ name: string; text: string }> = [];
	// The fallback path routes the band core through `bold`, so tag it to find.
	const themeFor = (calls: Array<{ name: string; text: string }>) => ({
		fg: (name: string, text: string) => {
			calls.push({ name, text });
			return text;
		},
		bold: (text: string) => `\u0001${text}`,
	});
	const lineA = "0123456789".repeat(6);
	const lineB = "abcdefghij".repeat(6);
	renderSynchronizedShimmerLine(lineA, 60, themeFor(callsA), 700);
	renderSynchronizedShimmerLine(lineB, 60, themeFor(callsB), 700);
	renderSynchronizedShimmerLine(lineA, 60, themeFor(callsLater), 800);
	const lightColumn = (calls: Array<{ name: string; text: string }>) => {
		let column = 0;
		for (const call of calls) {
			if (call.text.startsWith("\u0001")) return column;
			column += visibleWidth(call.text);
		}
		return -1;
	};
	const litWidth = callsA
		.filter(({ name }) => name !== "muted")
		.reduce((width, { text }) => width + visibleWidth(text), 0);
	const settledA = syncToolActivity(
		{
			...base,
			toolCallId: "active-a",
			state: stateA,
			isPartial: false,
		},
		2_500,
	);
	const stillActiveB = syncToolActivity({ ...base, toolCallId: "active-b", state: stateB }, 2_500);
	syncToolActivity({ ...base, toolCallId: "active-b", state: stateB, isPartial: false }, 2_600);
	assert(
		"rows of one width share a single sweep that advances with the clock",
		activeA.active &&
			activeB.active &&
			lightColumn(callsA) === lightColumn(callsB) &&
			lightColumn(callsA) >= 0 &&
			lightColumn(callsLater) > lightColumn(callsA) &&
			litWidth >= 20 &&
			!settledA.active &&
			settledA.elapsedMs === 1_500 &&
			formatToolDuration(settledA.elapsedMs) === "1.5s" &&
			stillActiveB.active,
		JSON.stringify({ activeA, activeB, callsA, callsB, settledA, stillActiveB }),
	);
	resetToolActivity();
}

/** Read back the truecolor luminance the sweep assigned to each column. */
function shimmerLuminance(rendered: string): number[] {
	const levels: number[] = [];
	const pattern = /\x1b\[([\d;]*)m/g;
	let luminance = 0;
	let cursor = 0;
	let match: RegExpExecArray | null = pattern.exec(rendered);
	while (match !== null) {
		for (const _character of rendered.slice(cursor, match.index)) levels.push(luminance);
		const params = (match[1] ?? "").split(";").map((part) => Number.parseInt(part, 10) || 0);
		if (params[0] === 38 && params[1] === 2) {
			luminance =
				(0.2126 * (params[2] ?? 0) + 0.7152 * (params[3] ?? 0) + 0.0722 * (params[4] ?? 0)) / 255;
		}
		cursor = match.index + match[0].length;
		match = pattern.exec(rendered);
	}
	for (const _character of rendered.slice(cursor)) levels.push(luminance);
	return levels;
}

function testShimmerGradientQuality(): void {
	resetToolActivity();
	const terminal = { ...process.env };
	// Pretend to be a 24-bit terminal so the gradient path is exercised here.
	process.env.TERM = "xterm-256color";
	process.env.COLORTERM = "truecolor";
	delete process.env.NO_COLOR;
	const theme = {
		fg: (_name: string, text: string) => text,
		bold: (text: string) => text,
		shimmerRamp: ["#000000", "#ffffff"] as const,
	};
	const line = `\x1b[1mread\x1b[22m ${"src/module.ts ".repeat(6)}`;
	const levels = shimmerLuminance(renderSynchronizedShimmerLine(line, 80, theme, 700));
	const peak = levels.indexOf(Math.max(...levels));
	let monotonic = peak > 0 && peak < levels.length - 1;
	let biggestStep = 0;
	for (let index = 1; index < levels.length; index++) {
		const previous = levels[index - 1] ?? 0;
		const current = levels[index] ?? 0;
		biggestStep = Math.max(biggestStep, Math.abs(current - previous));
		if (index <= peak ? current < previous : current > previous) monotonic = false;
	}
	const distinct = new Set(levels.map((level) => level.toFixed(4))).size;
	const dimmed = shimmerLuminance(renderSynchronizedShimmerLine(line, 80, theme, 700, 0.4));
	const scan: number[] = [];
	for (let now = 0; now < 4_000; now += 25) {
		scan.push(Math.max(...shimmerLuminance(renderSynchronizedShimmerLine(line, 80, theme, now))));
	}
	const restFrames = scan.filter((top) => top === 0).length;
	assert(
		"the sweep is a single smooth band that dims with amplitude and rests",
		monotonic &&
			distinct >= 10 &&
			biggestStep < 0.15 &&
			Math.max(...dimmed) < Math.max(...levels) &&
			restFrames >= 8 &&
			restFrames < scan.length / 2 &&
			renderSynchronizedShimmerLine(line, 80, theme, 700, 0) === line,
		JSON.stringify({ peak, distinct, biggestStep, monotonic, restFrames, scan: scan.length }),
	);
	assert(
		"the sweep recolours text without disturbing inherited glyph weight",
		renderSynchronizedShimmerLine(line, 80, theme, 700).includes("\x1b[0;1m"),
		renderSynchronizedShimmerLine(line, 80, theme, 700),
	);
	process.env = terminal;
	resetToolActivity();
}

function testBodyPaddingX(): void {
	// Height 7 ensures room for header (title + divider = 2), body (1), footer (divider + hints + padding = 3), and a blank pad row
	const screen = renderFullscreenScreen({
		width: 12,
		height: 7,
		title: "Title",
		body: ["content"],
		keyHints: [{ key: "q", label: "quit" }],
	});
	const bodyPaddingXScreen = renderFullscreenScreen({
		width: 12,
		height: 7,
		title: "Title",
		body: ["content"],
		bodyPaddingX: 0,
		keyHints: [{ key: "q", label: "quit" }],
	});

	// Default: bodyPaddingX defaults to paddingX (1), so body line gets inset
	const bodyLine = screen.find((line: string) => line.includes("content"));
	assert(
		"bodyPaddingX defaults to paddingX when omitted",
		!!bodyLine && bodyLine.startsWith(" ") && bodyLine.endsWith(" "),
		JSON.stringify(bodyLine),
	);

	// bodyPaddingX=0: no extra outer inset; content starts at column 0
	const zeroLine = bodyPaddingXScreen.find((line: string) => line.includes("content"));
	assert(
		"bodyPaddingX=0 does not add outer inset",
		!!zeroLine && zeroLine.startsWith("content") && !zeroLine.startsWith(" "),
		JSON.stringify(zeroLine),
	);

	// Both versions still produce exact-width framed screens
	assert(
		"bodyPaddingX=0 still exact-width frames",
		bodyPaddingXScreen.length === 7 &&
			bodyPaddingXScreen.every((line: string) => visibleWidth(line) === 12),
		JSON.stringify(bodyPaddingXScreen),
	);
	assert(
		"default bodyPaddingX still exact-width frames",
		screen.length === 7 && screen.every((line: string) => visibleWidth(line) === 12),
		JSON.stringify(screen),
	);
}

function testToolRevealPolicy(): void {
	resetToolActivity();
	const content = new Text("\x1b[35mdetails\x1b[0m", 0, 0);
	const quiet = new ExpandableToolRender({ expanded: false, isError: true }, content, {
		errors: "hide",
	});
	const noisy = new ExpandableToolRender({ expanded: false, isError: true }, content);
	const expanded = new ExpandableToolRender({ expanded: true, isError: false }, content, {
		errors: "hide",
	});
	const activityState: Record<string, unknown> = {};
	const active = new ExpandableToolRender(
		{
			expanded: false,
			isError: false,
			toolCallId: "active-expandable",
			executionStarted: true,
			isPartial: true,
			state: activityState,
			invalidate: () => undefined,
		} as any,
		content,
		{ errors: "hide" },
	);
	const settled = new ExpandableToolRender(
		{
			expanded: false,
			isError: false,
			toolCallId: "active-expandable",
			executionStarted: true,
			isPartial: false,
			state: activityState,
			invalidate: () => undefined,
		} as any,
		content,
		{ errors: "hide" },
	);
	assert(
		"tool reveal policy hides or shows collapsed errors by option",
		!shouldRevealToolDetails({ expanded: false, isError: true }, { errors: "hide" }) &&
			shouldRevealToolDetails({ expanded: false, isError: true }) &&
			shouldRevealToolDetails({ expanded: true, isError: false }, { errors: "hide" }) &&
			quiet.render(40).length === 0 &&
			noisy.render(40).join("").includes("details") &&
			expanded.render(40).join("").includes("details") &&
			active.render(40).join("").includes("details") &&
			/· \d+\.\ds/u.test(active.render(40).join("")) &&
			!active.render(40).join("").includes("· running") &&
			active.render(40).join("").includes("\x1b[35m") &&
			settled.render(40).length === 0 &&
			emptyCollapsedToolRender().render(40).length === 0,
		JSON.stringify({
			quiet: quiet.render(40),
			noisy: noisy.render(40),
			expanded: expanded.render(40),
			active: active.render(40),
			settled: settled.render(40),
		}),
	);
	resetToolActivity();
}

testLineAndFrameBounds();
testChromeAndTinyFrames();
testChromeHelpers();
testPiThreadStyleParity();
testModelUsageFormatting();
testScrollingViewport();
testSelectableViewport();
testResponsiveSplitPane();
function testSoftGroupTrees(): void {
	const tracker = new SoftGroupTracker();
	const styled: Array<{ color: string; text: string }> = [];
	const theme = {
		fg: (color: string, text: string) => {
			styled.push({ color, text });
			return text;
		},
		bold: (text: string) => text,
	};
	const invalidations: string[] = [];
	const call = (
		id: string,
		summary: string,
		expanded = false,
		options: { tracker?: InstanceType<typeof SoftGroupTracker>; tail?: string } = {},
	) =>
		renderSoftGroupedCall({
			tracker: options.tracker ?? tracker,
			groupId: "read",
			label: "read",
			summary,
			summaryTail: options.tail,
			theme,
			context: {
				toolCallId: id,
				expanded,
				invalidate: () => invalidations.push(id),
			},
		}).render(40);

	const single = call("r1", "src/a.ts");
	const two = call("r2", "src/b.ts");
	const hidden = call("r1", "src/a.ts");
	const three = call("r3", "src/c.ts");
	const expanded = call("r1", "src/a.ts", true).join("\n");

	assert(
		"two- and three-call streaks render exact tree branches while one call stays compact",
		single.length === 1 &&
			single[0]?.includes("read src/a.ts") &&
			two.length === 3 &&
			two[0]?.trim() === "read" &&
			two[1]?.trim() === "├─ src/a.ts" &&
			two[2]?.trim() === "└─ src/b.ts" &&
			hidden.length === 0 &&
			three.length === 4 &&
			three[1]?.trim() === "├─ src/a.ts" &&
			three[2]?.trim() === "├─ src/b.ts" &&
			three[3]?.trim() === "└─ src/c.ts" &&
			expanded.includes("read src/a.ts") &&
			invalidations.includes("r1") &&
			styled.some((part) => part.color === "toolTitle" && part.text === "read") &&
			styled.some((part) => part.color === "muted" && part.text.includes("├─")),
		JSON.stringify({ single, two, hidden, three, expanded, invalidations }),
	);

	const narrowTracker = new SoftGroupTracker();
	const narrowCall = (id: string, name: string) =>
		renderSoftGroupedCall({
			tracker: narrowTracker,
			groupId: "read",
			label: "read",
			summary: "opening",
			summaryTail: `/very/long/identifying/${name}`,
			theme,
			context: { toolCallId: id, expanded: false },
		}).render(24);
	narrowCall("n1", "alpha.ts");
	const narrow = narrowCall("n2", "omega.ts");
	assert(
		"tree leaves wrap to two aligned lines while preserving identifying tails",
		narrow.length === 5 &&
			narrow.every((line) => visibleWidth(line) <= 24) &&
			narrow[1]?.trim() === "├─ opening" &&
			narrow[2]?.trim().startsWith("│") &&
			narrow[2]?.endsWith("alpha.ts") &&
			narrow[3]?.trim() === "└─ opening" &&
			!narrow[4]?.includes("│") &&
			narrow[4]?.endsWith("omega.ts"),
		JSON.stringify(narrow),
	);

	const mixedTracker = new SoftGroupTracker();
	const mixedCall = (id: string, label: string, summary: string) =>
		renderSoftGroupedCall({
			tracker: mixedTracker,
			groupId: "files",
			groupLabel: "files",
			label,
			summary,
			theme,
			context: { toolCallId: id, expanded: false },
		}).render(50);
	mixedCall("m1", "read", "src/input.ts");
	const mixed = mixedCall("m2", "write", "src/output.ts");
	assert(
		"generic mixed groups retain attributable child tool labels",
		mixed[0]?.trim() === "files" &&
			mixed[1]?.trim() === "├─ read src/input.ts" &&
			mixed[2]?.trim() === "└─ write src/output.ts",
		JSON.stringify(mixed),
	);

	const failedTracker = new SoftGroupTracker();
	const failedCall = (id: string, isError = false) =>
		renderSoftGroupedCall({
			tracker: failedTracker,
			groupId: "read",
			label: "read",
			summary: `${id}.ts`,
			theme,
			context: {
				toolCallId: id,
				expanded: false,
				isError,
				invalidate: () => invalidations.push(`failed:${id}`),
			},
		}).render(40);
	failedCall("f1");
	failedCall("f2");
	failedCall("f3");
	const failed = failedCall("f2", true);
	const before = failedCall("f1");
	const after = failedCall("f3");
	assert(
		"failed calls render standalone and split neighboring tree topology",
		failed.length === 1 &&
			failed[0]?.includes("f2.ts") &&
			before.length === 1 &&
			after.length === 1 &&
			failedTracker.getStreak("f1")?.items.length === 1 &&
			failedTracker.getStreak("f3")?.items.length === 1 &&
			invalidations.includes("failed:f1") &&
			invalidations.includes("failed:f3"),
		JSON.stringify({ failed, before, after, invalidations }),
	);
}

function testSoftGroupRenderCaches(): void {
	resetToolActivity();
	const trackedTheme = (tag: string) => {
		let calls = 0;
		const themeColor =
			16 + ([...tag].reduce((total, character) => total + character.charCodeAt(0), 0) % 216);
		return {
			theme: {
				fg: (_color: string, text: string) => {
					calls++;
					return `\x1b[38;5;${themeColor}m${text}\x1b[0m`;
				},
				bold: (text: string) => {
					calls++;
					return `\x1b[1m${text}\x1b[0m`;
				},
			},
			calls: () => calls,
		};
	};
	const cacheTheme = trackedTheme("cache");
	const row = renderSoftGroupedCall({
		tracker: new SoftGroupTracker(),
		groupId: "cache",
		label: "read",
		summary: "src/cache.ts",
		theme: cacheTheme.theme,
		context: {
			toolCallId: "cache-row",
			executionStarted: true,
			isPartial: false,
		},
	});
	const first = row.render(40);
	const callsAfterFirst = cacheTheme.calls();
	const repeated = row.render(40);
	const callsAfterRepeated = cacheTheme.calls();
	const narrower = row.render(30);
	const callsAfterWidthChange = cacheTheme.calls();
	row.invalidate();
	const invalidated = row.render(30);
	assert(
		"soft-group rows reuse same-width content lines and invalidate cleanly",
		first === repeated &&
			callsAfterRepeated === callsAfterFirst &&
			narrower !== repeated &&
			callsAfterWidthChange > callsAfterRepeated &&
			invalidated !== narrower &&
			cacheTheme.calls() > callsAfterWidthChange,
		JSON.stringify({ first, repeated, narrower, invalidated, callsAfterFirst, callsAfterRepeated }),
	);

	const treeTheme = trackedTheme("tree-cache");
	const treeTracker = new SoftGroupTracker();
	renderSoftGroupedCall({
		tracker: treeTracker,
		groupId: "cache-tree",
		label: "read",
		summary: "first item",
		theme: treeTheme.theme,
		context: { toolCallId: "tree-1", executionStarted: true, isPartial: false },
	});
	const treeRow = renderSoftGroupedCall({
		tracker: treeTracker,
		groupId: "cache-tree",
		label: "read",
		summary: "second item",
		theme: treeTheme.theme,
		context: { toolCallId: "tree-2", executionStarted: true, isPartial: false },
	});
	const treeFirst = treeRow.render(40);
	const treeCalls = treeTheme.calls();
	const treeRepeated = treeRow.render(40);
	const treeCallsAfterRepeated = treeTheme.calls();
	const treeNarrow = treeRow.render(30);
	assert(
		"tree rows reuse content lines and width changes rerender them",
		treeFirst === treeRepeated &&
			treeCallsAfterRepeated === treeCalls &&
			treeNarrow !== treeRepeated &&
			treeTheme.calls() > treeCallsAfterRepeated,
		JSON.stringify({ treeFirst, treeRepeated, treeNarrow, treeCalls, treeCallsAfterRepeated }),
	);

	const summaryTracker = new SoftGroupTracker();
	const summaryTheme = trackedTheme("summary");
	const summaryBefore = renderSoftGroupedCall({
		tracker: summaryTracker,
		groupId: "summary",
		label: "read",
		summary: "before",
		theme: summaryTheme.theme,
		context: { toolCallId: "summary-row", executionStarted: true, isPartial: false },
	}).render(40);
	const summaryAfter = renderSoftGroupedCall({
		tracker: summaryTracker,
		groupId: "summary",
		label: "read",
		summary: "after",
		theme: summaryTheme.theme,
		context: { toolCallId: "summary-row", executionStarted: true, isPartial: false },
	}).render(40);
	const changedTreeTracker = new SoftGroupTracker();
	const changedTreeTheme = trackedTheme("item");
	renderSoftGroupedCall({
		tracker: changedTreeTracker,
		groupId: "items",
		label: "read",
		summary: "first",
		theme: changedTreeTheme.theme,
		context: { toolCallId: "item-1", executionStarted: true, isPartial: false },
	});
	const treeBefore = renderSoftGroupedCall({
		tracker: changedTreeTracker,
		groupId: "items",
		label: "read",
		summary: "second",
		theme: changedTreeTheme.theme,
		context: { toolCallId: "item-2", executionStarted: true, isPartial: false },
	}).render(40);
	const treeAfter = renderSoftGroupedCall({
		tracker: changedTreeTracker,
		groupId: "items",
		label: "read",
		summary: "updated",
		theme: changedTreeTheme.theme,
		context: { toolCallId: "item-2", executionStarted: true, isPartial: false },
	}).render(40);
	assert(
		"summary and tree item changes recompute content",
		summaryBefore.join("\n") !== summaryAfter.join("\n") &&
			summaryAfter.join("\n").includes("after") &&
			treeBefore.join("\n") !== treeAfter.join("\n") &&
			treeAfter.join("\n").includes("updated"),
		JSON.stringify({ summaryBefore, summaryAfter, treeBefore, treeAfter }),
	);

	const themeA = trackedTheme("theme-a");
	const themeB = trackedTheme("theme-b");
	const themeRowA = renderSoftGroupedCall({
		tracker: new SoftGroupTracker(),
		groupId: "theme",
		label: "read",
		summary: "same",
		theme: themeA.theme,
		context: { toolCallId: "theme-a", executionStarted: false },
	});
	const themeRowB = renderSoftGroupedCall({
		tracker: new SoftGroupTracker(),
		groupId: "theme",
		label: "read",
		summary: "same",
		theme: themeB.theme,
		context: { toolCallId: "theme-b", executionStarted: false },
	});
	const themedA = themeRowA.render(40);
	const themedB = themeRowB.render(40);
	assert(
		"different theme identities do not reuse cached content",
		themeA.calls() > 0 && themeB.calls() > 0 && themedA.join("\n") !== themedB.join("\n"),
		JSON.stringify({ themedA, themedB, themeACalls: themeA.calls(), themeBCalls: themeB.calls() }),
	);

	const expandedTheme = trackedTheme("expanded-cache");
	const expandedRow = renderSoftGroupedCall({
		tracker: new SoftGroupTracker(),
		groupId: "expanded",
		label: "read",
		summary: "expanded details that wrap",
		theme: expandedTheme.theme,
		context: { expanded: true },
	});
	const expandedFirst = expandedRow.render(40);
	const expandedRepeated = expandedRow.render(40);
	const expandedNarrow = expandedRow.render(25);
	expandedRow.invalidate();
	const expandedInvalidated = expandedRow.render(25);
	assert(
		"expanded rows cache width-specific content and honor invalidate",
		expandedFirst === expandedRepeated &&
			expandedNarrow !== expandedRepeated &&
			expandedInvalidated !== expandedNarrow,
		JSON.stringify({ expandedFirst, expandedRepeated, expandedNarrow, expandedInvalidated }),
	);

	const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
	const terminal = { ...process.env };
	const realNow = Date.now;
	process.env.TERM = "xterm-256color";
	process.env.COLORTERM = "truecolor";
	delete process.env.NO_COLOR;
	try {
		const activeTheme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			shimmerRamp: ["#000000", "#ffffff"] as const,
		};
		let now = 0;
		Date.now = () => now;
		const activeRow = renderSoftGroupedCall({
			tracker: new SoftGroupTracker(),
			groupId: "active-cache",
			label: "read",
			summary: "1234567",
			theme: activeTheme,
			context: {
				toolCallId: "active-cache",
				executionStarted: true,
				isPartial: true,
				state: {},
				invalidate: () => undefined,
			},
		});
		const atZero = plain(activeRow.render(20)[0] ?? "");
		now = 10_000;
		const atTenSeconds = plain(activeRow.render(20)[0] ?? "");
		const durationNormalized = (line: string): string =>
			line.replace(/ · \d+\.\ds$/u, " · <duration>");
		now = 700;
		const animatedFirst = activeRow.render(40).map(durationNormalized).join("\n");
		now = 900;
		const animatedSecond = activeRow.render(40).map(durationNormalized).join("\n");
		assert(
			"active rows reserve growing live durations without caching the suffix",
			atZero.includes("1234567 · 0.0s") &&
				atTenSeconds.includes("12345… · 10.0s") &&
				atZero !== atTenSeconds,
			JSON.stringify({ atZero, atTenSeconds }),
		);
		assert(
			"active rows still animate across Date.now changes",
			animatedFirst !== animatedSecond,
			JSON.stringify({ animatedFirst, animatedSecond }),
		);
	} finally {
		Date.now = realNow;
		process.env = terminal;
		resetToolActivity();
	}
}

function testLiveDurationPlacement(): void {
	resetToolActivity();
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
	const liveContext = (expanded: boolean) => ({
		toolCallId: "live-search",
		expanded,
		executionStarted: true,
		isPartial: true,
		state: {},
		invalidate: () => undefined,
	});
	const summary = "site:example.com/docs bundled workflow definition long tail query";
	const call = (expanded: boolean, expandedLines?: string[]) =>
		renderSoftGroupedCall({
			tracker: new SoftGroupTracker(),
			groupId: "web-search",
			label: "web search",
			summary,
			unitCount: 1,
			theme,
			context: liveContext(expanded),
			expandedLines,
		}).render(60);

	const collapsed = call(false).map(plain);
	const expanded = call(true, ["web search · 3 queries", "1. one", "2. two", `3. ${summary}`]).map(
		plain,
	);

	assert(
		"the live duration sits on the title row and leaves an ellipsis when clipping",
		collapsed.length === 1 &&
			/… · \d+\.\ds$/u.test(collapsed[0] ?? "") &&
			visibleWidth(collapsed[0] ?? "") <= 60 &&
			/^(?:web search · 3 queries) · \d+\.\ds$/u.test(expanded[0]?.trim() ?? "") &&
			expanded.slice(1).every((line) => !/· \d+\.\ds/u.test(line)) &&
			expanded.some((line) => line.includes("3. site:example.com/docs")),
		JSON.stringify({ collapsed, expanded }),
	);
	resetToolActivity();
}

function testSoftGroupLifecycleAndHistory(): void {
	const tracker = new SoftGroupTracker();
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
	bindSoftGroupTracker(
		{
			on: (event, handler) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		},
		tracker,
		["read"],
	);
	const emit = (event: string, payload: any = {}, ctx: any = {}) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const toolCall = (id: string, name = "read") => ({
		type: "toolCall",
		id,
		name,
		arguments: {},
	});
	const entry = (message: any) => ({ type: "message", message });
	const branch = [
		entry({ role: "user", content: "begin" }),
		entry({ role: "assistant", content: [toolCall("hist-1")] }),
		entry({ role: "toolResult", toolCallId: "hist-1", toolName: "read", content: [] }),
		entry({ role: "assistant", content: [toolCall("hist-2")] }),
		entry({
			role: "assistant",
			content: [toolCall("hist-3"), { type: "thinking", thinking: "visible reasoning" }],
		}),
		{ type: "compaction", summary: "boundary" },
		entry({ role: "assistant", content: [toolCall("hist-4")] }),
		entry({ role: "assistant", content: [toolCall("other-1", "bash")] }),
		entry({ role: "assistant", content: [toolCall("hist-5")] }),
	];
	emit("session_start", {}, { sessionManager: { getBranch: () => branch } });

	const historical = (id: string, expanded = false) =>
		renderSoftGroupedCall({
			tracker,
			groupId: "read",
			label: "read",
			summary: id,
			theme,
			context: { toolCallId: id, expanded, executionStarted: false },
		}).render(50);
	const hist1 = historical("hist-1");
	const hist2 = historical("hist-2");
	const hist3 = historical("hist-3");
	const hist4 = historical("hist-4");
	const hist5 = historical("hist-5");
	const expanded = historical("hist-1", true).join("\n");
	const repaint = historical("hist-2");
	const missingHistorical = historical("not-seeded");

	assert(
		"session history seeds same-name tool-only turns and preserves prose, structural, and tool boundaries",
		hist1.length === 0 &&
			hist2.length === 3 &&
			hist2[1]?.trim() === "├─ hist-1" &&
			hist2[2]?.trim() === "└─ hist-2" &&
			hist3.length === 1 &&
			hist4.length === 1 &&
			hist5.length === 1 &&
			expanded.includes("read hist-1") &&
			repaint.length === 3 &&
			repaint[1]?.trim() === "├─ hist-1" &&
			repaint[2]?.trim() === "└─ hist-2" &&
			tracker
				.getStreak("hist-2")
				?.items.map((item) => item.toolCallId)
				.join(",") === "hist-1,hist-2" &&
			missingHistorical.length === 1,
		JSON.stringify({ hist1, hist2, hist3, hist4, hist5, expanded, repaint }),
	);

	emit("message_start", { message: { role: "user", content: "continue" } });
	emit("message_start", { message: { role: "assistant", content: [] } });
	const live = (id: string) =>
		renderSoftGroupedCall({
			tracker,
			groupId: "read",
			label: "read",
			summary: id,
			theme,
			context: { toolCallId: id, expanded: false, executionStarted: true },
		}).render(50);
	live("live-1");
	emit("turn_start");
	const liveTree = live("live-2");

	emit("turn_start");
	emit("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: "Now inspect" }] },
	});
	live("live-3");
	emit("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: "Now inspect more" }] },
	});
	const updateTree = live("live-4");
	emit("tool_execution_start", { toolName: "bash", toolCallId: "bash-live" });
	const afterDifferentTool = live("live-5");
	const missingLive = renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "ghost",
		theme,
		context: { toolCallId: "", expanded: false, executionStarted: true },
	}).render(50);

	assert(
		"live tool-only turns group; prose updates break once and different tools break",
		liveTree.length === 3 &&
			liveTree[1]?.includes("live-1") &&
			liveTree[2]?.includes("live-2") &&
			updateTree.length === 3 &&
			updateTree[1]?.includes("live-3") &&
			updateTree[2]?.includes("live-4") &&
			afterDifferentTool.length === 1 &&
			missingLive.length === 0,
		JSON.stringify({ liveTree, updateTree, afterDifferentTool, missingLive }),
	);
}

testShimmerTimingContract();
testSynchronizedToolActivity();
testShimmerGradientQuality();
testToolRevealPolicy();
testBodyPaddingX();
testSoftGroupTrees();
testSoftGroupRenderCaches();
testLiveDurationPlacement();
testSoftGroupLifecycleAndHistory();
console.log("All tui-kit tests passed.");
