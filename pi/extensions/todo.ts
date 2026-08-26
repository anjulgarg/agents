/**
 * Todo Extension - a standalone, persistent task list for the parent agent.
 *
 * The list is intentionally independent from other extensions. It owns its
 * lifecycle, session snapshots, prompt reminders, and TUI presentation.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	BOTTOM_PANEL_SECTION_ORDER,
	ExpandableToolRender,
	emptyCollapsedToolRender,
	fullscreenOverlayOptions,
	getBottomPanel,
	getContentWidth,
	renderFullscreenScreen,
	type BottomPanel,
	type BottomPanelSectionHandle,
	ScrollViewportState,
	shouldRevealToolDetails,
} from "./lib/tui/index.ts";
import { Type } from "typebox";

export const TODO_STATUSES = ["open", "in_progress", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

interface TodoSnapshot {
	todos: Todo[];
	nextId: number;
}

type TodoAction =
	| "list"
	| "add"
	| "edit"
	| "move"
	| "remove"
	| "start"
	| "complete"
	| "reopen"
	| "replace"
	| "update";

interface TodoDetails {
	action: TodoAction;
	todos: Todo[];
	nextId: number;
	error?: string;
}

interface TodoStatusUpdate {
	id: number;
	status: TodoStatus;
}

const TODO_RECONCILIATION_TYPE = "todo-reconciliation";
const TODO_RECONCILIATION_GUIDANCE = [
	"[INTERNAL TODO RECONCILIATION EVENT, NOT USER INPUT]",
	"Reconcile the open todo queue against verified work and continue autonomously.",
	"Use atomic status updates when several items are known; ask only for material user input.",
	"Do not narrate routine todo management to the user.",
].join("\n");
const TODO_CONTEXT_TYPE = "todo-context";
const TODO_CONTEXT_MAX_ITEMS = 32;
const TODO_CONTEXT_MAX_CHARS = 8_000;
const EMPTY_TODO_CONTEXT_STATE = "[]";

const TodoParams = Type.Object({
	action: StringEnum([
		"list",
		"add",
		"edit",
		"move",
		"remove",
		"start",
		"complete",
		"reopen",
		"replace",
		"update",
	] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add or edit)" })),
	items: Type.Optional(
		Type.Array(Type.String(), { description: "Todo texts (for add or replace)" }),
	),
	updates: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Integer({ minimum: 1, description: "Todo ID to update" }),
				status: StringEnum(["open", "in_progress", "done"] as const),
			}),
			{
				minItems: 1,
				maxItems: 64,
				description: "Atomic todo status updates; IDs must be unique",
			},
		),
	),
	id: Type.Optional(
		Type.Integer({ minimum: 1, description: "Todo ID for an item-specific action" }),
	),
	position: Type.Optional(
		Type.Integer({ minimum: 1, description: "One-based destination for move" }),
	),
});

export function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && TODO_STATUSES.includes(value as TodoStatus);
}

/** Normalize persisted or tool-facing todo records, including legacy done booleans. */
export function normalizeTodo(raw: unknown): Todo | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const entry = raw as { id?: unknown; text?: unknown; status?: unknown; done?: unknown };
	if (typeof entry.id !== "number" || !Number.isInteger(entry.id) || entry.id < 1) return undefined;
	if (typeof entry.text !== "string") return undefined;
	let status: TodoStatus;
	if (isTodoStatus(entry.status)) status = entry.status;
	else if (entry.done === true) status = "done";
	else if (entry.done === false || entry.done === undefined) status = "open";
	else return undefined;
	return { id: entry.id, text: entry.text, status };
}

export function isActiveTodo(todo: Todo): boolean {
	return todo.status === "open" || todo.status === "in_progress";
}

export function cycleTodoStatus(status: TodoStatus): TodoStatus {
	if (status === "open") return "in_progress";
	if (status === "in_progress") return "done";
	return "open";
}

export function todoStatusGlyph(status: TodoStatus): string {
	if (status === "done") return "✓";
	if (status === "in_progress") return "◐";
	return "○";
}

export function todoStatusMarker(status: TodoStatus): string {
	if (status === "done") return "x";
	if (status === "in_progress") return "~";
	return " ";
}

function colorTodoGlyph(theme: Theme, status: TodoStatus): string {
	const glyph = todoStatusGlyph(status);
	if (status === "done") return theme.fg("success", glyph);
	if (status === "in_progress") return theme.fg("warning", glyph);
	return theme.fg("dim", glyph);
}

function formatTodoLine(todo: Todo): string {
	return `[${todoStatusMarker(todo.status)}] #${todo.id}: ${todo.text}`;
}

function todoIdWidth(todos: readonly Todo[]): number {
	return todos.reduce((width, todo) => Math.max(width, `#${todo.id}`.length), 0);
}

function formatTodoId(id: number, width: number): string {
	return `#${id}`.padEnd(width);
}

function formatActiveChecklist(todos: Todo[]): string {
	return todos
		.filter(isActiveTodo)
		.map((todo) =>
			todo.status === "in_progress"
				? `- #${todo.id} [in progress]: ${todo.text}`
				: `- #${todo.id}: ${todo.text}`,
		)
		.join("\n");
}

function formatBoundedActiveChecklist(todos: Todo[]): string {
	const active = todos.filter(isActiveTodo);
	if (active.length === 0) return "(none)";

	const lines: string[] = [];
	let characters = 0;
	for (const todo of active.slice(0, TODO_CONTEXT_MAX_ITEMS)) {
		const fullLine =
			todo.status === "in_progress"
				? `- #${todo.id} [in progress]: ${todo.text}`
				: `- #${todo.id}: ${todo.text}`;
		const separator = lines.length > 0 ? 1 : 0;
		const available = TODO_CONTEXT_MAX_CHARS - characters - separator;
		if (available <= 0) break;
		const line =
			fullLine.length <= available ? fullLine : `${fullLine.slice(0, Math.max(0, available - 1))}…`;
		lines.push(line);
		characters += separator + line.length;
		if (line !== fullLine) break;
	}

	const omitted = active.length - lines.length;
	if (omitted === 0) return lines.join("\n");

	const omission = `[${omitted} more active todo${omitted === 1 ? "" : "s"} omitted from bounded queue]`;
	const base = lines.join("\n");
	const availableBase = TODO_CONTEXT_MAX_CHARS - omission.length - (base ? 1 : 0);
	const boundedBase = base.slice(0, Math.max(0, availableBase)).trimEnd();
	return [boundedBase, omission].filter(Boolean).join("\n") || omission;
}

export interface TodoListAction {
	type: "edit" | "remove";
	id: number;
}

/** UI component for the /todos command. */
export class TodoListComponent {
	private selected = 0;
	private readonly scroll = new ScrollViewportState();
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines?: string[];

	constructor(
		private todos: Todo[],
		private readonly theme: Theme,
		private readonly onClose: () => void,
		private readonly tui?: TUI,
		private readonly onChange?: (todos: Todo[]) => void,
		private readonly onAction?: (action: TodoListAction) => void,
		initialSelectedId?: number,
	) {
		if (initialSelectedId !== undefined) {
			const index = todos.findIndex((todo) => todo.id === initialSelectedId);
			if (index >= 0) this.selected = index;
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
			return;
		}
		const count = this.todos.length;
		const selectedTodo = this.todos[this.selected];
		if (selectedTodo && data.toLowerCase() === "e") {
			this.onAction?.({ type: "edit", id: selectedTodo.id });
			return;
		}
		if (selectedTodo && matchesKey(data, "delete")) {
			this.onAction?.({ type: "remove", id: selectedTodo.id });
			return;
		}
		if (selectedTodo && (matchesKey(data, "shift+up") || matchesKey(data, "shift+down"))) {
			const delta = matchesKey(data, "shift+up") ? -1 : 1;
			const destination = this.selected + delta;
			if (destination < 0 || destination >= count) return;
			const [moved] = this.todos.splice(this.selected, 1);
			this.todos.splice(destination, 0, moved!);
			this.selected = destination;
			this.onChange?.(this.todos.map((item) => ({ ...item })));
			this.invalidate();
			this.tui?.requestRender();
			return;
		}
		if (selectedTodo && (data === " " || matchesKey(data, "enter"))) {
			selectedTodo.status = cycleTodoStatus(selectedTodo.status);
			this.onChange?.(this.todos.map((item) => ({ ...item })));
			this.invalidate();
			this.tui?.requestRender();
			return;
		}
		const previousSelected = this.selected;
		const previousOffset = this.scroll.offset;
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down"))
			this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
		else if (matchesKey(data, "pageUp"))
			this.selected = Math.max(0, this.selected - Math.max(1, this.scroll.pageSize));
		else if (matchesKey(data, "pageDown")) {
			this.selected = Math.min(
				Math.max(0, count - 1),
				this.selected + Math.max(1, this.scroll.pageSize),
			);
		} else if (matchesKey(data, "home")) this.selected = 0;
		else if (matchesKey(data, "end")) this.selected = Math.max(0, count - 1);
		else return;
		if (this.selected !== previousSelected || this.scroll.offset !== previousOffset) {
			this.invalidate();
			this.tui?.requestRender();
		}
	}

	private renderBody(width: number): { lines: string[]; starts: number[] } {
		const w = Math.max(0, width);
		const th = this.theme;
		if (this.todos.length === 0) {
			return {
				lines: [
					truncateToWidth(th.fg("dim", "No todos yet."), w),
					truncateToWidth(th.fg("muted", "Ask the agent to add a task."), w),
				],
				starts: [],
			};
		}

		const lines: string[] = [];
		const starts: number[] = [];
		const idWidth = todoIdWidth(this.todos);
		for (const [index, todo] of this.todos.entries()) {
			starts.push(lines.length);
			const selected = index === this.selected;
			const marker = selected ? th.fg("accent", "❯") : " ";
			const check = colorTodoGlyph(th, todo.status);
			const id = th.fg("accent", formatTodoId(todo.id, idWidth));
			const prefix = `${marker} ${check} ${id} `;
			const text =
				todo.status === "done"
					? th.fg("dim", th.strikethrough(todo.text))
					: todo.status === "in_progress"
						? th.fg("warning", todo.text)
						: th.fg("text", todo.text);
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= w) {
				lines.push(...wrapTextWithAnsi(`${prefix}${text}`, Math.max(1, w)));
				continue;
			}
			const wrapped = wrapTextWithAnsi(text, Math.max(1, w - prefixWidth));
			for (const [lineIndex, line] of wrapped.entries()) {
				lines.push(`${lineIndex === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
			}
		}
		return { lines, starts };
	}

	render(width: number): string[] {
		const height = this.tui ? Math.max(0, Math.floor(this.tui.terminal.rows)) : 0;
		if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height)
			return this.cachedLines;

		const bodyHeight = height > 0 ? Math.max(0, height - 2 - 3) : 1_000;
		const { lines, starts } = this.renderBody(getContentWidth(width));
		this.selected = this.todos.length === 0 ? 0 : Math.min(this.selected, this.todos.length - 1);
		this.scroll.update(lines.length, bodyHeight);
		if (starts[this.selected] !== undefined) this.scroll.reveal(starts[this.selected]);
		const range = this.scroll.range;
		const visibleBody = lines.slice(range.start, range.end);
		const done = this.todos.filter((todo) => todo.status === "done").length;
		const inProgress = this.todos.filter((todo) => todo.status === "in_progress").length;
		const subtitle =
			this.todos.length === 0
				? "empty"
				: inProgress > 0
					? `${done}/${this.todos.length} completed · ${inProgress} in progress`
					: `${done}/${this.todos.length} completed`;
		const compactHints = height > 0 && height < 10;
		const rendered = renderFullscreenScreen({
			width,
			height: height > 0 ? height : visibleBody.length + 5,
			title: "Todos",
			subtitle,
			body: visibleBody,
			keyHints: compactHints
				? [
						{ key: "↑↓", label: "select" },
						{ key: "Space", label: "status" },
						{ key: "Esc", label: "close" },
					]
				: [
						{ key: "↑↓", label: "select" },
						{ key: "Space", label: "status" },
						{ key: "Shift+↑↓", label: "move" },
						{ key: "E", label: "edit" },
						{ key: "Del", label: "remove" },
						{ key: "Esc", label: "close" },
					],
			theme: this.theme,
			footerPadding: 1,
		});
		this.cachedWidth = width;
		this.cachedHeight = height > 0 ? height : rendered.length;
		this.cachedLines = rendered;
		return rendered;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
	}
}

export default function todoExtension(pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;
	let currentCtx: ExtensionContext | undefined;
	let todoPanel: BottomPanel | undefined;
	let todoSection: BottomPanelSectionHandle | undefined;
	let reconciliationQueued = false;
	let reconciliationTurn = false;
	let parentTurnAborted = false;
	let settlementHandled = false;
	let lastTodoContextState: string | undefined;

	const cloneTodos = (items: Todo[]): Todo[] => items.map((todo) => ({ ...todo }));
	const stateDetails = (action: TodoDetails["action"], error?: string): TodoDetails => ({
		action,
		todos: cloneTodos(todos),
		nextId,
		...(error ? { error } : {}),
	});
	const toolResult = (action: TodoDetails["action"], text: string, error?: string) => ({
		content: [{ type: "text" as const, text }],
		details: stateDetails(action, error),
	});
	const activeTodoReceipt = (): string => {
		const active = todos.find((todo) => todo.status === "in_progress");
		return active ? `; active #${active.id}` : "";
	};
	const todoContextState = (): string =>
		JSON.stringify(todos.filter(isActiveTodo).map((todo) => [todo.id, todo.text, todo.status]));
	const todoContextMessage = () => ({
		customType: TODO_CONTEXT_TYPE,
		content: [
			"[INTERNAL TODO CONTEXT, NOT USER INPUT]",
			"This latest todo snapshot supersedes all older todo snapshots, including older todo-context messages. Ignore older snapshots.",
			"The following todo items are open or in progress and form the active work queue (bounded):",
			formatBoundedActiveChecklist(todos),
			"Reflect verified progress with todo status updates, using one atomic update for related changes when useful.",
			"Continue the next unverified item autonomously unless it conflicts or requires material input.",
		].join("\n"),
		display: false,
	});
	const mutationResult = (action: TodoDetails["action"], text: string) =>
		toolResult(action, `${text}${activeTodoReceipt()}`);

	const snapshot = (): TodoSnapshot => ({ todos: cloneTodos(todos), nextId });

	const persist = (): void => {
		pi.appendEntry("todo", snapshot());
	};

	const updateWidget = (ctx: ExtensionContext | undefined): void => {
		const nextPanel = ctx?.mode === "tui" ? getBottomPanel(ctx) : undefined;
		if (nextPanel !== todoPanel) {
			todoSection?.remove();
			todoSection = undefined;
			todoPanel = nextPanel;
		}
		if (!todoPanel) return;
		if (todos.length === 0 || todos.every((todo) => todo.status === "done")) {
			todoSection?.remove();
			todoSection = undefined;
			return;
		}
		const renderItems = (_width: number, theme: Theme): string[] => {
			const idWidth = todoIdWidth(todos);
			return cloneTodos(todos).map((todo) => {
				const check = colorTodoGlyph(theme, todo.status);
				const id = theme.fg("dim", formatTodoId(todo.id, idWidth));
				const body =
					todo.status === "done"
						? theme.fg("muted", theme.strikethrough(todo.text))
						: todo.status === "in_progress"
							? theme.fg("warning", todo.text)
							: theme.fg("text", todo.text);
				return ` ${check}  ${id}  ${body}`;
			});
		};
		if (!todoSection) {
			todoSection = todoPanel.registerSection("todos", {
				order: BOTTOM_PANEL_SECTION_ORDER.todos,
				maxLines: 6,
				render: renderItems,
				overflowLabel: (omitted, theme) => theme.fg("muted", `+ ${omitted} more`),
			});
			return;
		}
		todoSection.update({ render: renderItems });
	};

	/** Persist and refresh the widget after a state mutation. */
	const afterMutation = (ctx: ExtensionContext | undefined): void => {
		persist();
		updateWidget(ctx ?? currentCtx);
	};

	const addTodos = (texts: string[], ctx: ExtensionContext | undefined): Todo[] => {
		const added = texts.map((text) => ({ id: nextId++, text, status: "open" as const }));
		todos.push(...added);
		afterMutation(ctx);
		return added;
	};

	const normalizeLifecycle = (
		candidate: Todo[],
		previous: Todo[],
		options: { startFirstOpen?: boolean; completedId?: number } = {},
	): void => {
		if (options.startFirstOpen && !candidate.some((todo) => todo.status === "in_progress")) {
			const firstOpen = candidate.find((todo) => todo.status === "open");
			if (firstOpen) firstOpen.status = "in_progress";
		}

		if (options.completedId === undefined) return;
		const previousInProgress = previous.filter((todo) => todo.status === "in_progress");
		const completedBefore = previous.find((todo) => todo.id === options.completedId);
		const completedAfter = candidate.find((todo) => todo.id === options.completedId);
		if (
			previousInProgress.length !== 1 ||
			completedBefore?.status !== "in_progress" ||
			completedAfter?.status !== "done" ||
			candidate.some((todo) => todo.status === "in_progress")
		)
			return;

		const completedIndex = candidate.findIndex((todo) => todo.id === options.completedId);
		const following =
			completedIndex >= 0
				? [...candidate.slice(completedIndex + 1), ...candidate.slice(0, completedIndex)]
				: candidate;
		const nextOpen = following.find((todo) => todo.status === "open");
		if (nextOpen) nextOpen.status = "in_progress";
	};

	const sameTodoState = (left: Todo[], right: Todo[]): boolean =>
		left.length === right.length &&
		left.every(
			(todo, index) =>
				todo.id === right[index]?.id &&
				todo.text === right[index]?.text &&
				todo.status === right[index]?.status,
		);

	const commitTodos = (candidate: Todo[], ctx: ExtensionContext): boolean => {
		if (sameTodoState(candidate, todos)) return false;
		todos = candidate;
		afterMutation(ctx);
		return true;
	};

	const validateBatchUpdates = (
		rawUpdates: unknown,
	): { updates?: TodoStatusUpdate[]; error?: string } => {
		if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
			return { error: "updates requires at least one item" };
		}
		if (rawUpdates.length > 64) return { error: "updates supports at most 64 items" };

		const seen = new Set<number>();
		const updates: TodoStatusUpdate[] = [];
		for (const [index, rawUpdate] of rawUpdates.entries()) {
			if (!rawUpdate || typeof rawUpdate !== "object") {
				return { error: `updates[${index}] must be an object` };
			}
			const update = rawUpdate as { id?: unknown; status?: unknown };
			if (typeof update.id !== "number" || !Number.isInteger(update.id) || update.id < 1) {
				return { error: `updates[${index}] requires a positive integer id` };
			}
			if (!isTodoStatus(update.status)) {
				return { error: `updates[${index}] has invalid status` };
			}
			if (seen.has(update.id)) return { error: `updates contains duplicate ID #${update.id}` };
			seen.add(update.id);
			if (!todos.some((todo) => todo.id === update.id)) {
				return { error: `Todo #${update.id} not found` };
			}
			updates.push({ id: update.id, status: update.status });
		}
		return { updates };
	};

	const setTodoStatus = (
		id: number,
		status: TodoStatus,
		action: TodoDetails["action"],
		ctx: ExtensionContext,
	) => {
		const todo = todos.find((item) => item.id === id);
		if (!todo) {
			const error = `#${id} not found`;
			return toolResult(action, `Todo #${id} not found`, error);
		}
		if (todo.status !== status) {
			const previous = cloneTodos(todos);
			const candidate = cloneTodos(todos);
			candidate.find((item) => item.id === id)!.status = status;
			normalizeLifecycle(candidate, previous, {
				completedId: status === "done" ? id : undefined,
			});
			commitTodos(candidate, ctx);
		}
		const label =
			status === "done" ? "completed" : status === "in_progress" ? "started" : "reopened";
		return mutationResult(action, `Todo #${todo.id} ${label}`);
	};

	/** Queue at most one automatic turn to work through the latest open list. */
	const queueReconciliation = (): void => {
		if (reconciliationQueued || reconciliationTurn) return;
		const checklist = formatActiveChecklist(todos);
		if (!checklist) return;
		reconciliationQueued = true;
		pi.sendMessage(
			{
				customType: TODO_RECONCILIATION_TYPE,
				content: `${TODO_RECONCILIATION_GUIDANCE}\n\nOpen work:\n${checklist}`,
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	const resetReconciliationState = (): void => {
		reconciliationQueued = false;
		reconciliationTurn = false;
		parentTurnAborted = false;
		settlementHandled = false;
		lastTodoContextState = undefined;
	};

	/** Rebuild state from the latest todo snapshot on the current branch. */
	const reconstruct = (ctx: ExtensionContext): void => {
		let latest: TodoSnapshot | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			const e = entry as { type: string; customType?: string; data?: TodoSnapshot };
			if (e.type === "custom" && e.customType === "todo" && e.data) latest = e.data;
		}
		if (!latest) {
			todos = [];
			nextId = 1;
			return;
		}
		todos = (latest.todos ?? [])
			.map((todo) => normalizeTodo(todo))
			.filter((todo): todo is Todo => todo !== undefined);
		const greatestId = todos.reduce((max, todo) => Math.max(max, todo.id), 0);
		nextId = Math.max(1, latest.nextId ?? 1, greatestId + 1);
	};

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		resetReconciliationState();
		reconstruct(ctx);
		updateWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		currentCtx = ctx;
		resetReconciliationState();
		reconstruct(ctx);
		updateWidget(ctx);
	});

	pi.on("session_shutdown", () => {
		todoSection?.remove();
		todoSection = undefined;
		todoPanel = undefined;
		currentCtx = undefined;
	});

	pi.on("before_agent_start", () => {
		parentTurnAborted = false;
		reconciliationTurn = reconciliationQueued;
		reconciliationQueued = false;
		settlementHandled = false;
		const state = todoContextState();
		if (state === lastTodoContextState) return;
		if (state === EMPTY_TODO_CONTEXT_STATE && lastTodoContextState === undefined) return;
		lastTodoContextState = state;
		return { message: todoContextMessage() };
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; stopReason?: string };
		if (message.role === "assistant" && message.stopReason === "aborted") {
			parentTurnAborted = true;
		}
	});

	pi.on("agent_settled", () => {
		if (settlementHandled) return;
		settlementHandled = true;
		if (parentTurnAborted) {
			parentTurnAborted = false;
			reconciliationQueued = false;
			reconciliationTurn = false;
			return;
		}
		if (reconciliationTurn) {
			reconciliationTurn = false;
			return;
		}
		queueReconciliation();
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		renderShell: "self",
		description:
			"Manage the standalone todo list. Actions: list, add, edit, move, remove, start, complete, reopen, replace, update.",
		promptSnippet: "Track and maintain multi-step work as a todo list",
		promptGuidelines: [
			"Use todo to track multi-step work: add each step, start the active one, then complete it after its work is verified.",
			"Todo status is open (○), in_progress (◐), or done (✓). Use update for atomic status changes; start, complete, and reopen by ID are idempotent.",
			"Use todo edit, move, or remove by ID when the user requests list maintenance; move positions are one-based.",
			"When executing a user-approved plan, replace the todo list with its steps before starting; Todo confirms before discarding open work.",
			"Use replace rather than add to start a fresh list when beginning unrelated work. The first replacement item starts automatically when no item is active, and the widget auto-hides when all items are complete.",
		],
		parameters: TodoParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			switch (params.action) {
				case "list":
					return toolResult(
						"list",
						todos.length ? todos.map(formatTodoLine).join("\n") : "No todos",
					);

				case "add": {
					const rawTexts = params.items ?? (params.text !== undefined ? [params.text] : []);
					const texts = rawTexts
						.filter((text) => text.trim().length > 0)
						.map((text) => text.trim());
					if (texts.length === 0) {
						return toolResult(
							"add",
							"Error: text or items required for add",
							"text or items required",
						);
					}
					const added = addTodos(texts, ctx);
					const summary =
						added.length === 1
							? `Added todo #${added[0].id}: ${added[0].text}`
							: `Added ${added.length} todos: ${added.map((todo) => `#${todo.id}`).join(", ")}`;
					return mutationResult("add", summary);
				}

				case "edit": {
					if (params.id === undefined) {
						return toolResult("edit", "Error: id required for edit", "id required for edit");
					}
					const text = params.text?.trim() ?? "";
					if (!text) {
						return toolResult(
							"edit",
							"Error: non-empty text required for edit",
							"text required for edit",
						);
					}
					const todo = todos.find((item) => item.id === params.id);
					if (!todo) {
						const error = `#${params.id} not found`;
						return toolResult("edit", `Todo #${params.id} not found`, error);
					}
					if (todo.text !== text) {
						todo.text = text;
						afterMutation(ctx);
					}
					return mutationResult("edit", `Edited todo #${todo.id}: ${todo.text}`);
				}

				case "move": {
					if (params.id === undefined || params.position === undefined) {
						const error = "id and position required for move";
						return toolResult("move", `Error: ${error}`, error);
					}
					const from = todos.findIndex((item) => item.id === params.id);
					if (from < 0) {
						const error = `#${params.id} not found`;
						return toolResult("move", `Todo #${params.id} not found`, error);
					}
					if (params.position > todos.length) {
						const error = `position must be between 1 and ${todos.length}`;
						return toolResult("move", `Error: ${error}`, error);
					}
					const destination = params.position - 1;
					if (from !== destination) {
						const [todo] = todos.splice(from, 1);
						todos.splice(destination, 0, todo!);
						afterMutation(ctx);
					}
					return mutationResult("move", `Moved todo #${params.id} to position ${params.position}`);
				}

				case "remove": {
					if (params.id === undefined) {
						return toolResult("remove", "Error: id required for remove", "id required for remove");
					}
					const index = todos.findIndex((item) => item.id === params.id);
					if (index < 0) {
						const error = `#${params.id} not found`;
						return toolResult("remove", `Todo #${params.id} not found`, error);
					}
					const [removed] = todos.splice(index, 1);
					afterMutation(ctx);
					return mutationResult("remove", `Removed todo #${removed!.id}: ${removed!.text}`);
				}

				case "start":
				case "complete":
				case "reopen": {
					if (params.id === undefined) {
						const message = `Error: id required for ${params.action}`;
						return toolResult(params.action, message, `id required for ${params.action}`);
					}
					const status: TodoStatus =
						params.action === "complete"
							? "done"
							: params.action === "start"
								? "in_progress"
								: "open";
					return setTodoStatus(params.id, status, params.action, ctx);
				}

				case "update": {
					const validation = validateBatchUpdates(params.updates);
					if (!validation.updates) {
						const error = validation.error ?? "invalid updates";
						return toolResult("update", `Error: ${error}`, error);
					}

					const previous = cloneTodos(todos);
					const candidate = cloneTodos(todos);
					for (const update of validation.updates) {
						const todo = candidate.find((item) => item.id === update.id);
						if (todo) todo.status = update.status;
					}
					const currentInProgress = previous.filter((todo) => todo.status === "in_progress");
					const completedId =
						currentInProgress.length === 1 &&
						validation.updates.some(
							(update) => update.id === currentInProgress[0]!.id && update.status === "done",
						)
							? currentInProgress[0]!.id
							: undefined;
					normalizeLifecycle(candidate, previous, { completedId });
					commitTodos(candidate, ctx);
					const count = validation.updates.length;
					return mutationResult("update", `Updated ${count} todo${count === 1 ? "" : "s"}`);
				}

				case "replace": {
					if (params.items === undefined) {
						return toolResult("replace", "Error: items required for replace", "items required");
					}
					const texts = params.items
						.filter((text) => text.trim().length > 0)
						.map((text) => text.trim());
					if (texts.length === 0) {
						const error = "replace requires at least one non-empty item";
						return toolResult("replace", `Error: ${error}`, error);
					}
					if (todos.some(isActiveTodo)) {
						if (ctx.hasUI === false || typeof ctx.ui?.confirm !== "function") {
							const error = "replace requires interactive confirmation while open todos remain";
							return toolResult("replace", `Error: ${error}`, error);
						}
						const confirmed = await ctx.ui.confirm(
							"Replace todo list?",
							"Open todos will be discarded and replaced with the requested items.",
						);
						if (!confirmed) {
							const error = "replace cancelled; current todos were kept";
							return toolResult("replace", `Error: ${error}`, error);
						}
					}
					const replacement = texts.map((text) => ({
						id: nextId++,
						text,
						status: "open" as const,
					}));
					normalizeLifecycle(replacement, todos, { startFirstOpen: true });
					todos = replacement;
					afterMutation(ctx);
					return mutationResult("replace", `Replaced todo list with ${todos.length} todos`);
				}

				default:
					return toolResult(
						"list",
						`Unknown action: ${params.action}`,
						`unknown action: ${params.action}`,
					);
			}
		},

		renderCall(args, theme, context) {
			const target = args.id !== undefined ? ` · #${args.id}` : "";
			const destination = args.position !== undefined ? ` → ${args.position}` : "";
			const content = new Text(
				theme.fg("toolTitle", theme.bold("todo ")) +
					theme.fg("accent", args.action) +
					theme.fg("muted", target + destination),
				1,
				0,
			);
			if (args.action === "replace" && !context.expanded) return emptyCollapsedToolRender();
			return new ExpandableToolRender(context, content);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as TodoDetails | undefined;
			if (details?.error && !isPartial) {
				return new Text(theme.fg("error", `× todo · ${details.error}`), 1, 0);
			}
			if (context.isError && !isPartial) {
				const text = result.content.find((part) => part.type === "text");
				return new Text(
					theme.fg("error", `× todo · ${text?.type === "text" ? text.text : "Todo tool failed"}`),
					1,
					0,
				);
			}
			if (!shouldRevealToolDetails({ expanded, isError: context.isError })) {
				return emptyCollapsedToolRender();
			}
			const text = result.content.find((part) => part.type === "text");
			return text?.type === "text" ? new Text(theme.fg("muted", text.text), 1, 0) : new Container();
		},
	});

	pi.registerCommand("todos", {
		description: "View and manage the current todo list",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			let selectedId: number | undefined;
			while (true) {
				const action = await ctx.ui.custom<TodoListAction | undefined>(
					(tui, theme, _kb, done) =>
						new TodoListComponent(
							cloneTodos(todos),
							theme,
							() => done(undefined),
							tui,
							(next) => {
								todos = cloneTodos(next);
								afterMutation(ctx);
							},
							(nextAction) => done(nextAction),
							selectedId,
						),
					fullscreenOverlayOptions(),
				);
				if (!action) return;

				const index = todos.findIndex((todo) => todo.id === action.id);
				const todo = todos[index];
				if (!todo) {
					ctx.ui.notify(`Todo #${action.id} no longer exists`, "error");
					selectedId = undefined;
					continue;
				}
				selectedId = todo.id;

				if (action.type === "edit") {
					const edited = await ctx.ui.editor(`Edit todo #${todo.id}`, todo.text);
					if (edited === undefined) continue;
					const text = edited.trim();
					if (!text) {
						ctx.ui.notify("Todo text cannot be empty", "error");
						continue;
					}
					if (todo.text !== text) {
						todo.text = text;
						afterMutation(ctx);
					}
					continue;
				}

				const confirmed = await ctx.ui.confirm(`Remove todo #${todo.id}?`, todo.text);
				if (!confirmed) continue;
				todos.splice(index, 1);
				selectedId = todos[Math.min(index, todos.length - 1)]?.id;
				afterMutation(ctx);
			}
		},
	});

	pi.registerCommand("todos:add", {
		description: "Queue a todo for automatic follow-up",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /todos:add <text>", "error");
				return;
			}
			const todo = addTodos([text], ctx)[0]!;
			queueReconciliation();
			ctx.ui.notify(`Queued todo #${todo.id}: ${todo.text}`, "info");
		},
	});

	pi.registerCommand("todos:clear", {
		description: "Clear the current todo list",
		handler: async (_args, ctx) => {
			const count = todos.length;
			if (count === 0) {
				ctx.ui.notify("Todo list is already empty", "info");
				return;
			}
			todos = [];
			reconciliationQueued = false;
			reconciliationTurn = false;
			persist();
			updateWidget(ctx);
			ctx.ui.notify(`Cleared ${count} todo${count === 1 ? "" : "s"}`, "info");
		},
	});
}
