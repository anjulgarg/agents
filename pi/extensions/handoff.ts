import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const HANDOFF_COMMAND = "handoff";
export const MAX_HANDOFF_LENGTH = 24_000;

export const HANDOFF_REQUEST = `Create and activate a handoff to a fresh Pi session now. This request authorizes session replacement, so do not ask for confirmation.

Before calling the handoff tool:
1. Inspect the active todo list when available. Preserve IDs and statuses for every pending or in-progress task.
2. Inspect concise repository state when inside a repository. Record the branch or detached state, changed paths, and relevant untracked files without copying large diffs.
3. Reconcile conversation and tool evidence. Separate verified completed work from pending work. Never claim a check passed unless its result is present.
4. Exclude credentials, tokens, private runtime state, raw session history, and speculative tasks.

Provide one concise, self-contained Markdown handoff with these sections: Objective, Completed, Pending tasks, Working context, Verification, Blockers and risks, and Next action. Include exact paths, commands, errors, IDs, decisions, and constraints needed for safe continuation. Use "None" or "None known" for empty sections.

End the handoff with this continuation instruction: "Continue from this handoff autonomously. Revalidate repository state before editing, preserve unrelated changes, keep the todo list synchronized, and do not repeat completed work."

Call the handoff tool exactly once with the complete Markdown handoff. Treat a successful call as terminal for this session and do not send a normal final response afterward.`;

export const HANDOFF_PROMPT_GUIDELINES = [
	"Start session handoffs with the /handoff command. Call the handoff tool only while that command's generated request is active.",
	"Before calling handoff, inspect available todo state and concise repository state, then distinguish verified completed work from ordered pending work without exposing credentials or raw session history.",
	"The handoff argument must be concise, self-contained Markdown covering Objective, Completed, Pending tasks, Working context, Verification, Blockers and risks, and Next action, followed by an instruction to continue autonomously.",
	"Call handoff exactly once after preparing the summary. A successful handoff call is terminal for the old session, so do not send a normal final response afterward.",
] as const;

interface PendingHandoff {
	prepared: boolean;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
}

export default function handoffExtension(pi: ExtensionAPI) {
	let pending: PendingHandoff | undefined;

	pi.on("agent_settled", () => {
		if (pending && !pending.prepared) {
			pending.reject(new Error("the agent settled without preparing a handoff"));
		}
	});

	pi.registerCommand(HANDOFF_COMMAND, {
		description: "Summarize pending work and continue in a fresh active session",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Session handoff requires Pi interactive mode.", "error");
				return;
			}
			if (pending) {
				ctx.ui.notify("A session handoff is already in progress.", "error");
				return;
			}

			let resolvePrepared!: (text: string) => void;
			let rejectPrepared!: (error: Error) => void;
			const prepared = new Promise<string>((resolve, reject) => {
				resolvePrepared = resolve;
				rejectPrepared = reject;
			});
			const flow: PendingHandoff = {
				prepared: false,
				resolve: resolvePrepared,
				reject: rejectPrepared,
			};
			pending = flow;

			const focus = args.trim();
			const request = focus
				? `${HANDOFF_REQUEST}\n\nRequested focus for the handoff: ${focus}`
				: HANDOFF_REQUEST;

			try {
				pi.sendUserMessage(request, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				const handoff = await prepared;
				await ctx.waitForIdle();
				const parentSession = ctx.sessionManager.getSessionFile();
				const result = await ctx.newSession({
					parentSession,
					withSession: async (replacementCtx) => {
						await replacementCtx.sendUserMessage(handoff);
					},
				});

				if (result.cancelled) {
					ctx.ui.notify("Session handoff cancelled. The current session remains active.", "info");
				}
			} catch (error) {
				ctx.ui.notify(
					`Session handoff did not complete: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} finally {
				if (pending === flow) pending = undefined;
			}
		},
	});

	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Finalize the active /handoff command by returning its prepared work summary for submission in a new active Pi session.",
		promptSnippet: "Return the prepared summary to the active /handoff command",
		promptGuidelines: [...HANDOFF_PROMPT_GUIDELINES],
		parameters: Type.Object({
			handoff: Type.String({
				description: "Complete self-contained Markdown handoff for the replacement session",
				minLength: 1,
				maxLength: MAX_HANDOFF_LENGTH,
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				throw new Error("Session handoff requires Pi interactive mode.");
			}
			if (signal?.aborted) throw new Error("Session handoff was cancelled.");
			if (!pending) throw new Error("No /handoff command is awaiting a summary.");
			if (pending.prepared) throw new Error("A session handoff summary is already prepared.");

			const text = params.handoff.trim();
			if (!text) throw new Error("Session handoff cannot be empty.");

			pending.prepared = true;
			pending.resolve(text);
			return {
				content: [{ type: "text", text: "Prepared handoff for session replacement." }],
				details: {},
				terminate: true,
			};
		},
	});
}
