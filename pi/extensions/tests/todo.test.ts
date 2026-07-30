import { visibleWidth } from "@earendil-works/pi-tui";
import todoExtension, {
	TodoListComponent,
	cycleTodoStatus,
	normalizeTodo,
	todoStatusGlyph,
} from "../todo.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

let todoTool: any;
let widgetFactory: any;
let widgetSetCount = 0;
let todoCommand: any;
let addCommand: any;
let clearCommand: any;
let todoOptions: any;
let confirmCalls = 0;
let confirmAnswer = false;
const entries: any[] = [];
const sentMessages: Array<{ message: any; options?: any }> = [];
const handlers = new Map<string, (event: any, context: any) => Promise<any> | any>();

todoExtension({
	on: (event: string, handler: (event: any, context: any) => Promise<any> | any) => {
		handlers.set(event, handler);
	},
	registerTool: (tool: any) => {
		todoTool = tool;
	},
	registerCommand: (name: string, command: any) => {
		if (name === "todos") todoCommand = command;
		if (name === "todos:add") addCommand = command;
		if (name === "todos:clear") clearCommand = command;
	},
	appendEntry: (customType: string, data: any) => {
		entries.push({ type: "custom", customType, data });
	},
	sendMessage: (message: any, options?: any) => {
		sentMessages.push({ message, options });
	},
} as any);

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as any;

assert(
	"todo mutations execute sequentially",
	todoTool.executionMode === "sequential",
	String(todoTool.executionMode),
);
assert("registers /todos command", Boolean(todoCommand), "missing command");
assert("registers /todos:add command", Boolean(addCommand), "missing add command");
assert("registers /todos:clear command", Boolean(clearCommand), "missing clear command");

function context(overrides: any = {}): any {
	return {
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: {
			setWidget: (_name: string, factory: any) => {
				widgetFactory = factory;
				widgetSetCount++;
			},
			confirm: async () => {
				confirmCalls++;
				return confirmAnswer;
			},
			notify: () => undefined,
			custom: async () => undefined,
		},
		...overrides,
	};
}

async function run(action: string, params: any = {}, overrides: any = {}): Promise<any> {
	return todoTool.execute("test", { action, ...params }, undefined, undefined, context(overrides));
}

let todosClosed = false;
let emptyTodoRendered: string[] = [];
await todoCommand.handler(
	"",
	context({
		ui: {
			...context().ui,
			custom: async (factory: any, options: any) => {
				todoOptions = options;
				const component = factory(
					{ terminal: { rows: 7 }, requestRender: () => undefined },
					theme,
					undefined,
					() => {
						todosClosed = true;
					},
				);
				emptyTodoRendered = component.render(24);
				component.handleInput("\x1b");
			},
		},
	}),
);
assert(
	"/todos opens a full-screen empty state and closes on Escape",
	todosClosed &&
		todoOptions?.overlay === true &&
		todoOptions.overlayOptions.width === "100%" &&
		emptyTodoRendered.every((line) => visibleWidth(line) === 24) &&
		emptyTodoRendered.some((line) => line.includes("No todos yet")) &&
		emptyTodoRendered.at(-1)?.trim() === "" &&
		emptyTodoRendered.join("\n").includes("Esc") &&
		emptyTodoRendered.at(-2)?.trim() !== "",
	JSON.stringify({ todosClosed, todoOptions, emptyTodoRendered }),
);

const narrowTodoView = new TodoListComponent(
	[{ id: 1, text: "A very long todo that must clip safely", status: "open" }],
	theme,
	() => undefined,
	{ terminal: { rows: 3 }, requestRender: () => undefined } as any,
);
const narrowTodoRendered = narrowTodoView.render(12);
assert(
	"todo view remains bounded at narrow width and tiny height",
	narrowTodoRendered.length === 3 && narrowTodoRendered.every((line) => visibleWidth(line) === 12),
	narrowTodoRendered.map((line) => `${visibleWidth(line)}:${line}`).join("\\n"),
);

const wrappedTodoView = new TodoListComponent(
	[
		{
			id: 2,
			text: "This todo item should wrap across multiple terminal lines without losing its full description",
			status: "open",
		},
	],
	theme,
	() => undefined,
	{ terminal: { rows: 14 }, requestRender: () => undefined } as any,
);
const wrappedTodoRendered = wrappedTodoView.render(36);
const wrappedTodoLines = wrappedTodoRendered.map((line) => line.trimEnd());
const firstWrappedLine = wrappedTodoLines.findIndex((line) => line.includes("This todo item"));
const lastWrappedLine = wrappedTodoLines.findIndex((line) => line.includes("description"));
assert(
	"todo view wraps long item text without truncating it",
	firstWrappedLine >= 0 &&
		lastWrappedLine > firstWrappedLine &&
		wrappedTodoRendered.every((line) => visibleWidth(line) === 36) &&
		!wrappedTodoRendered.join("\n").includes("…"),
	wrappedTodoRendered.join("\\n"),
);

const result = {
	content: [{ type: "text", text: "Added 3 todos: #1, #2, #3" }],
	details: {
		action: "add",
		todos: [
			{ id: 1, text: "One", status: "open" },
			{ id: 2, text: "Two", status: "open" },
			{ id: 3, text: "Three", status: "open" },
		],
		nextId: 4,
	},
};
const renderedCall = todoTool
	.renderCall({ action: "add", items: ["One", "Two", "Three"] }, theme, { isError: false })
	.render(80);
const renderedResult = todoTool
	.renderResult(result, { expanded: false, isPartial: false }, theme, {
		expanded: false,
		isError: false,
	})
	.render(80);
const expandedCall = todoTool
	.renderCall({ action: "add", items: ["One", "Two", "Three"] }, theme, {
		expanded: true,
		isError: false,
	})
	.render(80)
	.join("\n");
const expandedResult = todoTool
	.renderResult(result, { expanded: true, isPartial: false }, theme, {
		expanded: true,
		isError: false,
	})
	.render(80)
	.join("\n");
assert(
	"successful todo calls stay hidden until Ctrl+O reveals their audit details",
	renderedCall.length === 0 &&
		renderedResult.length === 0 &&
		expandedCall.includes("todo add") &&
		expandedResult.includes("Added 3 todos"),
	JSON.stringify({ renderedCall, renderedResult, expandedCall, expandedResult }),
);

const added = await run("add", { items: [" First ", "Second", "Third"] });
let listed = await run("list");
assert(
	"add and list expose lifecycle IDs and trimmed text",
	added.content[0].text.includes("Open todos: #1: First; #2: Second; #3: Third") &&
		listed.content[0].text === "[ ] #1: First\n[ ] #2: Second\n[ ] #3: Third",
	JSON.stringify({ added, listed }),
);
const openWidget = widgetFactory(undefined, theme).render(80) as string[];
assert(
	"todo widget leaves one blank line above the input",
	openWidget.length === 4 && openWidget.at(-1) === "" && openWidget.at(-2)?.includes("Third"),
	JSON.stringify(openWidget),
);

const persistedBeforeMutation = entries.at(-1).data;
persistedBeforeMutation.todos[0].text = "mutated persisted state";
const detailBeforeMutation = listed.details;
detailBeforeMutation.todos[0].text = "mutated tool detail state";
listed = await run("list");
assert(
	"persisted snapshots and tool details are independent deep clones",
	listed.content[0].text.includes("#1: First") && listed.details.todos[0].text === "First",
	JSON.stringify({ persistedBeforeMutation, listed }),
);

let prompt = await handlers.get("before_agent_start")?.({ systemPrompt: "base system" }, context());
assert(
	"open todos inject an active hidden work queue on every turn",
	prompt.systemPrompt.includes("#1: First") &&
		prompt.systemPrompt.includes("#2: Second") &&
		prompt.systemPrompt.includes("active work queue") &&
		prompt.systemPrompt.includes("including work performed through delegation") &&
		prompt.systemPrompt.includes("autonomously start the next unverified item") &&
		prompt.systemPrompt.includes("do not batch completions"),
	prompt.systemPrompt,
);

await handlers.get("agent_settled")?.({}, context());
assert(
	"ordinary settlement queues one hidden todo reconciliation turn with current IDs",
	sentMessages.length === 1 &&
		sentMessages[0].message.customType === "todo-reconciliation" &&
		sentMessages[0].message.display === false &&
		sentMessages[0].message.content.includes("NOT USER INPUT") &&
		sentMessages[0].message.content.includes("#1: First") &&
		sentMessages[0].options?.deliverAs === "followUp" &&
		sentMessages[0].options?.triggerTurn === true,
	JSON.stringify(sentMessages),
);
await handlers.get("before_agent_start")?.({ systemPrompt: "base system" }, context());
await handlers.get("agent_settled")?.({}, context());
assert(
	"the reconciliation turn does not queue itself repeatedly",
	sentMessages.length === 1,
	JSON.stringify(sentMessages),
);
await handlers.get("before_agent_start")?.({ systemPrompt: "base system" }, context());
await handlers.get("agent_settled")?.({}, context());
assert(
	"a later ordinary turn can reconcile still-open work again",
	sentMessages.length === 2,
	JSON.stringify(sentMessages),
);
await handlers.get("before_agent_start")?.({ systemPrompt: "base system" }, context());
await handlers.get("message_end")?.(
	{
		message: { role: "assistant", stopReason: "aborted" },
	},
	context(),
);
await handlers.get("agent_settled")?.({}, context());
assert(
	"Escape abort does not immediately restart work through todo reconciliation",
	sentMessages.length === 2,
	JSON.stringify(sentMessages),
);
await handlers.get("before_agent_start")?.({ systemPrompt: "base system" }, context());
await handlers.get("agent_settled")?.({}, context());
assert(
	"a normal turn after an abort can still reconcile open work",
	sentMessages.length === 3,
	JSON.stringify(sentMessages),
);

await run("complete", { id: 1 });
let reopened = await run("reopen", { id: 1 });
assert(
	"reopen changes a completed todo back to open",
	reopened.content[0].text.includes("Todo #1 reopened") &&
		reopened.content[0].text.includes("Open todos: #1: First") &&
		reopened.details.todos[0].status === "open",
	JSON.stringify(reopened),
);
const started = await run("start", { id: 1 });
assert(
	"start marks a todo in progress and keeps it in the active summary",
	started.content[0].text.includes("Todo #1 started") &&
		started.content[0].text.includes("Open todos: #1 [in progress]: First") &&
		started.details.todos[0].status === "in_progress" &&
		(widgetFactory(undefined, theme).render(80) as string[]).some((line) => line.includes("◐")),
	JSON.stringify(started),
);
await run("complete", { id: 1 });
const completeAgain = await run("complete", { id: 1 });
const reopenAgain = await run("reopen", { id: 1 });
const startAgain = await run("start", { id: 1 });
assert(
	"start, complete, and reopen are idempotent",
	completeAgain.details.todos[0].status === "done" &&
		reopenAgain.details.todos[0].status === "open" &&
		startAgain.details.todos[0].status === "in_progress",
	JSON.stringify({ completeAgain, reopenAgain, startAgain }),
);
await run("complete", { id: 1 });

await run("complete", { id: 2 });
const finalCompletion = await run("complete", { id: 3 });
assert(
	"completion returns remaining IDs and the widget auto-hides when none remain",
	finalCompletion.content[0].text.includes("Open todos: none") && widgetFactory === undefined,
	JSON.stringify({ finalCompletion, widgetFactory }),
);

let todosViewRendered: string[] = [];
await todoCommand.handler(
	"",
	context({
		ui: {
			...context().ui,
			custom: async (factory: any, _options: any) => {
				const component = factory(
					{ terminal: { rows: 10 }, requestRender: () => undefined },
					theme,
					undefined,
					() => undefined,
				);
				todosViewRendered = component.render(40);
			},
		},
	}),
);
assert(
	"/todos still shows all completed items after widget auto-hides",
	todosViewRendered.some((line) => line.includes("✓") && line.includes("#1")) &&
		todosViewRendered.some((line) => line.includes("✓") && line.includes("#3")),
	JSON.stringify(todosViewRendered),
);

confirmAnswer = false;
const noConfirmReplace = await run("replace", { items: ["No-confirm replacement"] });
assert(
	"replace does not ask for confirmation when the list has no open items",
	confirmCalls === 0 && noConfirmReplace.details.todos[0].text === "No-confirm replacement",
	JSON.stringify(noConfirmReplace),
);

const firstReplacementId = noConfirmReplace.details.todos[0].id;
confirmAnswer = true;
const replacementResult = await run("replace", {
	items: ["Open replacement", "Another replacement"],
});
const replaced = await run("list");
assert(
	"replace confirms open-list replacement, returns IDs, and allocates them monotonically",
	confirmCalls === 1 &&
		firstReplacementId === 4 &&
		replacementResult.content[0].text.includes("#5: Open replacement") &&
		replacementResult.content[0].text.includes("#6: Another replacement") &&
		replaced.content[0].text === "[ ] #5: Open replacement\n[ ] #6: Another replacement",
	JSON.stringify({ confirmCalls, replacementResult, replaced }),
);

const callsBeforeEmptyReplace = confirmCalls;
const emptyReplace = await run("replace", { items: [" "] });
assert(
	"replace rejects an empty replacement without discarding or prompting",
	emptyReplace.details.error?.includes("at least one non-empty item") &&
		confirmCalls === callsBeforeEmptyReplace &&
		(await run("list")).content[0].text.includes("#5: Open replacement"),
	JSON.stringify(emptyReplace),
);

const callsBeforeNoUiReplace = confirmCalls;
const noUiReplace = await run(
	"replace",
	{ items: ["Should not replace"] },
	{
		mode: "non-tui",
		hasUI: false,
		ui: {
			confirm: async () => {
				throw new Error("confirmation must not be called");
			},
		},
	},
);
assert(
	"replace rejects safely without TUI or confirmation",
	confirmCalls === callsBeforeNoUiReplace &&
		noUiReplace.details.error?.includes("requires interactive confirmation") &&
		(await run("list")).content[0].text.includes("#5: Open replacement"),
	JSON.stringify(noUiReplace),
);

confirmAnswer = false;
const cancelledOpenReplace = await run("replace", { items: ["Still not replaced"] });
assert(
	"replace confirmation cancellation preserves open todos",
	cancelledOpenReplace.details.error?.includes("cancelled") &&
		(await run("list")).content[0].text.includes("#5: Open replacement"),
	JSON.stringify(cancelledOpenReplace),
);

const reconstructedBranch = [
	{
		type: "custom",
		customType: "todo",
		data: {
			todos: [{ id: 40, text: "Reconstructed", done: true }],
			nextId: 41,
		},
	},
];
await handlers.get("session_start")?.(
	{},
	context({
		sessionManager: { getBranch: () => reconstructedBranch },
	}),
);
reconstructedBranch[0].data.todos[0].text = "mutated branch";
const reconstructed = await run("list");
assert(
	"session and branch reconstruction restores the latest standalone snapshot",
	reconstructed.content[0].text === "[x] #40: Reconstructed" &&
		reconstructed.details.todos[0].status === "done" &&
		reconstructed.details.nextId === 41,
	JSON.stringify(reconstructed),
);

const errorPayload = {
	content: [{ type: "text", text: "Todo #99 not found" }],
	details: { ...result.details, action: "complete" as const, error: "#99 not found" },
};
const collapsedErrorCall = todoTool
	.renderCall({ action: "complete", id: 99 }, theme, { expanded: false, isError: true })
	.render(80);
const collapsedErrorResult = todoTool
	.renderResult(errorPayload, { expanded: false, isPartial: false }, theme, {
		expanded: false,
		isError: true,
	})
	.render(80);
const expandedErrorResult = todoTool
	.renderResult(errorPayload, { expanded: true, isPartial: false }, theme, {
		expanded: true,
		isError: true,
	})
	.render(80)
	.join("\n");
assert(
	"todo validation errors remain visible while details stay expandable",
	collapsedErrorCall.join("\n").includes("todo complete · #99") &&
		collapsedErrorResult.join("\n").includes("× todo · #99 not found") &&
		expandedErrorResult.includes("#99 not found"),
	JSON.stringify({ collapsedErrorCall, collapsedErrorResult, expandedErrorResult }),
);

const clearNotices: Array<{ message: string; type?: string }> = [];
const clearCtx = context();
clearCtx.ui.notify = (message: string, type?: string) => clearNotices.push({ message, type });
const entriesBeforeClear = entries.length;
await clearCommand.handler("", clearCtx);
const cleared = await run("list");
assert(
	"/todos:clear persists an empty list and removes the widget",
	cleared.content[0].text === "No todos" &&
		entries.length === entriesBeforeClear + 1 &&
		entries.at(-1)?.data.todos.length === 0 &&
		entries.at(-1)?.data.nextId === 41 &&
		widgetFactory === undefined &&
		clearNotices.at(-1)?.message === "Cleared 1 todo" &&
		clearNotices.at(-1)?.type === "info",
	JSON.stringify({ cleared, latest: entries.at(-1), clearNotices, widgetFactory }),
);

const addedAfterClear = await run("add", { text: "After manual clear" });
assert(
	"/todos:clear preserves monotonic todo IDs",
	addedAfterClear.details.todos[0]?.id === 41,
	JSON.stringify(addedAfterClear),
);
await clearCommand.handler("", clearCtx);
const entriesBeforeEmptyClear = entries.length;
await clearCommand.handler("", clearCtx);
assert(
	"/todos:clear reports an already-empty list without another snapshot",
	entries.length === entriesBeforeEmptyClear &&
		clearNotices.at(-1)?.message === "Todo list is already empty",
	JSON.stringify({ entriesBeforeEmptyClear, entries: entries.length, clearNotices }),
);

const addNotices: Array<{ message: string; type?: string }> = [];
const addCtx = context();
addCtx.ui.notify = (message: string, type?: string) => addNotices.push({ message, type });
const entriesBeforeInvalidAdd = entries.length;
const messagesBeforeInvalidAdd = sentMessages.length;
await addCommand.handler("   ", addCtx);
assert(
	"/todos:add rejects missing text without changing state or scheduling work",
	entries.length === entriesBeforeInvalidAdd &&
		sentMessages.length === messagesBeforeInvalidAdd &&
		addNotices.at(-1)?.message === "Usage: /todos:add <text>" &&
		addNotices.at(-1)?.type === "error",
	JSON.stringify({ entries: entries.length, sentMessages, addNotices }),
);

await addCommand.handler("  First queued task  ", addCtx);
await addCommand.handler("Second queued task", addCtx);
const queuedList = await run("list");
const queuedPrompt = await handlers.get("before_agent_start")?.(
	{ systemPrompt: "base system" },
	context(),
);
const messagesBeforeQueuedSettlement = sentMessages.length;
await handlers.get("agent_settled")?.({}, context());
assert(
	"/todos:add persists repeated tasks and coalesces them into one automatic follow-up",
	queuedList.content[0].text === "[ ] #42: First queued task\n[ ] #43: Second queued task" &&
		entries.at(-1)?.data.todos.length === 2 &&
		sentMessages.length === messagesBeforeInvalidAdd + 1 &&
		sentMessages.at(-1)?.options?.deliverAs === "followUp" &&
		sentMessages.at(-1)?.options?.triggerTurn === true &&
		queuedPrompt.systemPrompt.includes("#42: First queued task") &&
		queuedPrompt.systemPrompt.includes("#43: Second queued task") &&
		sentMessages.length === messagesBeforeQueuedSettlement &&
		addNotices.at(-1)?.message === "Queued todo #43: Second queued task" &&
		addNotices.at(-1)?.type === "info",
	JSON.stringify({ queuedList, latest: entries.at(-1), sentMessages, queuedPrompt, addNotices }),
);

await clearCommand.handler("", clearCtx);
const mutationSeed = await run("add", { items: ["Alpha", "Beta", "Gamma"] });
const [alphaId, betaId, gammaId] = mutationSeed.details.todos.map((todo: any) => todo.id);
const editedTodo = await run("edit", { id: betaId, text: "  Edited beta  " });
const movedTodo = await run("move", { id: gammaId, position: 1 });
const invalidMove = await run("move", { id: alphaId, position: 4 });
const removedTodo = await run("remove", { id: alphaId });
const mutationList = await run("list");
assert(
	"edit, move, and remove mutate one todo while preserving stable IDs",
	editedTodo.details.todos.find((todo: any) => todo.id === betaId)?.text === "Edited beta" &&
		movedTodo.details.todos.map((todo: any) => todo.id).join(",") ===
			`${gammaId},${alphaId},${betaId}` &&
		invalidMove.details.error === "position must be between 1 and 3" &&
		removedTodo.content[0].text.includes(`Removed todo #${alphaId}: Alpha`) &&
		mutationList.content[0].text === `[ ] #${gammaId}: Gamma\n[ ] #${betaId}: Edited beta`,
	JSON.stringify({ editedTodo, movedTodo, invalidMove, removedTodo, mutationList }),
);
const mutationSnapshotCount = entries.length;
const unchangedEdit = await run("edit", { id: betaId, text: "Edited beta" });
const unchangedMove = await run("move", { id: betaId, position: 2 });
const missingRemove = await run("remove", { id: 999 });
assert(
	"todo maintenance actions validate input and avoid redundant snapshots",
	entries.length === mutationSnapshotCount &&
		unchangedEdit.details.todos.at(-1)?.text === "Edited beta" &&
		unchangedMove.details.todos.at(-1)?.id === betaId &&
		missingRemove.details.error === "#999 not found",
	JSON.stringify({
		mutationSnapshotCount,
		entries: entries.length,
		unchangedEdit,
		unchangedMove,
		missingRemove,
	}),
);

assert(
	"todo helpers normalize legacy done flags and cycle all three statuses",
	normalizeTodo({ id: 1, text: "legacy open", done: false })?.status === "open" &&
		normalizeTodo({ id: 2, text: "legacy done", done: true })?.status === "done" &&
		normalizeTodo({ id: 3, text: "modern", status: "in_progress" })?.status === "in_progress" &&
		cycleTodoStatus("open") === "in_progress" &&
		cycleTodoStatus("in_progress") === "done" &&
		cycleTodoStatus("done") === "open" &&
		todoStatusGlyph("open") === "○" &&
		todoStatusGlyph("in_progress") === "◐" &&
		todoStatusGlyph("done") === "✓",
	"helper mismatch",
);

let cycled: Array<{ id: number; text: string; status: string }> = [];
const cycleView = new TodoListComponent(
	[
		{ id: 1, text: "First", status: "open" },
		{ id: 2, text: "Second", status: "open" },
	],
	theme,
	() => undefined,
	{ terminal: { rows: 12 }, requestRender: () => undefined } as any,
	(next) => {
		cycled = next;
	},
);
cycleView.handleInput(" ");
const afterStart = cycleView.render(40).join("\n");
cycleView.handleInput("\u001b[B");
cycleView.handleInput(" ");
cycleView.handleInput(" ");
assert(
	"todo UI Space cycles selected item through open, in progress, and done",
	cycled[0]?.status === "in_progress" &&
		cycled[1]?.status === "done" &&
		afterStart.includes("◐") &&
		afterStart.includes("in progress"),
	JSON.stringify({ cycled, afterStart }),
);

let reordered: Array<{ id: number; text: string; status: string }> = [];
const actions: Array<{ type: string; id: number }> = [];
const managementView = new TodoListComponent(
	[
		{ id: 10, text: "First", status: "open" },
		{ id: 20, text: "Second", status: "open" },
		{ id: 30, text: "Third", status: "open" },
	],
	theme,
	() => undefined,
	{ terminal: { rows: 14 }, requestRender: () => undefined } as any,
	(next) => {
		reordered = next;
	},
	(action) => {
		actions.push(action);
	},
);
managementView.handleInput("\u001b[1;2B");
managementView.handleInput("e");
managementView.handleInput("\u001b[3~");
const managedView = managementView.render(60).join("\n");
assert(
	"todo UI reorders and emits edit and remove actions for the selected item",
	reordered.map((todo) => todo.id).join(",") === "20,10,30" &&
		actions.map((action) => `${action.type}:${action.id}`).join(",") === "edit:10,remove:10" &&
		managedView.includes("Shift+↑↓") &&
		managedView.includes("edit") &&
		managedView.includes("remove"),
	JSON.stringify({ reordered, actions, managedView }),
);

await clearCommand.handler("", clearCtx);
const uiSeed = await run("add", { items: ["UI first", "UI second", "UI third"] });
const [uiFirstId, uiSecondId] = uiSeed.details.todos.map((todo: any) => todo.id);
let reorderDialogCalls = 0;
await todoCommand.handler(
	"",
	context({
		ui: {
			...context().ui,
			custom: async (factory: any) => {
				reorderDialogCalls++;
				let result: any;
				const component = factory(
					{ terminal: { rows: 14 }, requestRender: () => undefined },
					theme,
					undefined,
					(value: any) => {
						result = value;
					},
				);
				component.handleInput("\u001b[1;2B");
				component.handleInput("\u001b");
				return result;
			},
		},
	}),
);
assert(
	"/todos persists keyboard reordering",
	reorderDialogCalls === 1 &&
		(await run("list")).details.todos
			.map((todo: any) => todo.id)
			.slice(0, 2)
			.join(",") === `${uiSecondId},${uiFirstId}`,
	JSON.stringify({ reorderDialogCalls, list: await run("list") }),
);

let editDialogCalls = 0;
await todoCommand.handler(
	"",
	context({
		ui: {
			...context().ui,
			custom: async (factory: any) => {
				editDialogCalls++;
				let result: any;
				const component = factory(
					{ terminal: { rows: 14 }, requestRender: () => undefined },
					theme,
					undefined,
					(value: any) => {
						result = value;
					},
				);
				component.handleInput(editDialogCalls === 1 ? "e" : "\u001b");
				return result;
			},
			editor: async () => "Edited in UI",
		},
	}),
);
assert(
	"/todos edits the selected todo and returns to the list",
	editDialogCalls === 2 && (await run("list")).details.todos[0].text === "Edited in UI",
	JSON.stringify({ editDialogCalls, list: await run("list") }),
);

let removeDialogCalls = 0;
let removeConfirmCalls = 0;
await todoCommand.handler(
	"",
	context({
		ui: {
			...context().ui,
			custom: async (factory: any) => {
				removeDialogCalls++;
				let result: any;
				const component = factory(
					{ terminal: { rows: 14 }, requestRender: () => undefined },
					theme,
					undefined,
					(value: any) => {
						result = value;
					},
				);
				component.handleInput(removeDialogCalls === 1 ? "\u001b[3~" : "\u001b");
				return result;
			},
			confirm: async () => {
				removeConfirmCalls++;
				return true;
			},
		},
	}),
);
assert(
	"/todos confirms removal and returns to the remaining list",
	removeDialogCalls === 2 &&
		removeConfirmCalls === 1 &&
		!(await run("list")).details.todos.some((todo: any) => todo.id === uiSecondId),
	JSON.stringify({ removeDialogCalls, removeConfirmCalls, list: await run("list") }),
);
