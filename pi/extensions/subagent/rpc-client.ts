import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

import type {
	ContextUsageSnapshot,
	PersistentChildSession,
	ThinkingLevel,
	UsageStats,
} from "./contracts.ts";

export {
	THINKING_LEVELS,
	type ContextUsageSnapshot,
	type ThinkingLevel,
	type UsageStats,
} from "./contracts.ts";

const KILL_GRACE_MS = 3000;
const KILL_CONFIRM_MS = 1000;

/**
 * Dialog methods emit an extension_ui_request and block the child until a matching
 * extension_ui_response arrives. Every other UI method is fire-and-forget.
 */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

export interface ChildUiWidget {
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

export interface ChildUiNotification {
	message: string;
	type: "info" | "warning" | "error";
}

/** Serializable extension UI state projected by an RPC client. */
export interface ChildUiSnapshot {
	statuses: Record<string, string>;
	widgets: Record<string, ChildUiWidget>;
	notifications: ChildUiNotification[];
	title?: string;
	editorText?: string;
}

export function emptyChildUiSnapshot(): ChildUiSnapshot {
	return { statuses: {}, widgets: {}, notifications: [] };
}

/** Apply one fire-and-forget RPC extension UI request without extension-specific logic. */
export function applyChildUiRequest(current: ChildUiSnapshot, event: RpcEvent): ChildUiSnapshot {
	const next: ChildUiSnapshot = {
		...current,
		statuses: { ...current.statuses },
		widgets: Object.fromEntries(
			Object.entries(current.widgets).map(([key, widget]) => [
				key,
				{ ...widget, lines: [...widget.lines] },
			]),
		),
		notifications: current.notifications.map((notification) => ({ ...notification })),
	};
	const method = typeof event.method === "string" ? event.method : "";
	if (method === "setStatus" && typeof event.statusKey === "string") {
		if (typeof event.statusText === "string") next.statuses[event.statusKey] = event.statusText;
		else delete next.statuses[event.statusKey];
	} else if (method === "setWidget" && typeof event.widgetKey === "string") {
		if (
			Array.isArray(event.widgetLines) &&
			event.widgetLines.every((line) => typeof line === "string")
		) {
			next.widgets[event.widgetKey] = {
				lines: [...event.widgetLines] as string[],
				placement: event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
			};
		} else delete next.widgets[event.widgetKey];
	} else if (method === "notify" && typeof event.message === "string") {
		const type =
			event.notifyType === "warning" || event.notifyType === "error" ? event.notifyType : "info";
		next.notifications.push({ message: event.message, type });
		if (next.notifications.length > 50) next.notifications.shift();
	} else if (method === "setTitle" && typeof event.title === "string") {
		next.title = event.title;
	} else if (method === "set_editor_text" && typeof event.text === "string") {
		next.editorText = event.text;
	}
	return next;
}

export interface DialogRequest {
	id: string;
	method: string;
	title?: string;
	options?: string[];
	timeout?: number;
	[key: string]: unknown;
}

export interface DialogResponse {
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

export type DialogHandler = (request: DialogRequest) => Promise<DialogResponse> | DialogResponse;

export interface RpcChildOptions {
	cwd: string;
	model: string;
	thinking: ThinkingLevel;
	tools: string[];
	/** Replace the child Pi-global MCP config with an empty isolated config. */
	disableMcp?: boolean;
	systemPromptFile: string;
	projectTrusted: boolean;
	/** Optional exact native session identity. Both fields are required together. */
	persistentSession?: PersistentChildSession;
	/** Unique persisted identity used to verify orphan ownership before cleanup. */
	ownerToken?: string;
	/** Explicit pi executable. Defaults to resolving pi from the running process. */
	piBin?: string;
	onEvent?: (event: RpcEvent) => void;
	onExit?: (code: number) => void;
	/** Defaults to cancelling every dialog. Route to the parent agent to answer for real. */
	onDialog?: DialogHandler;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/**
 * Validate a raw `contextUsage` payload into the bounded snapshot contract.
 * Every numeric value must be finite and non-negative; `tokens` and `percent`
 * may be null (unknown occupancy). Returns undefined for malformed input so
 * partial or unsafe values are never persisted or projected.
 */
export function validateContextUsageSnapshot(value: unknown): ContextUsageSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.contextWindow !== "number" ||
		!Number.isFinite(candidate.contextWindow) ||
		candidate.contextWindow < 0
	) {
		return undefined;
	}
	const tokens = candidate.tokens;
	if (tokens !== null && (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)) {
		return undefined;
	}
	const percent = candidate.percent;
	if (
		percent !== null &&
		(typeof percent !== "number" || !Number.isFinite(percent) || percent < 0)
	) {
		return undefined;
	}
	return {
		tokens: tokens as number | null,
		contextWindow: candidate.contextWindow,
		percent: percent as number | null,
	};
}

export function validatePersistentChildSession(
	descriptor: PersistentChildSession | undefined,
): PersistentChildSession | undefined {
	if (descriptor === undefined) return undefined;
	if (!descriptor || typeof descriptor !== "object") {
		throw new Error("persistent child session descriptor is required");
	}
	if (typeof descriptor.sessionId !== "string" || descriptor.sessionId.trim() === "") {
		throw new Error("persistent child session requires a non-empty sessionId");
	}
	if (typeof descriptor.sessionDir !== "string" || descriptor.sessionDir.trim() === "") {
		throw new Error("persistent child session requires a non-empty sessionDir");
	}
	return { sessionId: descriptor.sessionId, sessionDir: descriptor.sessionDir };
}

/** Construct the mutually exclusive native Pi session arguments. */
export function getSessionArguments(descriptor: PersistentChildSession | undefined): string[] {
	const session = validatePersistentChildSession(descriptor);
	return session
		? ["--session-id", session.sessionId, "--session-dir", session.sessionDir]
		: ["--no-session"];
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

export function finalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const part = message.content[j];
			if (part.type === "text" && part.text.trim()) return part.text.trim();
		}
	}
	return "";
}

/**
 * One long-lived `pi --mode rpc` child.
 *
 * Completion is the agent_settled event, not process exit: the child stays alive and
 * steerable afterwards.
 */
export class RpcChild {
	readonly messages: Message[] = [];
	readonly usage: UsageStats = emptyUsage();

	private readonly child: ChildProcess;
	private readonly onEvent?: (event: RpcEvent) => void;
	private readonly onExit?: (code: number) => void;
	private readonly onDialog: DialogHandler;
	private readonly pending = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();
	private readonly settledWaiters: Array<() => void> = [];
	private readonly exitWaiters: Array<(code: number) => void> = [];
	private buffer = "";
	private partialAssistant?: AssistantMessage;
	private uiState = emptyChildUiSnapshot();
	private nextId = 1;
	private terminating?: Promise<boolean>;
	private mcpConfigDir?: string;
	/** Latest validated context snapshot; never the complete SessionStats response. */
	private contextSnapshotValue?: ContextUsageSnapshot;
	/** Generation of the last applied refresh outcome (stored value or explicit clear). */
	private contextOutcomeVersion = 0;
	private nextContextVersion = 1;

	stderr = "";
	exited = false;
	exitCode?: number;

	constructor(options: RpcChildOptions) {
		this.onEvent = options.onEvent;
		this.onExit = options.onExit;
		this.onDialog = options.onDialog ?? (() => ({ cancelled: true }));

		let mcpArguments: string[] = [];
		if (options.disableMcp) {
			this.mcpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-mcp-disabled-"));
			const mcpConfigFile = path.join(this.mcpConfigDir, "mcp.json");
			fs.writeFileSync(mcpConfigFile, '{"mcpServers":{}}\n', { encoding: "utf8", mode: 0o600 });
			mcpArguments = ["--mcp-config", mcpConfigFile];
		}

		const args = [
			"--mode",
			"rpc",
			"--model",
			options.model,
			"--thinking",
			options.thinking,
			"--tools",
			options.tools.join(","),
			"--exclude-tools",
			"subagent",
			"--append-system-prompt",
			options.systemPromptFile,
			...mcpArguments,
			...getSessionArguments(options.persistentSession),
			...(options.projectTrusted ? ["--approve"] : []),
		];
		const invocation = options.piBin ? { command: options.piBin, args } : getPiInvocation(args);

		this.child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			env: {
				...process.env,
				PI_SUBAGENT_CHILD: "1",
				...(options.ownerToken ? { PI_SUBAGENT_OWNER_TOKEN: options.ownerToken } : {}),
			},
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout?.on("data", (data: Buffer) => this.consume(data.toString()));
		this.child.stderr?.on("data", (data: Buffer) => {
			this.stderr += data.toString();
		});
		this.child.on("error", (error) => {
			this.stderr += error.message;
			this.finish(1);
		});
		this.child.on("close", (code) => {
			if (this.buffer.trim()) this.handleLine(this.buffer);
			this.buffer = "";
			this.finish(code ?? 1);
		});
	}

	/** Resolves on the next agent_settled event. */
	settled(): Promise<void> {
		if (this.exited) return Promise.resolve();
		return new Promise((resolve) => this.settledWaiters.push(resolve));
	}

	waitForExit(): Promise<number> {
		if (this.exited) return Promise.resolve(this.exitCode ?? 1);
		return new Promise((resolve) => this.exitWaiters.push(resolve));
	}

	prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<unknown> {
		return this.command({
			type: "prompt",
			message,
			...(streamingBehavior ? { streamingBehavior } : {}),
		});
	}

	steer(message: string): Promise<unknown> {
		return this.command({ type: "steer", message });
	}

	abort(): Promise<unknown> {
		return this.command({ type: "abort" });
	}

	output(): string {
		return finalOutput(this.messages);
	}

	/** Completed messages plus the latest streaming assistant snapshot. */
	transcript(): readonly Message[] {
		return this.partialAssistant ? [...this.messages, this.partialAssistant] : this.messages;
	}

	uiSnapshot(): ChildUiSnapshot {
		return applyChildUiRequest(this.uiState, { type: "snapshot" });
	}

	/** Latest validated context occupancy as a defensive copy, without sessionFile. */
	contextSnapshot(): ContextUsageSnapshot | undefined {
		const current = this.contextSnapshotValue;
		return current === undefined ? undefined : { ...current };
	}

	/**
	 * Request `get_session_stats` over the correlated command channel, validate the
	 * response, and update the latest context snapshot. Monotonic request generation
	 * rejects stale outcomes: only the newest issued refresh may replace or clear
	 * the current snapshot. Non-fatal: command failure, unsupported command, child
	 * exit, or malformed data resolves with undefined and clears availability.
	 */
	async refreshSessionStats(): Promise<ContextUsageSnapshot | undefined> {
		if (this.exited) {
			this.applyContextOutcome(this.nextContextVersion++, undefined);
			return this.contextSnapshot();
		}
		const version = this.nextContextVersion++;
		let response: any;
		try {
			response = await this.command({ type: "get_session_stats" });
		} catch {
			this.applyContextOutcome(version, undefined);
			return this.contextSnapshot();
		}
		const snapshot = validateContextUsageSnapshot(response?.data?.contextUsage);
		this.applyContextOutcome(version, snapshot);
		return this.contextSnapshot();
	}

	private applyContextOutcome(version: number, snapshot: ContextUsageSnapshot | undefined): void {
		if (version <= this.contextOutcomeVersion) return;
		this.contextOutcomeVersion = version;
		this.contextSnapshotValue = snapshot === undefined ? undefined : { ...snapshot };
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	/** Terminate the complete child process group and confirm that the leader exited. */
	terminate(): Promise<boolean> {
		if (this.terminating) return this.terminating;
		this.terminating = this.terminateOnce().then((reaped) => {
			if (!reaped) this.terminating = undefined;
			return reaped;
		});
		return this.terminating;
	}

	kill(): void {
		void this.terminate();
	}

	/** Synchronous best-effort process-group kill for parent process exit handlers. */
	forceKill(): void {
		this.signalProcessGroup("SIGKILL");
	}

	private async terminateOnce(): Promise<boolean> {
		this.signalProcessGroup("SIGTERM");
		const leaderExited = await this.waitForExitWithin(KILL_GRACE_MS);
		// Always sweep the group after the leader exits; grandchildren may ignore SIGTERM.
		this.signalProcessGroup("SIGKILL");
		const leaderGone = leaderExited || (await this.waitForExitWithin(KILL_CONFIRM_MS));
		const groupGone = await this.waitForGroupGoneWithin(KILL_CONFIRM_MS);
		return leaderGone && groupGone;
	}

	private signalProcessGroup(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (process.platform !== "win32" && pid) {
			try {
				process.kill(-pid, signal);
				return;
			} catch {
				// Fall back to the leader when the group no longer exists.
			}
		}
		if (this.exited) return;
		try {
			this.child.kill(signal);
		} catch {
			// The process may already have exited between checks.
		}
	}

	private async waitForGroupGoneWithin(timeoutMs: number): Promise<boolean> {
		if (process.platform === "win32" || !this.child.pid) return this.exited;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				process.kill(-this.child.pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return false;
	}

	private async waitForExitWithin(timeoutMs: number): Promise<boolean> {
		if (this.exited) return true;
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
			timer.unref?.();
		});
		const exited = this.waitForExit().then(() => true as const);
		const result = await Promise.race([exited, timedOut]);
		if (timer) clearTimeout(timer);
		return result;
	}

	private finish(code: number): void {
		if (this.exited) return;
		this.exited = true;
		if (this.mcpConfigDir) {
			fs.rmSync(this.mcpConfigDir, { recursive: true, force: true });
			this.mcpConfigDir = undefined;
		}
		this.exitCode = code;
		for (const waiter of this.pending.values()) waiter.reject(new Error("Subagent process exited"));
		this.pending.clear();
		while (this.settledWaiters.length) this.settledWaiters.shift()?.();
		while (this.exitWaiters.length) this.exitWaiters.shift()?.(code);
		this.onExit?.(code);
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.handleLine(line);
	}

	private handleLine(raw: string): void {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!line.trim()) return;
		let payload: any;
		try {
			payload = JSON.parse(line);
		} catch {
			return;
		}
		if (!payload || typeof payload !== "object") return;
		if (payload.type === "response") {
			this.settle(payload);
			return;
		}
		if (payload.type === "extension_ui_request") {
			const request = payload as DialogRequest;
			if (DIALOG_METHODS.has(request.method)) void this.answerDialog(request);
			else {
				this.absorb(payload as RpcEvent);
				this.onEvent?.(payload as RpcEvent);
			}
			return;
		}
		this.absorb(payload as RpcEvent);
		this.onEvent?.(payload as RpcEvent);
		if (payload.type === "agent_settled") {
			while (this.settledWaiters.length) this.settledWaiters.shift()?.();
		}
	}

	private settle(response: any): void {
		const id = typeof response.id === "string" ? response.id : undefined;
		if (!id) return;
		const waiter = this.pending.get(id);
		if (!waiter) return;
		this.pending.delete(id);
		if (response.success === false) {
			waiter.reject(new Error(response.error ?? `${response.command} command failed`));
			return;
		}
		waiter.resolve(response);
	}

	private async answerDialog(request: DialogRequest): Promise<void> {
		if (!DIALOG_METHODS.has(request.method)) return;
		let response: DialogResponse;
		try {
			response = await this.onDialog(request);
		} catch {
			response = { cancelled: true };
		}
		this.write({ type: "extension_ui_response", id: request.id, ...response });
	}

	private absorb(event: RpcEvent): void {
		if (event.type === "extension_ui_request") {
			this.absorbUiRequest(event);
			return;
		}
		if (event.type === "message_update") {
			const message = event.message as AssistantMessage | undefined;
			if (message?.role === "assistant") this.partialAssistant = message;
			return;
		}
		if (event.type !== "message_end") return;
		const message = event.message as Message | undefined;
		if (!message) return;
		this.messages.push(message);
		if (message.role !== "assistant") return;
		this.partialAssistant = undefined;
		this.usage.turns++;
		this.usage.input += message.usage?.input ?? 0;
		this.usage.output += message.usage?.output ?? 0;
		this.usage.cacheRead += message.usage?.cacheRead ?? 0;
		this.usage.cacheWrite += message.usage?.cacheWrite ?? 0;
		this.usage.cost += message.usage?.cost?.total ?? 0;
	}

	private absorbUiRequest(event: RpcEvent): void {
		this.uiState = applyChildUiRequest(this.uiState, event);
	}

	private write(payload: Record<string, unknown>): void {
		if (this.exited || !this.child.stdin?.writable) return;
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private command(payload: Record<string, unknown>): Promise<unknown> {
		if (this.exited) return Promise.reject(new Error("Subagent process has exited"));
		const id = `cmd-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write({ ...payload, id });
		});
	}
}
