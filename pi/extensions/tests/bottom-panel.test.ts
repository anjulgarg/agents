import { BottomPanel, BOTTOM_PANEL_MAX_LINES } from "../lib/tui/index.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as any;

function numbered(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

{
	const panel = new BottomPanel();
	panel.registerSection("greedy", {
		order: 1,
		maxLines: 10,
		render: () => numbered("greedy", 10),
		overflowLabel: (omitted) => `+ ${omitted} more greedy`,
	});
	panel.registerSection("later", {
		order: 2,
		maxLines: 1,
		render: () => ["later"],
	});
	const rendered = panel.render(80, theme);
	assert(
		"an earlier extensible section cannot starve a later section",
		rendered.length === BOTTOM_PANEL_MAX_LINES && rendered.at(-1) === "later",
		JSON.stringify(rendered),
	);
}

{
	const panel = new BottomPanel();
	panel.registerSection("todos", {
		order: 30,
		maxLines: 6,
		render: () => numbered("todo", 8),
		overflowLabel: (omitted) => `+ ${omitted} more`,
	});
	panel.registerSection("subagents", {
		order: 20,
		maxLines: 1,
		render: () => ["subagents"],
	});
	panel.registerSection("async", {
		order: 10,
		maxLines: 3,
		render: () => numbered("async", 6),
		overflowLabel: (omitted) => `+ ${omitted} more async commands`,
	});

	const rendered = panel.render(80, theme);
	assert(
		"orders sections and allocates 3/1/4 within the 10-line cap",
		rendered.length === BOTTOM_PANEL_MAX_LINES &&
			rendered.join("|") ===
				"async-1|async-2|+ 4 more async commands||subagents||todo-1|todo-2|todo-3|+ 5 more",
		JSON.stringify(rendered),
	);
}

{
	const panel = new BottomPanel();
	panel.registerSection("todos", {
		order: 30,
		maxLines: 6,
		render: () => numbered("todo", 8),
		overflowLabel: (omitted) => `+ ${omitted} more`,
	});
	const rendered = panel.render(80, theme);
	assert(
		"todos grow to six lines when transient sections are absent",
		rendered.length === 6 && rendered.at(-1) === "+ 3 more",
		JSON.stringify(rendered),
	);
}

{
	const panel = new BottomPanel();
	let mounted: any;
	let clears = 0;
	let renders = 0;
	const tui = { requestRender: () => renders++ } as any;
	const ui = {
		theme,
		setWidget: (_key: string, content: any) => {
			mounted?.dispose?.();
			mounted = typeof content === "function" ? content(tui, theme) : undefined;
			if (content === undefined) clears++;
		},
	} as any;
	panel.attach({ mode: "tui", ui });
	const section = panel.registerSection("future", {
		order: 15,
		maxLines: 2,
		render: () => ["one"],
	});
	section.update({ render: () => ["two"] });
	const updated = mounted.render(80);
	section.remove();
	assert(
		"section handles update one host and remove it cleanly",
		updated.join("|") === "two" && clears === 1 && renders >= 1 && mounted === undefined,
		JSON.stringify({ updated, clears, renders, mounted: Boolean(mounted) }),
	);
}
