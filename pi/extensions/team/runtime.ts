import type { Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { getScopedSubagentModels, modelKey } from "../subagent/models.ts";
import {
	type SubagentUpdate,
	THINKING_LEVELS,
	type TeamAgentConfig,
	type TeamDefinition,
	type TeamRun,
	type TeamStateDetails,
	type TeamTask,
	WORKSPACE_MODES,
} from "./contracts.ts";
import { validateTaskGraph } from "./config.ts";

export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const TEAM_MANAGER_CONTEXT_TYPE = "team-manager-context";

const TEAM_MANAGER_CONTEXT_END_MARKER = `[TEAM MANAGER MODE DEACTIVATED]
This hidden team-manager-context message is the authoritative supersession marker. It supersedes every older team-manager-context snapshot and any conflicting team state in the conversation. There is no active team manager run; do not coordinate team work or call team_plan, team_retry, or team_complete until a new team run is started.`;

export interface TeamExtensionOptions {
	/** Inject team definitions (tests); production loads from the agent teams directory. */
	teams?: Map<string, TeamDefinition>;
	/**
	 * Hard-kill running subagent children for the given run IDs.
	 * Omit runIds to kill every tracked run. Production uses killSubagentRuns
	 * from the subagent extension.
	 */
	killSubagentRuns?: (runIds?: readonly string[], manualKill?: boolean) => number;
}

export interface TeamRuntimeOptions {
	pi: ExtensionAPI;
	teams: Map<string, TeamDefinition>;
	killSubagentRuns: (runIds?: readonly string[], manualKill?: boolean) => number;
}

export interface ProposedTeamTask {
	id: string;
	title: string;
	description: string;
	role: string;
	dependsOn?: string[];
	model?: string;
	thinking?: (typeof THINKING_LEVELS)[number];
	workspace?: (typeof WORKSPACE_MODES)[number];
}

export interface TeamPlanInput {
	summary: string;
	tasks: ProposedTeamTask[];
}

export interface TeamRetryInput {
	taskIds: string[];
	reason: string;
	userApprovedManualRetry?: boolean;
}

export interface TeamCompleteInput {
	success: boolean;
	summary: string;
}

export type TeamPlanChoice = "approve" | "revise" | "cancel" | undefined;

export type TeamPlanReviewer = (
	teamName: string,
	summary: string,
	tasks: TeamTask[],
) => Promise<TeamPlanChoice>;

interface TeamToolCallEvent {
	toolName: string;
	toolCallId: string;
	input: unknown;
}

interface TeamToolExecutionEndEvent {
	toolName: string;
	toolCallId: string;
	isError?: boolean;
}

interface TeamReservation {
	runId: string;
	taskIds: string[];
}

/**
 * Hard-kill subagent children for the given running tasks.
 * Shared by /team-cancel and the /teams dashboard kill key.
 * Returns the running tasks that were targeted (caller marks them failed).
 */
function killRunningTaskChildren(
	tasks: TeamTask[],
	killRuns: (runIds?: readonly string[], manualKill?: boolean) => number,
	manualKill = false,
): TeamTask[] {
	const running = tasks.filter((item) => item.status === "running");
	if (running.length === 0) return [];
	const subagentRunIds = [
		...new Set(
			running
				.map((item) => item.subagentRunId)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		),
	];
	// Children outlive the subagent tool call; aborting the manager alone
	// does not kill them. Route through the subagent kill surface first.
	// If any running task has no subagentRunId yet (spawn in flight), kill all.
	const spawnInFlight = running.some((item) => !item.subagentRunId);
	if (spawnInFlight) killRuns(undefined, manualKill);
	else killRuns(subagentRunIds, manualKill);
	return running;
}

/** Mark previously-running team tasks as failed with a cancel reason. */
function markTasksCancelled(tasks: TeamTask[], reason: string, manualKill = false): void {
	const finishedAt = Date.now();
	for (const task of tasks) {
		task.status = "failed";
		task.error = reason;
		task.manualKill = manualKill;
		task.finishedAt = finishedAt;
	}
}

async function resolveModel(
	requested: string,
	ctx: ExtensionContext,
	scoped = true,
): Promise<Model<any>> {
	const available = scoped ? await getScopedSubagentModels(ctx) : ctx.modelRegistry.getAvailable();
	const lower = requested.toLowerCase();
	const exact = available.filter(
		(model) => modelKey(model).toLowerCase() === lower || model.id.toLowerCase() === lower,
	);
	if (exact.length === 1) return exact[0];
	throw new Error(
		`Unavailable or ambiguous team model "${requested}". Available: ${available.map(modelKey).join(", ")}`,
	);
}

function taskCounts(run: TeamRun): { completed: number; running: number; failed: number } {
	return {
		completed: run.tasks.filter((task) => task.status === "completed").length,
		running: run.tasks.filter((task) => task.status === "running").length,
		failed: run.tasks.filter((task) => task.status === "failed").length,
	};
}

export class TeamRuntime {
	private readonly pi: ExtensionAPI;
	private readonly teams: Map<string, TeamDefinition>;
	private readonly killRuns: (runIds?: readonly string[], manualKill?: boolean) => number;
	private readonly runs = new Map<string, TeamRun>();
	private readonly listeners = new Set<() => void>();
	private readonly reservations = new Map<string, TeamReservation>();
	private readonly teamToolNames = new Set(["team_plan", "team_retry", "team_complete"]);
	private activeRunId: string | undefined;
	private activeContext: ExtensionContext | undefined;
	private restoreAfterSettled = false;
	private managerContextEndPending = false;

	constructor(options: TeamRuntimeOptions) {
		this.pi = options.pi;
		this.teams = options.teams;
		this.killRuns = options.killSubagentRuns;
	}

	teamEntries(): IterableIterator<[string, TeamDefinition]> {
		return this.teams.entries();
	}

	allRuns(): TeamRun[] {
		return [...this.runs.values()];
	}

	activeRun(): TeamRun | undefined {
		return this.activeRunId ? this.runs.get(this.activeRunId) : undefined;
	}

	activeTeam(): TeamDefinition | undefined {
		const run = this.activeRun();
		return run ? this.teams.get(run.teamName) : undefined;
	}

	setActiveContext(ctx: ExtensionContext): void {
		this.activeContext = ctx;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	persist(run: TeamRun): void {
		run.updatedAt = Date.now();
		this.pi.appendEntry("team-state", { run });
		this.notify();
		this.emitTeamState(run);
		this.updateStatus(this.activeContext);
	}

	setTeamToolsActive(enabled: boolean): void {
		if (!enabled) return;
		this.pi.setActiveTools([
			...new Set([...this.pi.getActiveTools(), ...this.teamToolNames, "question"]),
		]);
	}

	private clearTeamToolsForInactiveSession(): void {
		this.pi.setActiveTools(
			this.pi.getActiveTools().filter((name) => !this.teamToolNames.has(name)),
		);
	}

	async startTeam(name: string, goal: string, ctx: ExtensionCommandContext): Promise<void> {
		this.activeContext = ctx;
		const team = this.teams.get(name);
		if (!team) throw new Error(`Unknown team: ${name}`);
		await ctx.waitForIdle();
		const current = this.activeRun();
		if (current && !TERMINAL_RUN_STATUSES.has(current.status)) {
			const replace = await ctx.ui.confirm(
				"Replace active team?",
				`${current.teamName} is still ${current.status}. Cancel it and start ${name}?`,
			);
			if (!replace) return;
			current.status = "cancelled";
			this.persist(current);
			await this.restoreRunSettings(current, ctx);
		}
		const originalModel = ctx.model ? modelKey(ctx.model) : undefined;
		const originalThinking = this.pi.getThinkingLevel();
		const managerModel = await resolveModel(team.manager.model, ctx);
		if (!(await this.pi.setModel(managerModel)))
			throw new Error(`No API credentials for ${team.manager.model}`);
		this.pi.setThinkingLevel(team.manager.thinking);
		const run: TeamRun = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
			teamName: name,
			goal,
			status: "planning",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			tasks: [],
			originalModel,
			originalThinking,
		};
		this.runs.set(run.id, run);
		this.activeRunId = run.id;
		this.managerContextEndPending = false;
		this.setTeamToolsActive(true);
		this.persist(run);
		this.pi.sendUserMessage(goal);
	}

	async planTeam(
		params: TeamPlanInput,
		ctx: ExtensionContext,
		review: TeamPlanReviewer,
	): Promise<{
		content: [{ type: "text"; text: string }];
		details: TeamStateDetails;
	}> {
		this.activeContext = ctx;
		const run = this.activeRun();
		const team = this.activeTeam();
		if (!run || !team) throw new Error("No active team. Start one with /team:<name> <goal>");
		if (run.tasks.some((task) => task.status === "running"))
			throw new Error("Wait for running team tasks before revising the plan");
		validateTaskGraph(params.tasks);
		const previousTasks = run.tasks;
		const previousStatus = run.status;
		const resolved: TeamTask[] = [];
		const selectedRoleModels = new Map<string, string>();
		for (const proposed of params.tasks) {
			const role = team.roles[proposed.role];
			if (!role)
				throw new Error(
					`Unknown role ${proposed.role}. Available: ${Object.keys(team.roles).join(", ")}`,
				);
			const requestedModel = proposed.model ?? selectedRoleModels.get(proposed.role);
			const model = await this.chooseModel(requestedModel, proposed.role, role, team, ctx);
			if (role.modelPolicy === "ask" && !proposed.model)
				selectedRoleModels.set(proposed.role, model);
			const thinking = proposed.thinking ?? role.thinking ?? team.defaults?.thinking ?? "medium";
			const workspace =
				proposed.workspace ?? role.workspace ?? team.defaults?.workspace ?? "shared";
			resolved.push({
				id: proposed.id,
				title: proposed.title,
				description: proposed.description,
				role: proposed.role,
				dependsOn: proposed.dependsOn ?? [],
				model,
				thinking,
				workspace,
				tools: role.tools,
				status: (proposed.dependsOn?.length ?? 0) > 0 ? "blocked" : "pending",
			});
		}
		const reviewTasks = resolved.filter((task) => team.roles[task.role]?.review);
		const verificationTasks = resolved.filter((task) => team.roles[task.role]?.verification);
		if (reviewTasks.length === 0)
			throw new Error("Team plan requires at least one task assigned to a review role");
		if (verificationTasks.length === 0)
			throw new Error("Team plan requires at least one task assigned to a verification role");
		if (reviewTasks.some((task) => task.dependsOn.length === 0))
			throw new Error("Review tasks must depend on work they independently review");
		if (verificationTasks.some((task) => task.dependsOn.length === 0))
			throw new Error("Verification tasks must depend on work they verify");
		run.status = "awaiting_approval";
		run.planSummary = params.summary;
		run.tasks = resolved;
		this.persist(run);

		let approved = true;
		let feedback: string | undefined;
		if (team.limits?.requirePlanApproval !== false) {
			if (ctx.mode !== "tui") throw new Error("This team requires interactive plan approval");
			const choice = await review(team.name, params.summary, resolved);
			if (choice === "revise") {
				approved = false;
				feedback =
					(await ctx.ui.input("Plan changes", "Describe required changes"))?.trim() ||
					"Revise the plan.";
				run.status = "planning";
			} else if (choice !== "approve") {
				approved = false;
				feedback = "User cancelled the team run.";
				run.status = "cancelled";
			}
		}
		if (approved) {
			const previousById = new Map(previousTasks.map((task) => [task.id, task]));
			run.tasks = resolved.map((task) => {
				const previous = previousById.get(task.id);
				return previous?.status === "completed"
					? {
							...task,
							status: "completed",
							subagentRunId: previous.subagentRunId,
							subagentTaskId: previous.subagentTaskId,
							startedAt: previous.startedAt,
							finishedAt: previous.finishedAt,
							output: previous.output,
							usage: previous.usage,
						}
					: task;
			});
			for (const task of run.tasks.filter((item) => item.status === "blocked")) {
				if (
					task.dependsOn.every(
						(id) => run.tasks.find((item) => item.id === id)?.status === "completed",
					)
				)
					task.status = "pending";
			}
			run.status = "executing";
		} else if (run.status !== "cancelled") {
			run.tasks = previousTasks;
			run.status = previousTasks.length ? previousStatus : "planning";
		}
		if (run.status === "cancelled") this.managerContextEndPending = true;
		this.persist(run);
		if (run.status === "cancelled") await this.restoreRunSettings(run, ctx);
		const details: TeamStateDetails = { run: structuredClone(run), approved, feedback };
		if (!approved) return { content: [{ type: "text", text: feedback! }], details };
		const ready = run.tasks.filter((task) => task.status === "pending");
		return {
			content: [
				{
					type: "text",
					text: `Plan approved. Team run ID: ${run.id}. Ready tasks:\n${ready.map((task) => `- ${task.id} (${task.role}): use model ${task.model}, thinking ${task.thinking}, workspace ${task.workspace}`).join("\n")}\n\nDelegate ready tasks with subagent tasks and include teamRunId="${run.id}", teamTaskId, and role on every task. The harness injects completed dependency outputs directly into dependent task prompts. Delegation returns immediately; you will be woken when tasks complete - do not poll. On wake, delegate newly unblocked review and verification tasks.`,
				},
			],
			details,
		};
	}

	async retryTeam(
		params: TeamRetryInput,
		ctx: ExtensionContext,
	): Promise<{
		content: [{ type: "text"; text: string }];
		details: TeamStateDetails;
	}> {
		this.activeContext = ctx;
		const run = this.activeRun();
		if (!run || run.status !== "executing") throw new Error("No executing team run");
		const unique = new Set(params.taskIds);
		if (unique.size !== params.taskIds.length) throw new Error("Duplicate task IDs in team_retry");
		for (const taskId of unique) {
			const task = run.tasks.find((item) => item.id === taskId);
			if (!task) throw new Error(`Unknown team task ${taskId}`);
			if (task.status !== "failed")
				throw new Error(`Team task ${taskId} is ${task.status}, not failed`);
			if (task.manualKill && params.userApprovedManualRetry !== true) {
				throw new Error(
					`Retry blocked for ${taskId}: the user manually killed this task. Discuss it with the user and obtain explicit approval before calling team_retry with userApprovedManualRetry=true.`,
				);
			}
		}
		for (const taskId of unique) {
			const task = run.tasks.find((item) => item.id === taskId)!;
			task.status = task.dependsOn.every(
				(id) => run.tasks.find((item) => item.id === id)?.status === "completed",
			)
				? "pending"
				: "blocked";
			task.error = undefined;
			task.manualKill = undefined;
			task.output = undefined;
			task.subagentRunId = undefined;
			task.subagentTaskId = undefined;
			task.startedAt = undefined;
			task.finishedAt = undefined;
		}
		this.persist(run);
		return {
			content: [
				{
					type: "text",
					text: `Reset tasks for retry: ${[...unique].join(", ")}. Reason: ${params.reason}`,
				},
			],
			details: { run: structuredClone(run) } as TeamStateDetails,
		};
	}

	async completeTeam(
		params: TeamCompleteInput,
		ctx: ExtensionContext,
	): Promise<{
		content: [{ type: "text"; text: string }];
		details: TeamStateDetails;
	}> {
		this.activeContext = ctx;
		const run = this.activeRun();
		if (!run) throw new Error("No active team");
		const unfinished = run.tasks.filter(
			(task) => task.status === "pending" || task.status === "blocked" || task.status === "running",
		);
		if (params.success && unfinished.length)
			throw new Error(
				`Cannot report success with unfinished tasks: ${unfinished.map((task) => task.id).join(", ")}`,
			);
		const team = this.activeTeam();
		if (params.success && team) {
			const completedReview = run.tasks.some(
				(task) => team.roles[task.role]?.review && task.status === "completed",
			);
			const completedVerification = run.tasks.some(
				(task) => team.roles[task.role]?.verification && task.status === "completed",
			);
			if (!completedReview || !completedVerification)
				throw new Error(
					"Cannot report success without completed independent review and verification tasks",
				);
		}
		run.status = params.success ? "completed" : "failed";
		run.completionSummary = params.summary;
		this.managerContextEndPending = true;
		this.persist(run);
		this.restoreAfterSettled = true;
		return {
			content: [{ type: "text", text: `${run.teamName} team ${run.status}: ${params.summary}` }],
			details: { run: structuredClone(run) } as TeamStateDetails,
		};
	}

	async cancelActiveTeam(ctx: ExtensionCommandContext): Promise<void> {
		this.activeContext = ctx;
		const run = this.activeRun();
		if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
			ctx.ui.notify("No active team to cancel.", "warning");
			return;
		}
		const killed = killRunningTaskChildren(run.tasks, this.killRuns);
		ctx.abort();
		await ctx.waitForIdle();
		markTasksCancelled(killed, "Cancelled with the team run");
		run.status = "cancelled";
		this.managerContextEndPending = true;
		this.persist(run);
		await this.restoreRunSettings(run, ctx);
	}

	killDashboardTask(runId: string, taskId: string): void {
		const run = this.runs.get(runId);
		const task = run?.tasks.find((item) => item.id === taskId);
		if (!run || !task || task.status !== "running") return;
		const killed = killRunningTaskChildren([task], this.killRuns, true);
		markTasksCancelled(
			killed,
			"Manually killed by the user. Do not retry or redelegate this task until the user explicitly approves a retry.",
			true,
		);
		this.persist(run);
	}

	reserveDelegation(event: TeamToolCallEvent): { block: true; reason: string } | undefined {
		if (event.toolName !== "subagent") return;
		const run = this.activeRun();
		const team = this.activeTeam();
		if (!run || !team || run.status !== "executing") return;
		const input = event.input as { tasks?: Array<Record<string, any>>; maxConcurrency?: number };
		if (!input.tasks?.length)
			return {
				block: true,
				reason: "Active team delegation must use subagent tasks with team metadata",
			};
		if (input.tasks.length > (team.limits?.maxConcurrency ?? 8))
			return { block: true, reason: "Team concurrency limit exceeded" };
		const runningByRole = new Map<string, number>();
		const delegatedTaskIds = new Set<string>();
		const approvedTasks: TeamTask[] = [];
		for (const task of run.tasks.filter((item) => item.status === "running"))
			runningByRole.set(task.role, (runningByRole.get(task.role) ?? 0) + 1);
		for (const spec of input.tasks) {
			if (spec.teamRunId !== run.id || typeof spec.teamTaskId !== "string")
				return {
					block: true,
					reason: `Every team subagent task must include teamRunId=${run.id} and teamTaskId`,
				};
			if (delegatedTaskIds.has(spec.teamTaskId))
				return { block: true, reason: `Duplicate team task ${spec.teamTaskId} in one delegation` };
			delegatedTaskIds.add(spec.teamTaskId);
			const task = run.tasks.find((item) => item.id === spec.teamTaskId);
			if (!task) return { block: true, reason: `Unknown team task ${spec.teamTaskId}` };
			if (task.status !== "pending")
				return { block: true, reason: `Team task ${task.id} is ${task.status}, not ready` };
			const incomplete = task.dependsOn.filter(
				(id) => run.tasks.find((item) => item.id === id)?.status !== "completed",
			);
			if (incomplete.length)
				return {
					block: true,
					reason: `Team task ${task.id} is blocked by ${incomplete.join(", ")}`,
				};
			const role = team.roles[task.role];
			const count = (runningByRole.get(task.role) ?? 0) + 1;
			if (count > (role.maxInstances ?? 1))
				return {
					block: true,
					reason: `Role ${task.role} exceeds maxInstances=${role.maxInstances ?? 1}`,
				};
			runningByRole.set(task.role, count);
			spec.role = task.role;
			spec.model = task.model;
			spec.thinking = task.thinking;
			spec.workspace = task.workspace;
			if (task.tools) spec.tools = task.tools;
			// Trusted team config only; strip any manager-supplied value first.
			delete spec.roleInstructions;
			if (role.instructions) spec.roleInstructions = role.instructions;
			const dependencies = task.dependsOn.map((dependencyId) =>
				run.tasks.find((item) => item.id === dependencyId)!,
			);
			const referenced = dependencies.filter(
				(dependency) => dependency.subagentRunId && dependency.subagentTaskId,
			);
			const legacy = dependencies.filter(
				(dependency) => !dependency.subagentRunId || !dependency.subagentTaskId,
			);
			spec.inputFrom = referenced.map((dependency) => ({
				runId: dependency.subagentRunId!,
				taskId: dependency.subagentTaskId!,
			}));
			// Pre-change persisted teams have output but no child task ID. Inject that
			// output internally without exposing it to the manager model.
			spec.handoffs = legacy.map((dependency) => ({
				source: `team:${run.id}/${dependency.id}`,
				output: dependency.output ?? "",
			}));
			spec.task = task.description;
			approvedTasks.push(task);
		}
		for (const task of approvedTasks) {
			task.status = "running";
			task.startedAt = Date.now();
		}
		input.maxConcurrency = Math.min(
			input.maxConcurrency ?? input.tasks.length,
			team.limits?.maxConcurrency ?? 8,
		);
		this.reservations.set(event.toolCallId, { runId: run.id, taskIds: [...delegatedTaskIds] });
		this.persist(run);
	}

	reconcileDelegationFailure(event: TeamToolExecutionEndEvent): void {
		if (event.toolName !== "subagent") return;
		const reservation = this.reservations.get(event.toolCallId);
		if (!reservation) return;
		this.reservations.delete(event.toolCallId);
		// Non-blocking subagent: tool_execution_end means spawn returned, not that
		// children finished. Completion arrives via subagent:update. This guard only
		// covers spawn-time failure — tasks still "running" without a subagentRunId
		// never received a successful spawn/update.
		if (!event.isError) return;
		const run = this.runs.get(reservation.runId);
		if (!run) return;
		for (const taskId of reservation.taskIds) {
			const task = run.tasks.find((item) => item.id === taskId);
			if (task?.status === "running" && !task.subagentRunId) {
				task.status = "failed";
				task.error = "Subagent delegation failed before execution";
				task.finishedAt = Date.now();
			}
		}
		this.persist(run);
	}

	syncSubagentUpdate(data: unknown): void {
		const details = data as SubagentUpdate;
		if (!details?.results) return;
		let changed = false;
		for (const result of details.results) {
			if (!result.teamRunId || !result.teamTaskId) continue;
			const run = this.runs.get(result.teamRunId);
			const task = run?.tasks.find((item) => item.id === result.teamTaskId);
			if (!run || !task) continue;
			const previous = task.status;
			task.subagentRunId = details.runId;
			if (result.taskId) task.subagentTaskId = result.taskId;
			task.output = result.output;
			task.error = result.error;
			task.manualKill = result.manualKill;
			task.usage = result.usage;
			if (!task.startedAt) task.startedAt = Date.now();
			task.status = result.done ? (result.error ? "failed" : "completed") : "running";
			if (result.done) task.finishedAt = Date.now();
			if (task.status !== previous) changed = true;
			if (result.done) {
				for (const blocked of run.tasks.filter((item) => item.status === "blocked")) {
					if (
						blocked.dependsOn.every(
							(id) => run.tasks.find((item) => item.id === id)?.status === "completed",
						)
					) {
						blocked.status = "pending";
						changed = true;
					}
				}
			}
			if (changed) this.persist(run);
		}
		this.notify();
	}

	managerPrompt(
		_systemPrompt: string,
		ctx: ExtensionContext,
	): { message: { customType: string; content: string; display: false } } | undefined {
		this.activeContext = ctx;
		const run = this.activeRun();
		const team = this.activeTeam();
		if (run && team && !TERMINAL_RUN_STATUSES.has(run.status)) {
			this.managerContextEndPending = false;
			const roster = Object.entries(team.roles)
				.map(
					([name, role]) =>
						`- ${name}: ${role.description} Default ${role.model ?? team.defaults?.model ?? "none"}:${role.thinking ?? team.defaults?.thinking ?? "medium"}; policy ${role.modelPolicy ?? "manager"}; max ${role.maxInstances ?? 1}`,
				)
				.join("\n");
			return {
				message: {
					customType: TEAM_MANAGER_CONTEXT_TYPE,
					display: false,
					content: `[TEAM MANAGER CONTEXT - AUTHORITATIVE CURRENT SNAPSHOT]\nThis hidden tail message supersedes every older team-manager-context snapshot and any conflicting team state in the conversation. Follow this snapshot for the current turn.\n\nTeam: ${team.name}\nRun ID: ${run.id}\nGoal: ${run.goal}\nStatus: ${run.status}\n\nTeam-specific manager instructions:\n${team.manager.instructions}\n\nRoster:\n${roster}\n\nManager protocol:\n1. Inspect enough repository context to plan safely.\n2. Submit the complete structured plan through team_plan before delegation. Include implementation, independent review, integration, and final verification tasks.\n3. Respect dependencies. Delegate only pending tasks whose dependencies are complete.\n4. Use subagent tasks mode for delegation. Every task must include teamRunId \"${run.id}\", teamTaskId, and role. The harness enforces approved model, thinking, tools, workspace, dependencies, and role concurrency, and injects completed dependency outputs directly into dependent prompts. Delegation returns immediately; continue useful work or end the turn - a wake arrives when tasks complete. Do not poll, and do not claim work is done before its wake. On wake, delegate newly unblocked pending tasks. Do not call subagent_result solely to relay output to dependent tasks; inspect results only when manager-side validation or synthesis requires it.\n5. Multiple instances of a role are allowed up to that role's maxInstances.\n6. Do not perform specialist implementation yourself. Coordinate, inspect, integrate worktree branches when needed, and respond to failures. Use team_retry before redelegating a failed task. If the user manually killed a task, do not retry or redelegate it until you discuss it with the user and receive explicit approval.\n7. Use question when a user decision materially changes the plan.\n8. Require configured review and verification roles before claiming success.\n9. Call team_complete only after integration and objective verification.`,
				},
			};
		}
		if (!this.managerContextEndPending) return;
		this.managerContextEndPending = false;
		return {
			message: {
				customType: TEAM_MANAGER_CONTEXT_TYPE,
				content: TEAM_MANAGER_CONTEXT_END_MARKER,
				display: false,
			},
		};
	}

	async onAgentSettled(ctx: ExtensionContext): Promise<void> {
		if (!this.restoreAfterSettled) return;
		this.restoreAfterSettled = false;
		const run = this.activeRun();
		if (!run) return;
		await this.restoreRunSettings(run, ctx);
		this.updateStatus(ctx);
	}

	restoreSession(ctx: ExtensionContext): void {
		this.activeContext = ctx;
		this.runs.clear();
		const sessionManager = ctx.sessionManager as {
			getBranch?: () => Array<{ type: string; customType?: string; data?: unknown }>;
			getEntries?: () => Array<{ type: string; customType?: string; data?: unknown }>;
		};
		const entries = sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? [];
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== "team-state") continue;
			const run = (entry.data as { run?: TeamRun } | undefined)?.run;
			if (run?.id && this.teams.has(run.teamName)) this.runs.set(run.id, run);
		}
		for (const run of this.runs.values()) {
			let interrupted = false;
			for (const task of run.tasks.filter((item) => item.status === "running")) {
				task.status = "failed";
				task.error = "Interrupted by session reload or process exit";
				task.finishedAt = Date.now();
				interrupted = true;
			}
			if (interrupted) this.persist(run);
		}
		const latestActive = [...this.runs.values()]
			.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
			.sort((a, b) => b.updatedAt - a.updatedAt)[0];
		this.activeRunId = latestActive?.id;
		this.managerContextEndPending = !latestActive && this.runs.size > 0;
		if (latestActive) this.emitTeamState(latestActive);
		if (this.runs.size > 0) this.setTeamToolsActive(true);
		else this.clearTeamToolsForInactiveSession();
		this.updateStatus(ctx);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private emitTeamState(run: TeamRun): void {
		this.pi.events.emit("team:state", {
			runId: run.id,
			teamName: run.teamName,
			status: run.status,
			active: run.id === this.activeRunId && !TERMINAL_RUN_STATUSES.has(run.status),
		});
	}

	private updateStatus(ctx: ExtensionContext | undefined): void {
		if (!ctx) return;
		const run = this.activeRun();
		if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
			ctx.ui.setStatus("team", undefined);
			return;
		}
		const counts = taskCounts(run);
		ctx.ui.setStatus(
			"team",
			ctx.ui.theme.fg("accent", `team:${run.teamName} ${counts.completed}/${run.tasks.length}`),
		);
	}

	private async restoreRunSettings(run: TeamRun, ctx: ExtensionContext): Promise<void> {
		if (run.originalModel) {
			try {
				await this.pi.setModel(await resolveModel(run.originalModel, ctx, false));
			} catch {}
		}
		if (run.originalThinking) this.pi.setThinkingLevel(run.originalThinking);
	}

	private async chooseModel(
		requested: string | undefined,
		roleName: string,
		role: TeamAgentConfig,
		team: TeamDefinition,
		ctx: ExtensionContext,
	): Promise<string> {
		const fallback = role.model ?? team.defaults?.model;
		const allowed = role.allowedModels?.length
			? role.allowedModels
			: role.modelPolicy === "fixed" && fallback
				? [fallback]
				: [];
		if (requested) {
			if (role.modelPolicy === "fixed" && fallback && requested !== fallback) {
				throw new Error(`Role ${roleName} is fixed to ${fallback}`);
			}
			if (allowed.length && !allowed.includes(requested))
				throw new Error(`Model ${requested} is not allowed for role ${roleName}`);
			return modelKey(await resolveModel(requested, ctx));
		}
		if (role.modelPolicy === "ask") {
			if (ctx.mode !== "tui")
				throw new Error(`Role ${roleName} requires interactive model selection`);
			const custom = "Custom model...";
			const choices = allowed.length
				? allowed
				: [...(await getScopedSubagentModels(ctx)).map(modelKey), custom];
			const choice = await ctx.ui.select(`Model for ${roleName}`, choices);
			if (!choice) throw new Error(`Model selection cancelled for role ${roleName}`);
			if (choice === custom) {
				const entered = await ctx.ui.input(`Model for ${roleName}`, "provider/model");
				if (!entered?.trim()) throw new Error(`Model selection cancelled for role ${roleName}`);
				return modelKey(await resolveModel(entered.trim(), ctx));
			}
			return modelKey(await resolveModel(choice, ctx));
		}
		if (!fallback) throw new Error(`No model configured for role ${roleName}`);
		return modelKey(await resolveModel(fallback, ctx));
	}
}
