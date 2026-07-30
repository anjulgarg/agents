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
			active.render(40).join("").includes("running") &&
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
function testSoftGroupOptionB(): void {
	const tracker = new SoftGroupTracker();
	const mutedParts: string[] = [];
	const theme = {
		fg: (color: string, text: string) => {
			if (color === "muted") mutedParts.push(text);
			return text;
		},
		bold: (text: string) => text,
	};
	const invalidations: string[] = [];
	const first = renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "src/a.ts",
		theme,
		context: {
			toolCallId: "r1",
			expanded: false,
			invalidate: () => invalidations.push("r1"),
		},
	}).render(40);
	const second = renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "src/b.ts",
		unitCount: 2,
		theme,
		context: {
			toolCallId: "r2",
			expanded: false,
			invalidate: () => invalidations.push("r2"),
		},
	}).render(40);
	const firstAgain = renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "src/a.ts",
		theme,
		context: {
			toolCallId: "r1",
			expanded: false,
			invalidate: () => invalidations.push("r1"),
		},
	}).render(40);
	const expanded = renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "src/a.ts",
		theme,
		context: {
			toolCallId: "r1",
			expanded: true,
			invalidate: () => undefined,
		},
	})
		.render(40)
		.join("\n");
	const truncated = renderSoftGroupedCall({
		tracker: new SoftGroupTracker(),
		groupId: "grep",
		label: "grep",
		summary: "/✓ \\$|✓ edit|✓ write|✓.*checkpoint/ in coding/.pi/agent/extensions/tests · *.ts",
		theme,
		context: {
			toolCallId: "historical-grep",
			expanded: false,
			executionStarted: false,
		},
	}).render(81);

	assert(
		"soft-group option B keeps one leader line and expands rows independently",
		first.length === 1 &&
			second.length === 1 &&
			second[0]?.includes("read · 3 ·") &&
			second[0]?.includes("src/b.ts") &&
			firstAgain.length === 0 &&
			expanded.includes("read src/a.ts") &&
			invalidations.includes("r1") &&
			!invalidations.includes("r2") &&
			visibleWidth(second[0] ?? "") <= 40 &&
			truncated[0]?.endsWith("tests…") &&
			!truncated[0]?.includes(" ·…") &&
			visibleWidth(truncated[0] ?? "") <= 81,
		JSON.stringify({ first, second, firstAgain, expanded, truncated, invalidations }),
	);
	assert(
		"collapsed group count and separators use muted styling like the path",
		mutedParts.includes("3") && mutedParts.includes(" · "),
		JSON.stringify(mutedParts),
	);
}

function testRunningLabelPlacement(): void {
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
		"the running marker sits on the title row and leaves an ellipsis when clipping",
		collapsed.length === 1 &&
			collapsed[0]!.endsWith("… · running") &&
			visibleWidth(collapsed[0] ?? "") <= 60 &&
			expanded[0]?.trim() === "web search · 3 queries · running" &&
			expanded.slice(1).every((line) => !line.includes("running")) &&
			expanded.some((line) => line.includes("3. site:example.com/docs")),
		JSON.stringify({ collapsed, expanded }),
	);
	resetToolActivity();
}

function testSoftGroupTurnBreakAndHistory(): void {
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
	const emit = (event: string, payload: any = {}) => {
		for (const handler of handlers.get(event) ?? []) {
			handler(payload, {});
		}
	};

	emit("session_start");
	renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "old-a",
		theme,
		context: { toolCallId: "old-a", expanded: false, executionStarted: true },
	});
	renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "old-b",
		theme,
		context: { toolCallId: "old-b", expanded: false, executionStarted: true },
	});

	emit("turn_start");
	const live = renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "live",
		theme,
		context: { toolCallId: "live-1", expanded: false, executionStarted: true },
	}).render(40);

	// Out-of-order historical repaint must not steal leadership from the live row.
	const histB = renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "old-b",
		theme,
		context: { toolCallId: "hist-b", expanded: false, executionStarted: false },
	}).render(40);
	const histA = renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "old-a",
		theme,
		context: { toolCallId: "hist-a", expanded: false, executionStarted: false },
	}).render(40);
	const liveAgain = renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "live",
		theme,
		context: { toolCallId: "live-1", expanded: false, executionStarted: true },
	}).render(40);
	const missingId = renderSoftGroupedCall({
		tracker,
		groupId: "read",
		label: "read",
		summary: "ghost",
		theme,
		context: { toolCallId: "", expanded: false, executionStarted: true },
	}).render(40);

	assert(
		"turn_start breaks streaks; historical and missing ids cannot rewrite live chrome",
		live[0]?.includes("read live") &&
			histA[0]?.includes("old-a") &&
			histB[0]?.includes("old-b") &&
			liveAgain[0]?.includes("read live") &&
			missingId.length === 0 &&
			tracker.getStreak("live-1")?.totalUnits === 1 &&
			tracker.getStreak("old-b")?.totalUnits === 2,
		JSON.stringify({
			live,
			histA,
			histB,
			liveAgain,
			missingId,
			streak: tracker.getStreak("live-1"),
		}),
	);
}

testSynchronizedToolActivity();
testShimmerGradientQuality();
testToolRevealPolicy();
testBodyPaddingX();
testSoftGroupOptionB();
testRunningLabelPlacement();
testSoftGroupTurnBreakAndHistory();
console.log("All tui-kit tests passed.");
