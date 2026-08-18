import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	SoftGroupTracker,
	TOOL_CHAT_PADDING,
	bindSoftGroupTracker,
	emptyCollapsedToolRender,
	renderSoftGroupedCall,
} from "./lib/tui/index.ts";

export const LOAD_TOOLS_NAME = "load_tools" as const;
export const LOAD_TOOLS_COMMAND = "tools:load" as const;

export const CAPABILITIES = ["mcp", "subagent", "memory", "handoff"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const TOOL_LOADER_STATE_ENTRY_TYPE = "tool-loader-state" as const;
export const TOOL_LOADER_STATE_VERSION = 1 as const;

export interface ToolLoaderState {
	readonly version: typeof TOOL_LOADER_STATE_VERSION;
	readonly loaded: Capability[];
}

/** Stable generic routing from a capability to its registered root tool. */
export const CAPABILITY_TO_TOOL = Object.freeze({
	mcp: "mcp",
	subagent: "subagent",
	memory: "memory",
	handoff: "handoff",
} satisfies Readonly<Record<Capability, string>>);

export const OPTIONAL_ROOT_TOOLS = Object.freeze(
	Object.values(CAPABILITY_TO_TOOL),
) as readonly string[];

export type LoadToolsStatus = "loaded" | "active" | "unavailable";

export interface LoadToolsItemDetails {
	readonly capability: Capability;
	readonly toolName: string;
	readonly status: LoadToolsStatus;
}

export interface LoadToolsDetails extends LoadToolsItemDetails {
	/** Per-capability results for both singular and batch requests. */
	readonly results: readonly LoadToolsItemDetails[];
}

interface LoadToolsOutcome {
	readonly details: LoadToolsDetails;
	readonly text: string;
}

const USAGE = `Usage: /${LOAD_TOOLS_COMMAND} <${CAPABILITIES.join("|")}> [...]`;
const STARTUP_RESET_DELAYS_MS = [25, 100, 250, 500, 1000, 2000] as const;
const LoadToolsParams = Type.Object({
	capability: Type.Optional(
		StringEnum(CAPABILITIES, {
			description: "Optional capability to activate for this session",
		}),
	),
	capabilities: Type.Optional(
		Type.Array(StringEnum(CAPABILITIES), {
			minItems: 1,
			maxItems: CAPABILITIES.length,
			uniqueItems: true,
			description: "Optional capabilities to activate together for this session",
		}),
	),
});

function isCapability(value: string): value is Capability {
	return (CAPABILITIES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolLoaderState(data: unknown): Capability[] | undefined {
	if (!isRecord(data) || data.version !== TOOL_LOADER_STATE_VERSION) return undefined;
	const loaded = data.loaded;
	if (
		!Array.isArray(loaded) ||
		loaded.some((capability) => typeof capability !== "string" || !isCapability(capability))
	)
		return undefined;
	return CAPABILITIES.filter((capability) => loaded.includes(capability));
}

/** Return the latest valid capability state visible on the active branch. */
export function latestLoadedCapabilities(
	ctx: Pick<ExtensionContext, "sessionManager"> | undefined,
): Capability[] {
	let entries: readonly unknown[] = [];
	try {
		const sessionManager = ctx?.sessionManager as
			{ getBranch?: () => readonly unknown[] } | undefined;
		const branch = sessionManager?.getBranch?.();
		if (Array.isArray(branch)) entries = branch;
	} catch {
		return [];
	}

	let latest: Capability[] | undefined;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom") continue;
		if (entry.customType !== TOOL_LOADER_STATE_ENTRY_TYPE) continue;
		const state = parseToolLoaderState(entry.data);
		if (state !== undefined) latest = state;
	}
	return latest ? [...latest] : [];
}

function orderedCapabilities(capabilities: Iterable<Capability>): Capability[] {
	const selected = new Set(capabilities);
	return CAPABILITIES.filter((capability) => selected.has(capability));
}

function textFor(details: LoadToolsItemDetails): string {
	switch (details.status) {
		case "loaded":
			return `Loaded ${details.capability} for this session.`;
		case "active":
			return `${details.capability} is already active.`;
		case "unavailable":
			return `${details.capability} is unavailable.`;
	}
}

function textForBatch(results: readonly LoadToolsItemDetails[]): string {
	if (results.length === 1) return textFor(results[0]!);
	const grouped = new Map<LoadToolsStatus, Capability[]>();
	for (const result of results) {
		const capabilities = grouped.get(result.status) ?? [];
		capabilities.push(result.capability);
		grouped.set(result.status, capabilities);
	}
	const labels: Array<[LoadToolsStatus, string]> = [
		["loaded", "Loaded"],
		["active", "Already active"],
		["unavailable", "Unavailable"],
	];
	return labels
		.filter(([status]) => grouped.has(status))
		.map(([status, label]) => `${label}: ${grouped.get(status)!.join(", ")}`)
		.join(" · ");
}

function detailsFor(results: readonly LoadToolsItemDetails[]): LoadToolsDetails {
	const first = results[0];
	if (!first) throw new Error("At least one capability is required");
	return { ...first, results: [...results] };
}

export function loadCapabilities(
	pi: ExtensionAPI,
	capabilities: readonly Capability[],
): LoadToolsOutcome {
	const requested = [...new Set(capabilities)];
	if (requested.length === 0) throw new Error("At least one capability is required");

	let registeredTools: Set<string>;
	try {
		registeredTools = new Set(pi.getAllTools().map((tool) => tool.name));
	} catch {
		const results = requested.map((capability) => ({
			capability,
			toolName: CAPABILITY_TO_TOOL[capability],
			status: "unavailable" as const,
		}));
		return { details: detailsFor(results), text: textForBatch(results) };
	}

	const active = new Set(pi.getActiveTools());
	const results: LoadToolsItemDetails[] = [];
	for (const capability of requested) {
		const toolName = CAPABILITY_TO_TOOL[capability];
		if (!registeredTools.has(toolName)) {
			results.push({ capability, toolName, status: "unavailable" });
		} else if (active.has(toolName)) {
			results.push({ capability, toolName, status: "active" });
		} else {
			active.add(toolName);
			results.push({ capability, toolName, status: "loaded" });
		}
	}

	const loaded = results.some((result) => result.status === "loaded");
	if (loaded) pi.setActiveTools([...active]);
	return { details: detailsFor(results), text: textForBatch(results) };
}

export function loadCapability(pi: ExtensionAPI, capability: Capability): LoadToolsOutcome {
	return loadCapabilities(pi, [capability]);
}

export function resetOptionalTools(pi: ExtensionAPI): void {
	const active = pi.getActiveTools().filter((name) => !OPTIONAL_ROOT_TOOLS.includes(name));
	pi.setActiveTools([...new Set([...active, LOAD_TOOLS_NAME])]);
}

/** Apply persisted roots without initializing any capability connection. */
export function restoreOptionalTools(pi: ExtensionAPI, capabilities: readonly Capability[]): void {
	let registeredTools: Set<string>;
	try {
		registeredTools = new Set(pi.getAllTools().map((tool) => tool.name));
	} catch {
		resetOptionalTools(pi);
		return;
	}

	const active = pi.getActiveTools().filter((name) => !OPTIONAL_ROOT_TOOLS.includes(name));
	const restoredRoots = orderedCapabilities(capabilities)
		.map((capability) => CAPABILITY_TO_TOOL[capability])
		.filter((toolName) => registeredTools.has(toolName));
	pi.setActiveTools([...new Set([...active, LOAD_TOOLS_NAME, ...restoredRoots])]);
}

function parseCommandCapabilities(args: string): Capability[] | undefined {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts.some((part) => !isCapability(part))) return undefined;
	return [...new Set(parts)] as Capability[];
}

function requestedCapabilities(args: {
	capability?: unknown;
	capabilities?: unknown;
}): Capability[] {
	if (args.capability !== undefined && args.capabilities !== undefined) {
		throw new Error("Use capability or capabilities, not both");
	}
	if (args.capabilities !== undefined) {
		if (
			!Array.isArray(args.capabilities) ||
			args.capabilities.length === 0 ||
			args.capabilities.some(
				(capability) => typeof capability !== "string" || !isCapability(capability),
			)
		)
			throw new Error("At least one valid capability is required");
		return [...new Set(args.capabilities)] as Capability[];
	}
	if (typeof args.capability === "string" && isCapability(args.capability))
		return [args.capability];
	throw new Error("At least one valid capability is required");
}

export default function toolLoaderExtension(pi: ExtensionAPI): void {
	const groupTracker = new SoftGroupTracker();
	bindSoftGroupTracker(pi as any, groupTracker, [LOAD_TOOLS_NAME]);
	let sessionResetPending = false;
	let startupResetTimer: ReturnType<typeof setTimeout> | undefined;
	let startupResetIndex = 0;
	let loadedCapabilities = new Set<Capability>();

	const restoreFromBranch = (ctx: ExtensionContext): void => {
		loadedCapabilities = new Set(latestLoadedCapabilities(ctx));
		restoreOptionalTools(pi, [...loadedCapabilities]);
	};

	const persistAvailableCapabilities = (outcome: LoadToolsOutcome): void => {
		let changed = false;
		for (const result of outcome.details.results) {
			if (result.status === "unavailable" || loadedCapabilities.has(result.capability)) continue;
			loadedCapabilities.add(result.capability);
			changed = true;
		}
		if (!changed) return;

		const loaded = orderedCapabilities(loadedCapabilities);
		try {
			pi.appendEntry<ToolLoaderState>(TOOL_LOADER_STATE_ENTRY_TYPE, {
				version: TOOL_LOADER_STATE_VERSION,
				loaded,
			});
		} catch {
			// Persistence failures must not change tool execution semantics.
		}
	};

	const stopStartupReset = (): void => {
		if (startupResetTimer !== undefined) clearTimeout(startupResetTimer);
		startupResetTimer = undefined;
	};

	const scheduleStartupReset = (): void => {
		const delay = STARTUP_RESET_DELAYS_MS[startupResetIndex++];
		if (delay === undefined || !sessionResetPending) return;
		startupResetTimer = setTimeout(() => {
			startupResetTimer = undefined;
			if (!sessionResetPending) return;
			restoreOptionalTools(pi, [...loadedCapabilities]);
			scheduleStartupReset();
		}, delay);
		(startupResetTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
	};

	const activateCapabilities = (capabilities: readonly Capability[]): LoadToolsOutcome => {
		sessionResetPending = false;
		stopStartupReset();
		const outcome = loadCapabilities(pi, capabilities);
		persistAvailableCapabilities(outcome);
		return outcome;
	};

	pi.registerTool({
		name: LOAD_TOOLS_NAME,
		label: "Load Tools",
		description:
			"Activate one or more optional capabilities for this session. Choose mcp, subagent, memory, or handoff when those capabilities are needed.",
		promptSnippet: "Activate optional capabilities only when needed",
		parameters: LoadToolsParams,
		renderShell: "self",
		async execute(_toolCallId, params) {
			const capabilities = requestedCapabilities(params);
			const outcome = activateCapabilities(capabilities);
			return {
				content: [{ type: "text", text: outcome.text }],
				details: outcome.details,
			};
		},
		renderCall(args, theme, context) {
			let capabilities: Capability[];
			try {
				capabilities = requestedCapabilities(args);
			} catch {
				capabilities = [];
			}
			const summary = capabilities.join(", ") || "?";
			return renderSoftGroupedCall({
				tracker: groupTracker,
				groupId: LOAD_TOOLS_NAME,
				label: "load tools",
				summary,
				unitCount: Math.max(1, capabilities.length),
				theme: {
					fg: (name, text) => theme.fg(name as Parameters<typeof theme.fg>[0], text),
					bold: (text) => theme.bold(text),
				},
				context,
				expandedLines: ["load tools", `capabilities: ${summary}`],
			});
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const raw = result.content.find((part) => part.type === "text")?.text ?? "";
			if (!expanded) {
				if (!context.isError || isPartial) return emptyCollapsedToolRender();
				const message = (raw.split(/\r?\n/, 1)[0] ?? "Tool loading failed").trim();
				return new Text(
					`${theme.fg("error", "×")} ${theme.fg("muted", message)}`,
					TOOL_CHAT_PADDING,
					0,
				);
			}
			return new Text(
				context.isError ? theme.fg("error", raw) : theme.fg("muted", raw),
				TOOL_CHAT_PADDING,
				0,
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		stopStartupReset();
		startupResetIndex = 0;
		restoreFromBranch(ctx);
		sessionResetPending = true;
		scheduleStartupReset();
	});

	// Packages loaded after this extension can register or reactivate optional roots
	// during their own session startup. Reset once more at the model boundary, after
	// every package has initialized but before Pi builds the first provider request.
	pi.on("before_agent_start", (_event, ctx) => {
		if (!sessionResetPending) return;
		sessionResetPending = false;
		stopStartupReset();
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		sessionResetPending = false;
		stopStartupReset();
		restoreFromBranch(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionResetPending = false;
		stopStartupReset();
		loadedCapabilities.clear();
	});

	pi.registerCommand(LOAD_TOOLS_COMMAND, {
		description: "Activate one or more optional capabilities for this session",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const capabilities = parseCommandCapabilities(args);
			if (!capabilities) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			const outcome = activateCapabilities(capabilities);
			const hasUnavailable = outcome.details.results.some(
				(result) => result.status === "unavailable",
			);
			ctx.ui.notify(outcome.text, hasUnavailable ? "warning" : "info");
		},
	});
}
