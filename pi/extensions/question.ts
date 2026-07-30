import { StringEnum } from "@earendil-works/pi-ai";
import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Container,
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emptyCollapsedToolRender, shouldRevealToolDetails } from "./lib/tui/index.ts";

const RESET_FG = "\x1b[39m";
const ANNOUNCE_TEXT_COLOR = 222;
const SELECTION_MODES = ["single", "multiple", "input"] as const;
type SelectionMode = (typeof SELECTION_MODES)[number];

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
}

interface QuestionConfig {
	title: string;
	question: string;
	mode: SelectionMode;
	options: QuestionOption[];
	allowAll: boolean;
	placeholder?: string;
}

interface QuestionAnswer {
	value: string;
	label: string;
	wasCustom: boolean;
}

interface QuestionResult extends QuestionConfig {
	answers: QuestionAnswer[];
}

interface QuestionDetails {
	questions: QuestionResult[];
	cancelled: boolean;
}

interface QuestionState {
	selectedIndex: number;
	selected: Set<number>;
	customAnswers: QuestionAnswer[];
	answers?: QuestionAnswer[];
	inputMode: boolean;
}

type DisplayItem =
	| { kind: "option"; option: QuestionOption; optionIndex: number }
	| { kind: "all"; label: string }
	| { kind: "custom"; label: string }
	| { kind: "clear-custom"; label: string }
	| { kind: "submit"; label: string };

const OptionSchema = Type.Object({
	value: Type.String({ description: "Stable value returned to the agent" }),
	label: Type.String({ description: "Display label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional supporting description" })),
	recommended: Type.Optional(
		Type.Boolean({ description: "Mark this as an agent-recommended choice" }),
	),
});

const QuestionSchema = Type.Object({
	title: Type.String({
		description: "Unique one-word title shown in the question tab bar",
		minLength: 1,
		maxLength: 20,
		pattern: "^\\S+$",
	}),
	question: Type.String({ description: "Focused question shown to the user" }),
	mode: Type.Optional(
		StringEnum(SELECTION_MODES, {
			description:
				'"single" selects one option, "multiple" selects any number, and "input" requests freeform text',
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description: "Options used by single and multiple modes",
			maxItems: 20,
		}),
	),
	allowAll: Type.Optional(
		Type.Boolean({
			description: 'In multiple mode, offer an "All of the above" action; defaults to false',
		}),
	),
	placeholder: Type.Optional(
		Type.String({ description: "Placeholder guidance for freeform input" }),
	),
});

const QuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Focused questions to present together in one tabbed panel",
		minItems: 1,
		maxItems: 4,
	}),
});

function announceColor(text: string): string {
	return `\x1b[38;5;${ANNOUNCE_TEXT_COLOR}m${text}${RESET_FG}`;
}

function resultContent(details: QuestionDetails): string {
	if (details.cancelled) return "User cancelled the questions";
	return details.questions
		.flatMap((question) => {
			if (question.answers.length === 0) return [`${question.title}: User submitted no selections`];
			return question.answers.map(
				(answer) =>
					`${question.title}: ${answer.wasCustom ? `User wrote: ${answer.label}` : `User selected: ${answer.label} (${answer.value})`}`,
			);
		})
		.join("\n");
}

export default function questionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		renderShell: "self",
		description:
			"Ask one to four focused interactive questions in one tabbed panel. Single and multiple selections always offer custom input. Questions also support all-of-the-above and direct freeform input. Use only when user input is required to proceed.",
		promptSnippet: "Ask focused interactive questions together in a tabbed panel",
		promptGuidelines: [
			"Use question only when missing user input materially changes the result; otherwise make a safe, explicit assumption.",
			"Group independent questions into one question call instead of asking them sequentially.",
			"Give every question a unique, concise, one-word title.",
			"Use question mode single for one choice, multiple for several choices, and input for direct freeform text.",
			"Single and multiple questions always include a custom input option.",
			"For every single or multiple question with options, set recommended: true on your preferred option or options and place them first.",
			"Mark exactly one option recommended for single choice and one or more options for multiple choice.",
			"For question options, provide stable values, concise labels, and descriptions only when they clarify a real trade-off.",
		],
		parameters: QuestionParams,
		prepareArguments(args): any {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			if (Array.isArray(input.questions) || typeof input.question !== "string") return args;
			return {
				questions: [
					{
						title: "Question",
						question: input.question,
						mode: input.mode,
						options: input.options,
						allowAll: input.allowAll,
						placeholder: input.placeholder,
					},
				],
			};
		},
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions: QuestionConfig[] = params.questions.map((question) => ({
				title: question.title,
				question: question.question,
				mode: question.mode ?? "single",
				options: question.options ?? [],
				allowAll: question.allowAll === true,
				placeholder: question.placeholder,
			}));
			const emptyDetails = (): QuestionDetails => ({
				questions: questions.map((question) => ({ ...question, answers: [] })),
				cancelled: true,
			});
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Interactive questions unavailable outside TUI mode" }],
					details: emptyDetails(),
				};
			}
			const titles = new Set<string>();
			for (const question of questions) {
				const normalizedTitle = question.title.toLocaleLowerCase();
				if (titles.has(normalizedTitle))
					throw new Error(`Question titles must be unique: ${question.title}`);
				titles.add(normalizedTitle);
				const recommendedCount = question.options.filter((option) => option.recommended).length;
				if (question.mode === "single" && question.options.length > 0 && recommendedCount !== 1) {
					throw new Error(
						`${question.title}: single-choice questions require exactly one recommended option`,
					);
				}
				if (question.mode === "multiple" && question.options.length > 0 && recommendedCount === 0) {
					throw new Error(
						`${question.title}: multiple-choice questions require at least one recommended option`,
					);
				}
			}

			const result = await ctx.ui.custom<QuestionDetails>((tui, theme, keybindings, done) => {
				let currentQuestionIndex = 0;
				let componentFocused = false;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				const editorTheme: EditorTheme = {
					borderColor: (text) => theme.fg("accent", text),
					selectList: {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				};
				const editors = questions.map(() => new Editor(tui, editorTheme));
				const states: QuestionState[] = questions.map((question) => {
					const recommendedIndexes = question.options
						.map((option, index) => ({ option, index }))
						.filter(({ option }) => option.recommended)
						.map(({ index }) => index);
					return {
						selectedIndex: question.mode === "single" ? (recommendedIndexes[0] ?? 0) : 0,
						selected: new Set(question.mode === "multiple" ? recommendedIndexes : []),
						customAnswers: [],
						inputMode: question.mode === "input",
					};
				});

				const items = (index: number): DisplayItem[] => {
					const question = questions[index];
					const state = states[index];
					if (question.mode === "input") return [];
					const displayItems: DisplayItem[] = question.options.map((option, optionIndex) => ({
						kind: "option",
						option,
						optionIndex,
					}));
					if (question.mode === "multiple" && question.allowAll && question.options.length > 1) {
						displayItems.push({ kind: "all", label: "All of the above" });
					}
					displayItems.push({ kind: "custom", label: "Custom input..." });
					if (question.mode === "multiple" && state.customAnswers.length) {
						displayItems.push({ kind: "clear-custom", label: "Remove custom answers" });
					}
					if (question.mode === "multiple") {
						displayItems.push({ kind: "submit", label: "Continue with selected answers" });
					}
					return displayItems;
				};
				for (const [index, question] of questions.entries()) {
					if (question.mode === "multiple" && states[index].selected.size > 0) {
						states[index].selectedIndex = items(index).findIndex((item) => item.kind === "submit");
					}
				}

				const refresh = () => {
					cachedWidth = undefined;
					cachedLines = undefined;
					tui.requestRender();
				};
				const details = (cancelled: boolean): QuestionDetails => ({
					questions: questions.map((question, index) => ({
						...question,
						answers: states[index].answers ?? [],
					})),
					cancelled,
				});
				const allAnswered = () => states.every((state) => state.answers !== undefined);
				const advanceAfterAnswer = () => {
					if (allAnswered()) {
						done(details(false));
						return;
					}
					for (let offset = 1; offset <= questions.length; offset++) {
						const candidate = (currentQuestionIndex + offset) % questions.length;
						if (states[candidate].answers === undefined) {
							currentQuestionIndex = candidate;
							break;
						}
					}
					refresh();
				};
				const multipleAnswers = (index: number): QuestionAnswer[] => [
					...questions[index].options
						.map((option, optionIndex) => ({ option, optionIndex }))
						.filter(({ optionIndex }) => states[index].selected.has(optionIndex))
						.map(({ option }) => ({ value: option.value, label: option.label, wasCustom: false })),
					...states[index].customAnswers,
				];
				const syncEditorFocus = () => {
					for (const [index, editor] of editors.entries()) {
						editor.focused = componentFocused && index === currentQuestionIndex;
					}
				};
				const renderInput = (question: QuestionConfig, editor: Editor, width: number): string[] => {
					if (width <= 1) return [theme.fg("accent", "›")];
					const prefix = `${theme.fg("accent", "›")} `;
					const continuationPrefix = " ".repeat(visibleWidth(prefix));
					const inputWidth = Math.max(1, width - visibleWidth(prefix));
					if (!editor.getText()) {
						const placeholder =
							question.placeholder?.trim() ||
							(question.mode === "input" ? "Type your response..." : "Type a custom answer...");
						const visiblePlaceholder = truncateToWidth(placeholder, inputWidth, "");
						if (!visiblePlaceholder) return [prefix];
						const [firstCharacter, ...remainingCharacters] = [...visiblePlaceholder];
						const marker = editor.focused ? CURSOR_MARKER : "";
						const text = `${marker}\x1b[7m${firstCharacter}\x1b[27m${remainingCharacters.join("")}`;
						return [`${prefix}${theme.fg("dim", text)}`];
					}

					const borderedLines = editor.render(inputWidth);
					const inputLines = borderedLines.slice(1, -1).map((line) => ({ line, content: true }));
					const topBorder = borderedLines[0];
					const bottomBorder = borderedLines.at(-1);
					if (topBorder?.includes("↑")) inputLines.unshift({ line: topBorder, content: false });
					if (bottomBorder?.includes("↓")) inputLines.push({ line: bottomBorder, content: false });
					let showedPrompt = false;
					return inputLines.map(({ line, content }) => {
						if (content && !showedPrompt) {
							showedPrompt = true;
							return `${prefix}${line}`;
						}
						return `${continuationPrefix}${line}`;
					});
				};
				const switchQuestion = (direction: 1 | -1) => {
					currentQuestionIndex =
						(currentQuestionIndex + direction + questions.length) % questions.length;
					syncEditorFocus();
					refresh();
				};

				for (const [index, editor] of editors.entries()) {
					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (!trimmed) return;
						const answer = { value: trimmed, label: trimmed, wasCustom: true };
						const question = questions[index];
						const state = states[index];
						if (question.mode === "multiple") {
							state.customAnswers.push(answer);
							state.answers = undefined;
							state.inputMode = false;
							editor.setText("");
							refresh();
						} else {
							state.answers = [answer];
							advanceAfterAnswer();
						}
					};
				}

				const handleInput = (data: string) => {
					const matches = (
						binding:
							"tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
						fallback: string,
					) => keybindings.matches(data, binding) || matchesKey(data, fallback as any);
					if (questions.length > 1 && matchesKey(data, Key.tab)) {
						switchQuestion(1);
						return;
					}
					if (questions.length > 1 && matchesKey(data, Key.shift("tab"))) {
						switchQuestion(-1);
						return;
					}
					const question = questions[currentQuestionIndex];
					const state = states[currentQuestionIndex];
					const editor = editors[currentQuestionIndex];
					if (state.inputMode) {
						if (matches("tui.select.cancel", Key.escape)) {
							if (question.mode === "input") done(details(true));
							else {
								state.inputMode = false;
								editor.setText("");
								refresh();
							}
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}
					const currentItems = items(currentQuestionIndex);
					if (matches("tui.select.cancel", Key.escape)) {
						done(details(true));
						return;
					}
					if (matches("tui.select.up", Key.up))
						state.selectedIndex = Math.max(0, state.selectedIndex - 1);
					else if (matches("tui.select.down", Key.down)) {
						state.selectedIndex = Math.min(currentItems.length - 1, state.selectedIndex + 1);
					} else if (matchesKey(data, Key.space) && question.mode === "multiple") {
						const item = currentItems[state.selectedIndex];
						if (item?.kind === "option") {
							state.selected.has(item.optionIndex)
								? state.selected.delete(item.optionIndex)
								: state.selected.add(item.optionIndex);
							state.answers = undefined;
						}
					} else if (matches("tui.select.confirm", Key.enter)) {
						const item = currentItems[state.selectedIndex];
						if (!item) return;
						if (item.kind === "custom") {
							state.inputMode = true;
							editor.setText("");
						} else if (item.kind === "all") {
							const allSelected = question.options.every((_option, index) =>
								state.selected.has(index),
							);
							state.selected.clear();
							if (!allSelected)
								question.options.forEach((_option, index) => state.selected.add(index));
							state.answers = undefined;
						} else if (item.kind === "clear-custom") {
							state.customAnswers.length = 0;
							state.answers = undefined;
							state.selectedIndex = Math.max(0, state.selectedIndex - 1);
						} else if (item.kind === "submit") {
							state.answers = multipleAnswers(currentQuestionIndex);
							advanceAfterAnswer();
							return;
						} else if (question.mode === "multiple") {
							state.selected.has(item.optionIndex)
								? state.selected.delete(item.optionIndex)
								: state.selected.add(item.optionIndex);
							state.answers = undefined;
						} else {
							state.answers = [
								{ value: item.option.value, label: item.option.label, wasCustom: false },
							];
							advanceAfterAnswer();
							return;
						}
					}
					refresh();
				};

				const render = (width: number): string[] => {
					if (cachedLines && cachedWidth === width) return cachedLines;
					const renderWidth = Math.max(1, width);
					const lines: string[] = [];
					const question = questions[currentQuestionIndex];
					const state = states[currentQuestionIndex];
					const addWrappedWithPrefix = (prefix: string, text: string) => {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							lines.push(...wrapTextWithAnsi(prefix + text, renderWidth));
							return;
						}
						const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - prefixWidth));
						for (let index = 0; index < wrapped.length; index++) {
							lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`);
						}
					};
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					const tabs = questions.map((tabQuestion, index) => {
						const active = index === currentQuestionIndex;
						const answered = states[index].answers !== undefined;
						const marker = answered ? "●" : "○";
						const text = ` ${marker} ${tabQuestion.title} `;
						return active
							? theme.bg("selectedBg", theme.fg("text", text))
							: theme.fg(answered ? "success" : "muted", text);
					});
					addWrappedWithPrefix(" ", tabs.join(" "));
					lines.push("");
					addWrappedWithPrefix(
						" ",
						`${theme.fg("toolTitle", theme.bold("Q"))} ${theme.fg("text", question.question)}`,
					);
					lines.push("");
					if (state.inputMode) {
						for (const line of renderInput(
							question,
							editors[currentQuestionIndex],
							Math.max(1, renderWidth - 2),
						)) {
							lines.push(` ${line}`);
						}
						lines.push("");
						const inputHelp =
							question.mode === "input"
								? `${keyHint("tui.select.confirm", "answer")} · ${keyHint("tui.select.cancel", "cancel")}`
								: `${keyHint("tui.select.confirm", "add")} · ${keyHint("tui.select.cancel", "return")}`;
						addWrappedWithPrefix(
							" ",
							theme.fg(
								"dim",
								questions.length > 1 ? `Tab/Shift+Tab switch · ${inputHelp}` : inputHelp,
							),
						);
					} else {
						const currentItems = items(currentQuestionIndex);
						for (const [index, item] of currentItems.entries()) {
							const active = index === state.selectedIndex;
							const prefix = active ? theme.fg("accent", " > ") : "   ";
							let marker = "";
							let label: string;
							let description: string | undefined;
							if (item.kind === "option") {
								marker =
									question.mode === "multiple"
										? state.selected.has(item.optionIndex)
											? "[✓] "
											: "[ ] "
										: "";
								label = item.option.label;
								description = item.option.description;
							} else label = item.label;
							const styledLabel = theme.fg(
								active ? "accent" : item.kind === "submit" ? "success" : "text",
								`${marker}${label}`,
							);
							const recommendation =
								item.kind === "option" && item.option.recommended
									? announceColor(" (Recommended)")
									: "";
							const fullText = description
								? `${styledLabel}${recommendation} ${theme.fg("dim", "-")} ${theme.fg("muted", description)}`
								: `${styledLabel}${recommendation}`;
							addWrappedWithPrefix(prefix, fullText);
							if (index < currentItems.length - 1)
								lines.push(theme.fg("borderMuted", "  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄"));
						}
						if (state.customAnswers.length) {
							lines.push("", theme.fg("muted", "Custom answers:"));
							for (const answer of state.customAnswers)
								addWrappedWithPrefix("  ✓ ", theme.fg("text", answer.label));
						}
						lines.push("");
						const selectionHelp =
							question.mode === "multiple"
								? `${keyHint("tui.select.up", "navigate")} · Space/${keyHint("tui.select.confirm", "toggle")} · ${keyHint("tui.select.cancel", "cancel")}`
								: `${keyHint("tui.select.up", "navigate")} · ${keyHint("tui.select.confirm", "answer")} · ${keyHint("tui.select.cancel", "cancel")}`;
						addWrappedWithPrefix(
							" ",
							theme.fg(
								"dim",
								questions.length > 1 ? `Tab/Shift+Tab switch · ${selectionHelp}` : selectionHelp,
							),
						);
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					cachedWidth = width;
					cachedLines = lines;
					return lines;
				};

				const component: Component & Focusable = {
					get focused() {
						return componentFocused;
					},
					set focused(value: boolean) {
						componentFocused = value;
						syncEditorFocus();
					},
					render,
					handleInput,
					invalidate() {
						cachedWidth = undefined;
						cachedLines = undefined;
						for (const editor of editors) editor.invalidate();
					},
				};
				return component;
			});
			return { content: [{ type: "text", text: resultContent(result) }], details: result };
		},

		renderCall(args, theme, context) {
			if (!shouldRevealToolDetails(context)) {
				return emptyCollapsedToolRender();
			}
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const prefix = theme.fg("toolTitle", theme.bold("Q"));
			const body =
				questions.length === 0 && typeof (args as any).question === "string"
					? theme.fg("muted", (args as any).question)
					: questions.length === 1
						? theme.fg("muted", questions[0]?.question ?? "")
						: theme.fg(
								"muted",
								`${questions.length} questions: ${questions.map((q) => q.title).join(", ")}`,
							);
			return new Text(`${prefix} ${body}`, 1, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as QuestionDetails | undefined;
			if (context.isError) {
				const message =
					result.content.find((part) => part.type === "text")?.text ?? "Question tool failed";
				return new Text(theme.fg("error", message), 1, 0);
			}
			if (!details) return new Container();
			if (details.cancelled) return new Text(theme.fg("warning", "Question cancelled"), 1, 0);
			const answers = details.questions.flatMap((question) =>
				question.answers.map((answer) => ({ question, answer })),
			);
			if (!expanded) {
				const summary =
					answers.length === 1
						? `${answers[0]!.question.title}: ${answers[0]!.answer.label}`
						: `${answers.length} responses`;
				return new Text(
					theme.fg("toolTitle", theme.bold("Answered")) + theme.fg("muted", ` · ${summary}`),
					1,
					0,
				);
			}
			const prefix = theme.fg("toolTitle", theme.bold("A"));
			const lines = answers.map(
				({ question, answer }) =>
					`${prefix} ${theme.fg("muted", `${question.title}: ${answer.wasCustom ? "(wrote) " : ""}${answer.label}`)}`,
			);
			return new Text(lines.join("\n"), 1, 0);
		},
	});
}
