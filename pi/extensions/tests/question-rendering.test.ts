import { initTheme } from "@earendil-works/pi-coding-agent";

import questionExtension from "../question.ts";

initTheme("dark");

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

let questionTool: any;
questionExtension({
	registerTool: (tool: any) => {
		questionTool = tool;
	},
} as any);

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const args = {
	questions: [
		{
			title: "Scope",
			question: "Which files should change?",
			mode: "single",
			options: [{ value: "all", label: "All files", recommended: true }],
			allowAll: false,
		},
	],
};
const result = {
	content: [{ type: "text", text: "Scope: All files" }],
	details: {
		cancelled: false,
		questions: [
			{
				...args.questions[0],
				answers: [{ value: "all", label: "All files", wasCustom: false }],
			},
		],
	},
};

const collapsedCall = questionTool
	.renderCall(args, theme, { expanded: false, isError: false })
	.render(80)
	.join("\n");
const collapsedResult = questionTool
	.renderResult(result, { expanded: false, isPartial: false }, theme, {
		expanded: false,
		isError: false,
	})
	.render(80)
	.join("\n");
const expandedCall = questionTool
	.renderCall(args, theme, { expanded: true, isError: false })
	.render(80)
	.join("\n");
const expandedResult = questionTool
	.renderResult(result, { expanded: true, isPartial: false }, theme, {
		expanded: true,
		isError: false,
	})
	.render(80)
	.join("\n");
const errorResult = questionTool
	.renderResult(
		{ content: [{ type: "text", text: "Question failed" }] },
		{ expanded: false, isPartial: false },
		theme,
		{ expanded: false, isError: true },
	)
	.render(80)
	.join("\n");

assert(
	"question history stays concise until Ctrl+O reveals the full exchange",
	questionTool.renderShell === "self" &&
		collapsedCall === "" &&
		collapsedResult.includes("Answered · Scope: All files") &&
		expandedCall.includes("Which files should change?") &&
		expandedResult.includes("A Scope: All files") &&
		errorResult.includes("Question failed"),
	JSON.stringify({ collapsedCall, collapsedResult, expandedCall, expandedResult, errorResult }),
);

let customOptions: unknown = "not-called";
let customInputLines: string[] = [];
let expandedCustomInputLines: string[] = [];
const customAnswer = "A longer custom answer that wraps onto another line";
const inlineResult = await questionTool.execute("question-inline", args, undefined, undefined, {
	mode: "tui",
	ui: {
		custom: async (factory: any, options?: unknown) => {
			customOptions = options;
			return new Promise((resolve) => {
				const view = factory(
					{ requestRender() {}, terminal: { rows: 24 } },
					theme,
					{ matches: () => false },
					resolve,
				);
				view.focused = true;
				view.handleInput("\x1b[B");
				view.handleInput("\r");
				customInputLines = view.render(80);
				for (const character of customAnswer) view.handleInput(character);
				expandedCustomInputLines = view.render(32);
				view.handleInput("\r");
			});
		},
	},
});

assert(
	"questions use Pi's inline custom UI and always offer custom input",
	customOptions === undefined &&
		questionTool.parameters.properties.questions.items.properties.allowCustom === undefined &&
		inlineResult.details.questions[0].answers[0].value === customAnswer &&
		inlineResult.details.questions[0].answers[0].wasCustom === true,
	JSON.stringify({ customOptions, inlineResult }),
);
const removeControlSequences = (line: string): string =>
	line.replaceAll("\x1b_pi:c\x07", "").replace(/\x1b\[[0-9;]*m/g, "");
const plainCustomInputLines = customInputLines.map(removeControlSequences);
const plainExpandedInputLines = expandedCustomInputLines.map(removeControlSequences);
assert(
	"custom input is borderless with a compact prompt and inline placeholder",
	plainCustomInputLines.filter((line) => line.includes("────────────────────")).length === 2 &&
		plainCustomInputLines.some((line) => line.includes("› Type a custom answer...")) &&
		plainCustomInputLines.every((line) => !line.includes("Custom answer:")) &&
		plainExpandedInputLines.filter((line) => line.includes("────────────────────")).length === 2 &&
		plainExpandedInputLines.some((line) => line.includes("› A longer custom answer")) &&
		plainExpandedInputLines.some((line) => line.includes("that wraps onto another")) &&
		plainExpandedInputLines.some((line) => line.trim() === "line"),
	JSON.stringify({ initial: plainCustomInputLines, expanded: plainExpandedInputLines }),
);
