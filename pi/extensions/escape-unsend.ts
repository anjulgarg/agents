/**
 * Escape-to-unsend: if Escape aborts a turn before any assistant tokens or
 * tools, branch away from the prompt (like /tree on that user message) and
 * put the text back in the editor.
 *
 * navigateTree is only on ExtensionCommandContext (slash commands). Event
 * handlers cannot call it safely, and patching ExtensionRunner fails under
 * jiti's module isolation. After settle we submit `/escape-unsend` through the
 * editor so the main loop runs session.prompt() with a real command context.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorComponent } from "@earendil-works/pi-tui";

type PendingPrompt = {
	entryId: string;
	text: string;
};

type BranchEntry = {
	id: string;
	type: string;
	message?: { role?: string; content?: unknown };
};

const UNSEND_COMMAND = "escape-unsend";

/** Flatten user/assistant message content into plain text. */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: unknown; thinking?: unknown };
			if (block.type === "text") return String(block.text ?? "");
			if (block.type === "thinking") return String(block.thinking ?? block.text ?? "");
			return "";
		})
		.join("");
}

/** True once the assistant has emitted text, thinking, or a tool call. */
export function assistantHasProgress(message: { content?: unknown }): boolean {
	const content = message.content;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: string; text?: unknown; thinking?: unknown };
		if (block.type === "text" && String(block.text ?? "").trim()) return true;
		if (block.type === "thinking" && String(block.thinking ?? block.text ?? "").trim()) {
			return true;
		}
		if (block.type === "toolCall" || block.type === "toolUse") return true;
	}
	return false;
}

export function findLatestUserPrompt(
	branch: ReadonlyArray<BranchEntry>,
): PendingPrompt | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = messageText(entry.message.content).trim();
		if (!text) continue;
		return { entryId: entry.id, text };
	}
	return undefined;
}

/**
 * Resolve the prompt to unsend from the branch.
 * Prefer the latest user entry matching expectedText (from user message_end);
 * fall back to the latest user prompt.
 */
export function resolvePendingPrompt(
	branch: ReadonlyArray<BranchEntry>,
	expectedText?: string,
): PendingPrompt | undefined {
	const wanted = expectedText?.trim();
	if (wanted) {
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const text = messageText(entry.message.content).trim();
			if (text === wanted) return { entryId: entry.id, text };
		}
	}
	return findLatestUserPrompt(branch);
}

export function shouldUnsend(input: {
	stopReason: unknown;
	producedWork: boolean;
	escapeRequested: boolean;
	pending: PendingPrompt | undefined;
	mode: string | undefined;
}): boolean {
	return (
		input.mode === "tui" &&
		input.stopReason === "aborted" &&
		input.escapeRequested &&
		!input.producedWork &&
		Boolean(input.pending?.entryId && input.pending.text)
	);
}

async function performUnsend(ctx: ExtensionCommandContext, prompt: PendingPrompt): Promise<void> {
	await ctx.waitForIdle();
	const result = await ctx.navigateTree(prompt.entryId, { summarize: false });
	if (result.cancelled) return;
	// Interactive navigateTree only restores editorText when the editor is empty;
	// always put the prompt back so Escape-to-unsend is predictable.
	ctx.ui.setEditorText(prompt.text);
}

export default function escapeUnsend(pi: ExtensionAPI): void {
	let pendingText: string | undefined;
	let pending: PendingPrompt | undefined;
	let producedWork = false;
	let escapeRequested = false;
	let unsendOnSettle = false;
	let unsending = false;
	let liveEditor: EditorComponent | undefined;
	let terminalInputUnsubscribe: (() => void) | undefined;

	const markProgress = (message?: { content?: unknown }): void => {
		if (message && assistantHasProgress(message)) producedWork = true;
	};

	const refreshPending = (ctx: ExtensionContext): PendingPrompt | undefined => {
		pending = resolvePendingPrompt(ctx.sessionManager.getBranch(), pendingText);
		return pending;
	};

	const wrapEditor = (ctx: ExtensionContext): void => {
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings);
			liveEditor = editor;
			return editor as EditorComponent;
		});
	};

	const queueUnsendCommand = (): boolean => {
		const submit = liveEditor?.onSubmit;
		if (!submit) return false;
		void Promise.resolve(submit(`/${UNSEND_COMMAND}`)).catch(() => undefined);
		return true;
	};

	pi.registerCommand(UNSEND_COMMAND, {
		description: "Restore the last Escape-aborted prompt into the editor",
		handler: async (_args, ctx) => {
			const prompt = refreshPending(ctx) ?? findLatestUserPrompt(ctx.sessionManager.getBranch());
			if (!prompt) {
				ctx.ui.notify("Nothing to unsend", "info");
				unsending = false;
				return;
			}
			pending = undefined;
			pendingText = undefined;
			unsendOnSettle = false;
			try {
				await performUnsend(ctx, prompt);
			} finally {
				unsending = false;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		pending = undefined;
		pendingText = undefined;
		producedWork = false;
		escapeRequested = false;
		unsendOnSettle = false;
		unsending = false;
		liveEditor = undefined;
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = undefined;
		if (ctx.mode === "tui") {
			wrapEditor(ctx);
			terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				if (matchesKey(data, "escape") && !ctx.isIdle()) escapeRequested = true;
			});
		}
	});

	pi.on("before_agent_start", () => {
		// This is the top-level prompt boundary. agent_start is only a low-level
		// run and can fire again for retries, compaction retries, or continuations.
		pending = undefined;
		pendingText = undefined;
		producedWork = false;
		escapeRequested = false;
		unsendOnSettle = false;
	});

	pi.on("agent_start", () => {
		// Preserve producedWork across low-level retries and continuations, but
		// only consider Escape input from this specific low-level run.
		escapeRequested = false;
		unsendOnSettle = false;
	});

	pi.on("message_update", (event) => {
		if (event.message.role === "assistant") markProgress(event.message);
	});

	pi.on("tool_execution_start", () => {
		producedWork = true;
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "user") {
			// Content is available, but appendMessage runs after this handler —
			// only remember the text; resolve entryId once the user is on the branch.
			pendingText = messageText(event.message.content).trim() || undefined;
			return;
		}
		if (event.message.role !== "assistant") return;
		markProgress(event.message);
		// Prior user message_end has already been persisted, so the branch is current.
		refreshPending(ctx);
		unsendOnSettle = shouldUnsend({
			stopReason: event.message.stopReason,
			producedWork,
			escapeRequested,
			pending,
			mode: ctx.mode,
		});
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!unsendOnSettle || unsending) {
			escapeRequested = false;
			return;
		}
		if (!refreshPending(ctx)) {
			unsendOnSettle = false;
			escapeRequested = false;
			return;
		}

		unsendOnSettle = false;
		escapeRequested = false;
		unsending = true;

		// Let the main loop return to getUserInput (or accept pendingUserInputs)
		// before submitting the slash command.
		setTimeout(() => {
			if (!queueUnsendCommand()) {
				unsending = false;
				ctx.ui.notify("Could not unsend: editor submit unavailable", "error");
			}
		}, 0);
	});
}
