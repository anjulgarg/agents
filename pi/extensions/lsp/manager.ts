/**
 * Lazy language-server process manager: one server per deterministic workspace root.
 * Shared startup is decoupled from any single caller's AbortSignal.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { LspClient } from "./client.ts";
import { canonicalizeRoot, toFileUri } from "./paths.ts";
import {
	buildInitializeOptions,
	discoverWorkspaceRoot,
	findTypescriptLanguageServer,
	INSTALL_HINT,
	SERVER_COMMAND,
	workspaceKey,
	type ServerExecutable,
} from "./servers.ts";

export interface ManagedSession {
	key: string;
	workspaceRoot: string;
	sessionCwd: string;
	client: LspClient;
	process: ChildProcessWithoutNullStreams;
	executable: ServerExecutable;
}

export interface ManagerStatus {
	language: "typescript/javascript";
	workspaceRoot: string;
	serverCommand: string;
	serverAvailable: boolean;
	serverPath?: string;
	initialized: boolean;
	capabilities: string[];
	installHint: string;
	error?: string;
}

export interface ActiveServerStatus {
	key: string;
	workspaceRoot: string;
	serverPath: string;
	initialized: boolean;
	capabilities: string[];
	processAlive: boolean;
}

interface InflightStart {
	promise: Promise<ManagedSession>;
	waiters: number;
}

export class LspManager {
	private readonly sessions = new Map<string, ManagedSession>();
	private readonly starting = new Map<string, InflightStart>();
	private disposed = false;

	/** Resolve or lazily start a server for the workspace containing `anchorPath`. */
	async getSession(
		sessionCwd: string,
		anchorPath: string,
		signal?: AbortSignal,
	): Promise<ManagedSession> {
		if (this.disposed) throw new Error("LSP manager has been disposed");
		throwIfAborted(signal);

		const workspaceRoot = discoverWorkspaceRoot(anchorPath, sessionCwd);
		const key = workspaceKey(workspaceRoot);

		const existing = this.sessions.get(key);
		if (existing && !existing.client.connection.isClosed) {
			return existing;
		}
		if (existing) {
			this.sessions.delete(key);
			await killProcess(existing.process);
		}

		let inflight = this.starting.get(key);
		if (!inflight) {
			const promise = this.startSession(key, workspaceRoot, sessionCwd).finally(() => {
				this.starting.delete(key);
			});
			inflight = { promise, waiters: 0 };
			this.starting.set(key, inflight);
		}
		inflight.waiters++;

		try {
			if (!signal) return await inflight.promise;
			return await raceAbort(inflight.promise, signal);
		} finally {
			inflight.waiters = Math.max(0, inflight.waiters - 1);
		}
	}

	listActiveServers(): ActiveServerStatus[] {
		return [...this.sessions.values()]
			.map((session) => ({
				key: session.key,
				workspaceRoot: session.workspaceRoot,
				serverPath: session.executable.resolvedPath,
				initialized: session.client.isInitialized,
				capabilities: listCapabilityNames(session.client.serverCapabilities),
				processAlive: session.process.exitCode === null && !session.process.killed,
			}))
			.sort((a, b) => a.workspaceRoot.localeCompare(b.workspaceRoot));
	}

	async stopServer(key: string): Promise<boolean> {
		const session = this.sessions.get(key);
		if (!session) return false;
		this.sessions.delete(key);
		await this.stopSession(session);
		return true;
	}

	async stopAllServers(): Promise<void> {
		await this.disposeAll();
	}

	statusFor(sessionCwd: string, anchorPath?: string): ManagerStatus {
		const workspaceRoot = discoverWorkspaceRoot(anchorPath ?? sessionCwd, sessionCwd);
		const key = workspaceKey(workspaceRoot);
		const lookup = findTypescriptLanguageServer();
		const session = this.sessions.get(key);
		const caps = session?.client.serverCapabilities ?? {};
		const capabilities = listCapabilityNames(caps);

		if (!lookup.available) {
			return {
				language: "typescript/javascript",
				workspaceRoot,
				serverCommand: SERVER_COMMAND,
				serverAvailable: false,
				initialized: false,
				capabilities: [],
				installHint: INSTALL_HINT,
				error: lookup.error,
			};
		}

		return {
			language: "typescript/javascript",
			workspaceRoot,
			serverCommand: SERVER_COMMAND,
			serverAvailable: true,
			serverPath: lookup.executable?.resolvedPath,
			initialized: Boolean(session?.client.isInitialized),
			capabilities,
			installHint: INSTALL_HINT,
		};
	}

	async disposeAll(): Promise<void> {
		this.disposed = true;
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		const starting = [...this.starting.values()];
		this.starting.clear();
		await Promise.allSettled([
			...sessions.map((session) => this.stopSession(session)),
			...starting.map(async (inflight) => {
				try {
					const session = await inflight.promise;
					await this.stopSession(session);
				} catch {
					// start failed / cleaned up
				}
			}),
		]);
		this.disposed = false;
	}

	/** Exposed for tests: count live child processes managed here. */
	liveProcessCount(): number {
		let count = 0;
		for (const session of this.sessions.values()) {
			if (session.process.exitCode === null && !session.process.killed) count++;
		}
		return count;
	}

	private async startSession(
		key: string,
		workspaceRoot: string,
		sessionCwd: string,
	): Promise<ManagedSession> {
		const lookup = findTypescriptLanguageServer();
		if (!lookup.available || !lookup.executable) {
			throw new Error(lookup.error ?? `Missing ${SERVER_COMMAND}`);
		}

		const executable = lookup.executable;
		const child = spawn(executable.command, executable.args, {
			cwd: workspaceRoot,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});

		const trustedRoot = canonicalizeRoot(sessionCwd);
		const client = new LspClient(child.stdout, child.stdin, {
			workspaceRoot,
			trustedRoot,
			rootUri: toFileUri(workspaceRoot),
			initializationOptions: buildInitializeOptions(),
			label: `lsp:${path.basename(workspaceRoot)}`,
		});

		const session: ManagedSession = {
			key,
			workspaceRoot,
			sessionCwd: trustedRoot,
			client,
			process: child,
			executable,
		};

		const crashError = new Error(
			`Language server process exited unexpectedly (${SERVER_COMMAND}). ` +
				`Retry the lsp tool call; if it keeps failing, restart the session or check server logs.`,
		);

		child.stderr.on("data", () => undefined);

		child.on("error", (error) => {
			client.dispose(error);
			this.sessions.delete(key);
		});

		child.on("exit", () => {
			if (this.sessions.get(key) === session) {
				client.dispose(crashError);
				this.sessions.delete(key);
			}
		});

		try {
			await client.initialize();
		} catch (error) {
			client.dispose(error instanceof Error ? error : new Error(String(error)));
			await killProcess(child);
			throw error;
		}

		if (this.disposed) {
			await this.stopSession(session);
			throw new Error("LSP manager disposed during startup");
		}

		this.sessions.set(key, session);
		return session;
	}

	private async stopSession(session: ManagedSession): Promise<void> {
		try {
			await session.client.shutdown();
		} catch {
			session.client.dispose();
		}
		await killProcess(session.process);
	}
}

function listCapabilityNames(caps: Record<string, unknown>): string[] {
	const names: string[] = [];
	if (caps.definitionProvider) names.push("definition");
	if (caps.referencesProvider) names.push("references");
	if (caps.hoverProvider) names.push("hover");
	if (caps.documentSymbolProvider) names.push("document_symbols");
	if (caps.workspaceSymbolProvider) names.push("workspace_symbols");
	if (caps.renameProvider) names.push("rename");
	if (caps.diagnosticProvider) names.push("pull_diagnostics");
	const diag = caps.diagnosticProvider;
	if (
		diag &&
		typeof diag === "object" &&
		(diag as { workspaceDiagnostics?: boolean }).workspaceDiagnostics
	) {
		names.push("workspace_diagnostics");
	}
	names.push("publish_diagnostics");
	return names;
}

export async function killProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.killed) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
			resolve();
		}, 1500);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		try {
			child.kill("SIGTERM");
		} catch {
			clearTimeout(timer);
			resolve();
		}
	});
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	const error = new Error(reason ? String(reason) : "Aborted");
	error.name = "AbortError";
	return error;
}
