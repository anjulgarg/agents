import type { RpcEvent } from "./rpc-client.ts";

/** Small bounds used by parent-facing activity snapshots. */
export const MAX_RECENT_TOOL_ERRORS = 4;
export const MAX_CHANGED_FILES = 12;
export const MAX_RECENT_TOOLS = 6;

export interface RecentToolActivity {
	toolCallId: string;
	name: string;
	args: string;
	status: "running" | "succeeded" | "failed";
}

export interface RecentToolError {
	toolName: string;
	target: string;
	message: string;
	ageMs: number;
}

/** Objective activity only. No field classifies task health or intent. */
export interface ActivityFacts {
	silentMs: number;
	turns: number;
	costUsd: number;
	lastToolName?: string;
	openToolName?: string;
	openToolId?: string;
	openToolMs?: number;
	hasEditOrWrite: boolean;
	toolCalls: number;
	succeededTools: number;
	failedTools: number;
	runningTools: number;
	changedFiles: string[];
	recentTools: RecentToolActivity[];
	recentErrors: RecentToolError[];
	/** Observed completion-order failure streak; concurrent calls are not reordered. */
	consecutiveToolFailures: number;
	outputTokens: number;
}

interface OpenTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	startedAt: number;
	activity: RecentToolActivity;
}

interface StoredToolError {
	toolName: string;
	target: string;
	message: string;
	at: number;
}

/** Collects bounded, objective telemetry from the child's RPC event stream. */
export class ActivityTracker {
	private lastEventAt = 0;
	private started = false;
	private turns = 0;
	private costUsd = 0;
	private outputTokens = 0;
	private consecutiveToolFailures = 0;
	private hasEditOrWrite = false;
	private toolCalls = 0;
	private succeededTools = 0;
	private failedTools = 0;
	private lastToolName?: string;

	private readonly openTools = new Map<string, OpenTool>();
	private readonly changedFiles = new Set<string>();
	private readonly recentTools: RecentToolActivity[] = [];
	private readonly recentErrors: StoredToolError[] = [];

	observe(event: RpcEvent, now: number): void {
		this.started = true;
		this.lastEventAt = now;

		switch (event.type) {
			case "tool_execution_start": {
				const toolCallId = String(event.toolCallId ?? "");
				const toolName = String(event.toolName ?? "");
				const args = event.args;
				this.toolCalls++;
				this.lastToolName = toolName;
				if (toolName === "edit" || toolName === "write") {
					this.hasEditOrWrite = true;
					const changedPath = filePathFromArgs(args);
					if (changedPath && this.changedFiles.size < MAX_CHANGED_FILES) {
						this.changedFiles.add(sanitizeTarget(changedPath, 120));
					}
				}
				const activity: RecentToolActivity = {
					toolCallId,
					name: boundedText(toolName, 32),
					args: sanitizeTarget(args, 40),
					status: "running",
				};
				this.recentTools.push(activity);
				if (this.recentTools.length > MAX_RECENT_TOOLS) this.recentTools.shift();
				const openKey = toolCallId || `anonymous-${this.toolCalls}`;
				this.openTools.set(openKey, { toolCallId, toolName, args, startedAt: now, activity });
				break;
			}
			case "tool_execution_end": {
				const toolCallId = String(event.toolCallId ?? "");
				let openKey: string | undefined;
				let openTool: OpenTool | undefined;
				if (toolCallId) {
					openKey = toolCallId;
					openTool = this.openTools.get(toolCallId);
				} else {
					for (const [key, candidate] of this.openTools) {
						if (candidate.toolName === event.toolName) {
							openKey = key;
							openTool = candidate;
						}
					}
				}
				if (openKey) this.openTools.delete(openKey);
				const toolName = String(event.toolName ?? openTool?.toolName ?? this.lastToolName ?? "");
				this.lastToolName = toolName;
				if (event.isError === true) {
					this.failedTools++;
					this.consecutiveToolFailures++;
					if (openTool) openTool.activity.status = "failed";
					this.recentErrors.push({
						toolName: boundedText(toolName, 32),
						target: sanitizeTarget(openTool?.args ?? event.args ?? event.target, 80),
						message: errorMessage(event),
						at: now,
					});
					if (this.recentErrors.length > MAX_RECENT_TOOL_ERRORS) this.recentErrors.shift();
				} else {
					this.consecutiveToolFailures = 0;
					this.succeededTools++;
					if (openTool) openTool.activity.status = "succeeded";
				}
				break;
			}
			case "message_end": {
				const message = event.message as
					{ role?: string; usage?: { output?: number; cost?: { total?: number } } } | undefined;
				if (!message || message.role !== "assistant") break;
				this.turns++;
				const total = message.usage?.cost?.total;
				if (typeof total === "number" && Number.isFinite(total)) this.costUsd += total;
				const output = message.usage?.output;
				if (typeof output === "number" && Number.isFinite(output) && output >= 0) {
					this.outputTokens += output;
				}
				break;
			}
			default:
				break;
		}
	}

	activity(now: number): ActivityFacts | undefined {
		if (!this.started) return undefined;
		let openTool: OpenTool | undefined;
		let openToolMs: number | undefined;
		for (const tool of this.openTools.values()) {
			const ms = now - tool.startedAt;
			if (openToolMs === undefined || ms > openToolMs) {
				openTool = tool;
				openToolMs = ms;
			}
		}
		return {
			silentMs: Math.max(0, now - this.lastEventAt),
			turns: this.turns,
			costUsd: this.costUsd,
			lastToolName: this.lastToolName,
			openToolName: openTool?.toolName,
			openToolId: openTool?.toolCallId,
			openToolMs,
			hasEditOrWrite: this.hasEditOrWrite,
			toolCalls: this.toolCalls,
			succeededTools: this.succeededTools,
			failedTools: this.failedTools,
			runningTools: this.openTools.size,
			changedFiles: [...this.changedFiles],
			recentTools: this.recentTools.map((tool) => ({ ...tool })),
			recentErrors: this.recentErrors.map((error) => ({
				toolName: error.toolName,
				target: error.target,
				message: error.message,
				ageMs: Math.max(0, now - error.at),
			})),
			consecutiveToolFailures: this.consecutiveToolFailures,
			outputTokens: this.outputTokens,
		};
	}
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const object = value as Record<string, unknown>;
	const keys = Object.keys(object).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function filePathFromArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const object = args as Record<string, unknown>;
	for (const key of ["path", "file_path"]) {
		if (typeof object[key] === "string" && object[key]) return object[key];
	}
	return undefined;
}

function boundedText(value: string, max: number): string {
	const normalized = value
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 3))}...` : normalized;
}

/** Redact common credential-shaped values before a target enters parent-visible telemetry. */
function sanitizeTarget(value: unknown, max = 120): string {
	let raw: string;
	if (value === undefined || value === null) raw = "";
	else if (typeof value === "object" && !Array.isArray(value)) {
		const object = value as Record<string, unknown>;
		const candidate = ["path", "file_path", "command", "url", "query", "pattern", "target"]
			.map((key) => object[key])
			.find((item) => typeof item === "string" && item.length > 0);
		raw = candidate === undefined ? stableStringify(value) : String(candidate);
	} else raw = String(value);
	return boundedText(
		raw
			.replace(/(https?:\/\/)([^/\s@]+)@/gi, "$1[REDACTED]@")
			.replace(
				/([?&](?:token|api[-_]?key|password|secret|signature|authorization)=)[^&\s]+/gi,
				"$1[REDACTED]",
			)
			.replace(
				/((?:api[-_]?key|token|password|secret|authorization|credential)\s*[=:]\s*)[^\s,;&]+/gi,
				"$1[REDACTED]",
			),
		max,
	);
}

function errorMessage(event: RpcEvent): string {
	const candidate = event.error ?? event.errorMessage ?? event.message ?? event.result;
	return boundedText(
		candidate === undefined
			? "tool execution failed"
			: typeof candidate === "string"
				? candidate
				: stableStringify(candidate),
		100,
	);
}
