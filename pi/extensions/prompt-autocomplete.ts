import type { UserMessage } from "@earendil-works/pi-ai/compat";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	truncateToWidth,
	visibleWidth,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type EditorComponent,
} from "@earendil-works/pi-tui";

import { completeDirectRequest, type DirectCompleteFunction } from "./lib/direct-completion.ts";
import {
	resolvePreferredUtilityModel,
	type ModelPreferenceChoice,
	type ModelPreferenceResolution,
	type ModelPreferenceStore,
} from "./model-preference.ts";

export const MAX_COMPLETION_OUTPUT_TOKENS = 64;
export const MAX_COMPLETION_CHARS = 240;
export const MAX_COMPLETION_CONTEXT_CHARS = 1_200;
export const IDLE_SUGGESTION_DELAY_MS = 450;
export const MIN_IDLE_SUGGESTION_CHARS = 8;

export const PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT = `Predict the immediate continuation of an unfinished coding-agent prompt.
Return only the shortest natural suffix, usually one to eight words.
Do not answer the prompt, explain anything, or repeat text already present before or after the cursor.
Return plain text only. Do not use quotes or code fences.

Example:
Text before cursor: What should we work
Suffix: on next`;

export type PromptAutocompleteContext = Pick<
	ExtensionContext,
	"model" | "modelRegistry" | "thinkingLevel"
>;

export interface PromptAutocompleteDependencies {
	complete?: DirectCompleteFunction;
	store?: ModelPreferenceStore;
	resolveUtilityModel?: typeof resolvePreferredUtilityModel;
	consumeIdleRequest?: (
		lines: readonly string[],
		cursorLine: number,
		cursorCol: number,
	) => AbortSignal | undefined;
	onIdleSuggestion?: (
		lines: readonly string[],
		cursorLine: number,
		cursorCol: number,
		value: string,
	) => void;
}

export interface PromptCursorDraft {
	beforeCursor: string;
	afterCursor: string;
}

export interface PromptCursorPosition {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

export interface IdleRequestMarker {
	mark(lines: readonly string[], cursorLine: number, cursorCol: number): void;
	consume(lines: readonly string[], cursorLine: number, cursorCol: number): AbortSignal | undefined;
	clear(): void;
}

export interface GhostTextState {
	set(lines: readonly string[], cursorLine: number, cursorCol: number, value: string): void;
	get(lines: readonly string[], cursorLine: number, cursorCol: number): string | undefined;
	clear(): void;
}

interface TriggerableEditor extends EditorComponent {
	focused?: boolean;
	getLines?: () => string[];
	getCursor?: () => { line: number; col: number };
	isShowingAutocomplete?: () => boolean;
}

const idleEditorDisposers = new WeakMap<EditorComponent, () => void>();
const END_CURSOR = "\x1b[7m \x1b[0m";

function idleRequestKey(lines: readonly string[], cursorLine: number, cursorCol: number): string {
	return JSON.stringify([lines, cursorLine, cursorCol]);
}

export function createGhostTextState(): GhostTextState {
	let suggestion: { key: string; value: string } | undefined;
	return {
		set(lines, cursorLine, cursorCol, value) {
			suggestion = { key: idleRequestKey(lines, cursorLine, cursorCol), value };
		},
		get(lines, cursorLine, cursorCol) {
			return suggestion?.key === idleRequestKey(lines, cursorLine, cursorCol)
				? suggestion.value
				: undefined;
		},
		clear() {
			suggestion = undefined;
		},
	};
}

export function renderGhostTextLine(
	line: string,
	width: number,
	value: string,
	styleGhost: (text: string) => string,
): string {
	const markerIndex = line.indexOf(CURSOR_MARKER);
	if (markerIndex < 0) return line;
	const cursorIndex = markerIndex + CURSOR_MARKER.length;
	if (!line.startsWith(END_CURSOR, cursorIndex)) return line;

	const availableWidth = Math.max(0, width - visibleWidth(line.slice(0, markerIndex)));
	const visibleValue = truncateToWidth(value, availableWidth, "");
	const characters = Array.from(visibleValue);
	const first = characters.shift();
	if (!first) return line;
	const ghost = styleGhost(`\x1b[7m${first}\x1b[27m${characters.join("")}`);
	const rendered = line.slice(0, cursorIndex) + ghost + line.slice(cursorIndex + END_CURSOR.length);
	return truncateToWidth(rendered, width, "");
}

export function createIdleRequestMarker(): IdleRequestMarker {
	let pending: { key: string; controller: AbortController } | undefined;
	let active: AbortController | undefined;
	const abortAll = (): void => {
		pending?.controller.abort();
		active?.abort();
		pending = undefined;
		active = undefined;
	};
	return {
		mark(lines, cursorLine, cursorCol) {
			abortAll();
			pending = {
				key: idleRequestKey(lines, cursorLine, cursorCol),
				controller: new AbortController(),
			};
		},
		consume(lines, cursorLine, cursorCol) {
			const key = idleRequestKey(lines, cursorLine, cursorCol);
			if (pending?.key !== key) return undefined;
			active = pending.controller;
			pending = undefined;
			return active.signal;
		},
		clear: abortAll,
	};
}

function cursorPosition(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
): { line: number; col: number; text: string } {
	const line = Math.max(0, Math.min(cursorLine, Math.max(lines.length - 1, 0)));
	const text = lines[line] ?? "";
	return {
		line,
		col: Math.max(0, Math.min(cursorCol, text.length)),
		text,
	};
}

export function splitPromptAtCursor(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
): PromptCursorDraft {
	const position = cursorPosition(lines, cursorLine, cursorCol);
	const beforeLines = [...lines.slice(0, position.line), position.text.slice(0, position.col)];
	const afterLines = [position.text.slice(position.col), ...lines.slice(position.line + 1)];
	return {
		beforeCursor: beforeLines.join("\n"),
		afterCursor: afterLines.join("\n"),
	};
}

export function isSlashCommandInput(textBeforeCursor: string): boolean {
	return /^\s*\//u.test(textBeforeCursor);
}

export function isBuiltInCompletionInput(textBeforeCursor: string): boolean {
	return (
		isSlashCommandInput(textBeforeCursor) ||
		/(?:^|\s)[@#][^\s]*$/u.test(textBeforeCursor) ||
		/(?:^|\s)\S*\/\S*$/u.test(textBeforeCursor)
	);
}

export function isPromptCompletionEligible(
	textBeforeCursor: string,
	requested: boolean | undefined,
	signal?: AbortSignal,
): boolean {
	return (
		requested === true &&
		!signal?.aborted &&
		textBeforeCursor.trim().length > 0 &&
		!isBuiltInCompletionInput(textBeforeCursor)
	);
}

export function enableIdlePromptSuggestions(
	editor: EditorComponent,
	keybindings: Pick<KeybindingsManager, "matches">,
	marker: IdleRequestMarker,
	ghostText: GhostTextState,
	styleGhost: (text: string) => string,
	delayMs = IDLE_SUGGESTION_DELAY_MS,
): () => void {
	const existing = idleEditorDisposers.get(editor);
	if (existing) return existing;

	const triggerable = editor as TriggerableEditor;
	const trigger = (
		editor as unknown as { tryTriggerAutocomplete?: (explicitTab?: boolean) => void }
	).tryTriggerAutocomplete;
	if (!triggerable.getLines || !triggerable.getCursor || !trigger || !editor.insertTextAtCursor) {
		return () => undefined;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const originalHandleInput = editor.handleInput.bind(editor);
	const originalRender = editor.render.bind(editor);
	const originalSetText = editor.setText.bind(editor);
	const originalInsertTextAtCursor = editor.insertTextAtCursor.bind(editor);
	const clearTimer = (): void => {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
	};

	const focusedDescriptor = Object.getOwnPropertyDescriptor(editor, "focused");
	let focusedValue = triggerable.focused;
	const focusPatched = Boolean(focusedDescriptor?.configurable && "value" in focusedDescriptor);
	if (focusPatched) {
		Object.defineProperty(editor, "focused", {
			configurable: true,
			enumerable: focusedDescriptor?.enumerable ?? true,
			get: () => focusedValue,
			set: (value: boolean) => {
				focusedValue = value;
				if (value) return;
				clearTimer();
				marker.clear();
				ghostText.clear();
			},
		});
	}

	const patchedHandleInput = (data: string): void => {
		const linesBefore = triggerable.getLines?.() ?? [];
		const cursorBefore = triggerable.getCursor?.() ?? { line: 0, col: 0 };
		const ghost = ghostText.get(linesBefore, cursorBefore.line, cursorBefore.col);
		if (ghost && keybindings.matches(data, "tui.editor.cursorRight")) {
			clearTimer();
			marker.clear();
			ghostText.clear();
			editor.insertTextAtCursor?.(ghost);
			return;
		}

		clearTimer();
		marker.clear();
		ghostText.clear();
		const before = editor.getText();
		const wasShowingAutocomplete = triggerable.isShowingAutocomplete?.() ?? false;
		const acceptedSuggestion =
			wasShowingAutocomplete &&
			(keybindings.matches(data, "tui.input.tab") ||
				keybindings.matches(data, "tui.select.confirm"));

		originalHandleInput(data);
		const after = editor.getText();
		if (after === before) return;

		if (acceptedSuggestion || after.trim().length < MIN_IDLE_SUGGESTION_CHARS) return;

		timer = setTimeout(
			() => {
				timer = undefined;
				if (triggerable.focused === false) return;
				const lines = triggerable.getLines?.();
				const cursor = triggerable.getCursor?.();
				if (!lines || !cursor) return;
				if (triggerable.isShowingAutocomplete?.()) return;
				const draft = splitPromptAtCursor(lines, cursor.line, cursor.col);
				if (
					draft.beforeCursor.trim().length < MIN_IDLE_SUGGESTION_CHARS ||
					draft.afterCursor.length > 0 ||
					isBuiltInCompletionInput(draft.beforeCursor)
				) {
					return;
				}
				marker.mark(lines, cursor.line, cursor.col);
				try {
					trigger.call(editor, false);
				} catch {
					marker.clear();
				}
			},
			Math.max(0, delayMs),
		);
	};

	const clearTransientSuggestion = (): void => {
		clearTimer();
		marker.clear();
		ghostText.clear();
	};
	const patchedSetText = (value: string): void => {
		clearTransientSuggestion();
		originalSetText(value);
	};
	const patchedInsertTextAtCursor = (value: string): void => {
		clearTransientSuggestion();
		originalInsertTextAtCursor(value);
	};

	const patchedRender = (width: number): string[] => {
		const rendered = originalRender(width);
		const lines = triggerable.getLines?.();
		const cursor = triggerable.getCursor?.();
		if (!lines || !cursor) return rendered;
		const ghost = ghostText.get(lines, cursor.line, cursor.col);
		if (!ghost) return rendered;
		const markerLine = rendered.findIndex((line) => line.includes(CURSOR_MARKER));
		if (markerLine < 0) return rendered;
		const next = [...rendered];
		next[markerLine] = renderGhostTextLine(next[markerLine]!, width, ghost, styleGhost);
		return next;
	};

	editor.handleInput = patchedHandleInput;
	editor.render = patchedRender;
	editor.setText = patchedSetText;
	editor.insertTextAtCursor = patchedInsertTextAtCursor;
	const dispose = (): void => {
		clearTimer();
		marker.clear();
		ghostText.clear();
		if (editor.handleInput === patchedHandleInput) editor.handleInput = originalHandleInput;
		if (editor.render === patchedRender) editor.render = originalRender;
		if (editor.setText === patchedSetText) editor.setText = originalSetText;
		if (editor.insertTextAtCursor === patchedInsertTextAtCursor) {
			editor.insertTextAtCursor = originalInsertTextAtCursor;
		}
		if (focusPatched && focusedDescriptor) {
			Object.defineProperty(editor, "focused", { ...focusedDescriptor, value: focusedValue });
		}
		idleEditorDisposers.delete(editor);
	};
	idleEditorDisposers.set(editor, dispose);
	return dispose;
}

function boundedText(text: string, limit: number, marker: string, keep: "start" | "end"): string {
	if (text.length <= limit) return text;
	const contentLimit = Math.max(0, limit - marker.length - 1);
	return keep === "start"
		? `${text.slice(0, contentLimit)}\n${marker}`
		: `${marker}\n${text.slice(-contentLimit)}`;
}

export function buildPromptCompletionText(draft: PromptCursorDraft): string {
	return [
		"<text_before_cursor>",
		boundedText(
			draft.beforeCursor,
			MAX_COMPLETION_CONTEXT_CHARS,
			"[earlier prompt text omitted]",
			"end",
		),
		"</text_before_cursor>",
		"<text_after_cursor>",
		boundedText(
			draft.afterCursor,
			MAX_COMPLETION_CONTEXT_CHARS,
			"[later prompt text omitted]",
			"start",
		),
		"</text_after_cursor>",
	].join("\n");
}

export function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function removeWrapping(text: string): string {
	let value = text.trim();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const fence = value.match(/^(```|~~~)[^\r\n]*(?:\r?\n)([\s\S]*?)\r?\n?\1$/u);
		if (fence) {
			value = fence[2]?.trim() ?? "";
			continue;
		}
		const first = value[0];
		if (
			value.length >= 2 &&
			(first === '"' || first === "'" || first === "`") &&
			value.at(-1) === first
		) {
			value = value.slice(1, -1).trim();
			continue;
		}
		break;
	}
	return value;
}

function canonicalText(text: string): string {
	return text.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function isWordCharacter(character: string | undefined): boolean {
	return Boolean(character && /^[\p{L}\p{N}_$]$/u.test(character));
}

function isClosingBoundary(character: string | undefined): boolean {
	return Boolean(character && ".,!?;:)]}'\"`".includes(character));
}

function isOpeningBoundary(character: string | undefined): boolean {
	return Boolean(character && "([{/'\"`@#$\\".includes(character));
}

function needsLeadingSpace(before: string, after: string, value: string): boolean {
	if (!before || /\s$/u.test(before)) return false;
	const previous = before.at(-1);
	const first = value[0];
	if (!isWordCharacter(first) || isOpeningBoundary(previous)) return false;
	if (after && isWordCharacter(previous) && isWordCharacter(after[0])) return false;
	return !isClosingBoundary(first);
}

function needsTrailingSpace(before: string, after: string, value: string): boolean {
	if (!after || /^\s/u.test(after)) return false;
	const next = after[0];
	const last = value.at(-1);
	if (!isWordCharacter(last) || isClosingBoundary(next)) return false;
	if (before && isWordCharacter(before.at(-1)) && isWordCharacter(next)) return false;
	return true;
}

export function normalizePromptCompletion(
	output: unknown,
	draftBeforeCursor = "",
	draftAfterCursor = "",
): string | undefined {
	if (typeof output !== "string") return undefined;
	const compact = removeWrapping(output)
		.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (!compact) return undefined;

	const normalizedDraft = canonicalText(`${draftBeforeCursor}${draftAfterCursor}`);
	const normalizedBefore = canonicalText(draftBeforeCursor);
	const normalizedAfter = canonicalText(draftAfterCursor);
	const normalizedOutput = canonicalText(compact);
	if (
		(normalizedBefore && normalizedOutput === normalizedBefore) ||
		(normalizedAfter && normalizedOutput === normalizedAfter) ||
		(normalizedDraft && normalizedOutput === normalizedDraft)
	) {
		return undefined;
	}

	let value = compact.slice(0, MAX_COMPLETION_CHARS).trimEnd();
	if (!value) return undefined;
	if (needsLeadingSpace(draftBeforeCursor, draftAfterCursor, value)) value = ` ${value}`;
	if (
		value.length < MAX_COMPLETION_CHARS &&
		needsTrailingSpace(draftBeforeCursor, draftAfterCursor, value)
	) {
		value = `${value} `;
	}
	return value.slice(0, MAX_COMPLETION_CHARS) || undefined;
}

export function insertTextAtCursor(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
	text: string,
): PromptCursorPosition {
	const position = cursorPosition(lines, cursorLine, cursorCol);
	const nextLines = [...lines];
	nextLines[position.line] =
		position.text.slice(0, position.col) + text + position.text.slice(position.col);
	return {
		lines: nextLines,
		cursorLine: position.line,
		cursorCol: position.col + text.length,
	};
}

function distinctChoices(resolution: ModelPreferenceResolution): ModelPreferenceChoice[] {
	const choices: ModelPreferenceChoice[] = [];
	for (const choice of [resolution.preferred, resolution.fallback]) {
		if (!choice) continue;
		if (
			choices.some(
				(existing) =>
					existing.model.provider === choice.model.provider &&
					existing.model.id === choice.model.id,
			)
		) {
			continue;
		}
		choices.push(choice);
	}
	return choices;
}

function isCancellationError(error: unknown, signal: AbortSignal): boolean {
	return (
		signal.aborted ||
		(error instanceof Error && (error.name === "AbortError" || error.message === "Cancelled"))
	);
}

function resolveContext(
	source: PromptAutocompleteContext | (() => PromptAutocompleteContext | undefined),
): PromptAutocompleteContext | undefined {
	try {
		return typeof source === "function" ? source() : source;
	} catch {
		return undefined;
	}
}

function hasSuggestions(
	suggestions: AutocompleteSuggestions | null,
): suggestions is AutocompleteSuggestions {
	return Boolean(suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0);
}

export function createPromptAutocompleteProvider(
	current: AutocompleteProvider,
	context: PromptAutocompleteContext | (() => PromptAutocompleteContext | undefined),
	dependencies: PromptAutocompleteDependencies = {},
): AutocompleteProvider {
	let latestRequestId = 0;

	return {
		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const requestId = ++latestRequestId;
			const requestLines = [...lines];
			let idleSignal: AbortSignal | undefined;
			try {
				idleSignal = dependencies.consumeIdleRequest?.(requestLines, cursorLine, cursorCol);
			} catch {
				idleSignal = undefined;
			}
			const requestSignal = idleSignal
				? AbortSignal.any([options.signal, idleSignal])
				: options.signal;
			if (!idleSignal) {
				let currentSuggestions: AutocompleteSuggestions | null;
				try {
					currentSuggestions = await current.getSuggestions(requestLines, cursorLine, cursorCol, {
						...options,
						signal: requestSignal,
					});
				} catch {
					return null;
				}
				if (hasSuggestions(currentSuggestions)) return currentSuggestions;
			}

			const draft = splitPromptAtCursor(requestLines, cursorLine, cursorCol);
			if (
				!isPromptCompletionEligible(draft.beforeCursor, idleSignal !== undefined, requestSignal)
			) {
				return null;
			}
			if (requestId !== latestRequestId) return null;

			const requestContext = resolveContext(context);
			if (!requestContext) return null;

			let resolution: ModelPreferenceResolution;
			try {
				const resolveUtilityModel =
					dependencies.resolveUtilityModel ?? resolvePreferredUtilityModel;
				resolution = resolveUtilityModel(requestContext, dependencies.store);
			} catch {
				return null;
			}

			const choices = distinctChoices(resolution);
			if (choices.length === 0) return null;

			const message: UserMessage = {
				role: "user",
				content: [{ type: "text", text: buildPromptCompletionText(draft) }],
				timestamp: Date.now(),
			};

			for (const choice of choices) {
				if (requestId !== latestRequestId || requestSignal.aborted) return null;
				try {
					const requestOptions = {
						maxTokens: MAX_COMPLETION_OUTPUT_TOKENS,
						signal: requestSignal,
						...(choice.thinkingLevel === "off" ? {} : { reasoning: choice.thinkingLevel }),
					};
					const response = await completeDirectRequest(
						requestContext.modelRegistry,
						choice.model,
						{
							systemPrompt: PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT,
							messages: [message],
						},
						requestOptions,
						dependencies.complete,
					);
					if (requestId !== latestRequestId || requestSignal.aborted) return null;
					if (response.stopReason === "aborted") return null;
					if (response.stopReason === "error") {
						throw new Error(response.errorMessage ?? "Prompt completion failed");
					}
					const value = normalizePromptCompletion(
						extractTextContent(response.content),
						draft.beforeCursor,
						draft.afterCursor,
					);
					if (!value) throw new Error("Prompt completion returned no usable text");

					dependencies.onIdleSuggestion?.(requestLines, cursorLine, cursorCol, value);
					return null;
				} catch (error) {
					if (isCancellationError(error, requestSignal)) return null;
				}
			}
			return null;
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function promptAutocompleteExtension(
	pi: ExtensionAPI,
	dependencies: PromptAutocompleteDependencies = {},
): void {
	let activeContext: PromptAutocompleteContext | undefined;
	let registered = false;
	const idleRequests = createIdleRequestMarker();
	const ghostText = createGhostTextState();
	const editorDisposers = new Set<() => void>();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			activeContext = undefined;
			return;
		}
		activeContext = ctx;
		if (registered) return;
		registered = true;

		ctx.ui.addAutocompleteProvider((current) =>
			createPromptAutocompleteProvider(current, () => activeContext, {
				...dependencies,
				consumeIdleRequest: (lines, cursorLine, cursorCol) =>
					idleRequests.consume(lines, cursorLine, cursorCol) ??
					dependencies.consumeIdleRequest?.(lines, cursorLine, cursorCol),
				onIdleSuggestion: (lines, cursorLine, cursorCol, value) => {
					ghostText.set(lines, cursorLine, cursorCol, value);
					dependencies.onIdleSuggestion?.(lines, cursorLine, cursorCol, value);
				},
			}),
		);

		const previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor =
				previousEditor?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const dispose = enableIdlePromptSuggestions(
				editor,
				keybindings,
				idleRequests,
				ghostText,
				(text) => ctx.ui.theme.fg("dim", text),
			);
			editorDisposers.add(dispose);
			return editor;
		});
	});

	pi.on("session_shutdown", () => {
		activeContext = undefined;
		idleRequests.clear();
		ghostText.clear();
		for (const dispose of editorDisposers) dispose();
		editorDisposers.clear();
	});
}
