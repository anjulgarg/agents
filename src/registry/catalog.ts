import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ComponentDefinition,
	ComponentId,
	OutputDefinition,
	Requirement,
} from "../domain/contracts.ts";

const NODE: Requirement = { kind: "runtime", runtime: "node", range: ">=22.19.0" };
const PI: Requirement = { kind: "runtime", runtime: "pi", range: ">=0.83.0" };

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = basename(moduleRoot) === "dist" ? resolve(moduleRoot, "..") : moduleRoot;
const localPiConfigRoot = resolve(repositoryRoot, "pi/config");

export const localPiConfigFiles = {
	settings: existsSync(resolve(localPiConfigRoot, "settings.json")),
	models: existsSync(resolve(localPiConfigRoot, "models.json")),
	mcp: existsSync(resolve(localPiConfigRoot, "mcp.json")),
} as const;

const skills = [
	"foreman-plan",
	"foreman-review",
	"foreman-worker",
	"github-pr-review",
	"poker-planning",
	"pr",
	"seaworthy",
] as const;

const extensions = [
	["announce-step", "announce-step.ts"],
	["branch", "branch.ts"],
	["btw", "btw.ts"],
	["claude-code-ui", "claude-code-ui.ts"],
	["codex-usage", "codex-usage.ts"],
	["codex-web-search", "codex-web-search.ts"],
	["context", "context.ts"],
	["conversation-separator", "conversation-separator.ts"],
	["escape-unsend", "escape-unsend.ts"],
	["git-checkpoint", "git-checkpoint.ts"],
	["hide-thinking-history", "hide-thinking-history.ts"],
	["jobs", "jobs/index.ts"],
	["lsp", "lsp/index.ts"],
	["memory", "memory/index.ts"],
	["minimal-mode", "minimal-mode.ts"],
	["plan-mode", "plan-mode/index.ts"],
	["proactive-compaction", "proactive-compaction.ts"],
	["publish", "publish.ts"],
	["pull", "pull.ts"],
	["question", "question.ts"],
	["session-cleanup", "session-cleanup.ts"],
	["session-recap", "session-recap/index.ts"],
	["session-title", "session-title/index.ts"],
	["subagent", "subagent/index.ts"],
	["team", "team/index.ts"],
	["todo", "todo.ts"],
	["token-speed", "token-speed.ts"],
	["worktree", "worktree.ts"],
] as const;

function title(slug: string): string {
	return slug
		.split("-")
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join(" ");
}

function piFilter(kind: "extensions" | "prompts" | "themes", path: string): OutputDefinition {
	return {
		strategy: "pi-package-filter",
		destination: ".pi/agent/settings.json",
		resourceKind: kind,
		filter: `+${path}`,
	};
}

const skillComponents: ComponentDefinition[] = skills.map((slug) => ({
	id: `skill:${slug}`,
	category: "skill",
	label: title(slug),
	description: `${title(slug)} agent skill.`,
	resources: [{ path: `skills/${slug}`, kind: "directory" }],
	outputs: [{ strategy: "copy", destination: `.agents/skills/${slug}` }],
	dependsOn: [],
	requirements: [NODE],
}));

const extensionComponents: ComponentDefinition[] = extensions.map(([slug, entrypoint]) => ({
	id: `pi-extension:${slug}`,
	category: "pi-extension",
	label: title(slug),
	description: `${title(slug)} Pi extension.`,
	resources: [{ path: `pi/extensions/${entrypoint}`, kind: "file" }],
	outputs: [piFilter("extensions", `pi/extensions/${entrypoint}`)],
	dependsOn: slug === "team" ? ["pi-extension:subagent"] : [],
	requirements: [NODE, PI],
	legacyPaths: [`.pi/agent/extensions/${entrypoint}`],
}));

const settingsPointers = [
	"/defaultModel",
	"/defaultProvider",
	"/defaultThinkingLevel",
	"/hideThinkingBlock",
	"/httpIdleTimeoutMs",
	"/editorPaddingX",
	"/quietStartup",
	"/showHardwareCursor",
	"/theme",
	"/enabledModels",
] as const;

const instructionBegin = "<!-- agents:instructions:begin -->";
const instructionEnd = "<!-- agents:instructions:end -->";
const block = (destination: string, content = "{{resource:instructions/AGENTS.md}}") => ({
	strategy: "managed-block" as const,
	destination,
	beginMarker: instructionBegin,
	endMarker: instructionEnd,
	content,
});

const otherComponents: ComponentDefinition[] = [
	{
		id: "pi-config:settings",
		category: "pi-config",
		label: "Pi Settings",
		description: "Complete approved Pi defaults and model selection.",
		resources: [{ path: "pi/config/settings.json", kind: "file" }],
		outputs: [
			{
				strategy: "owned-json",
				destination: ".pi/agent/settings.json",
				pointers: settingsPointers,
			},
		],
		dependsOn: ["pi-theme:claude-code"],
		requirements: [NODE, PI],
	},
	{
		id: "pi-config:models",
		category: "pi-config",
		label: "Pi Models",
		description: "Approved provider model overrides.",
		resources: [{ path: "pi/config/models.json", kind: "file" }],
		outputs: [
			{
				strategy: "owned-json",
				destination: ".pi/agent/models.json",
				pointers: [
					"/providers/kimi-coding/modelOverrides/k3/contextWindow",
					"/providers/openai-codex/modelOverrides/gpt-5.6-luna/contextWindow",
					"/providers/openai-codex/modelOverrides/gpt-5.6-sol/contextWindow",
					"/providers/openai-codex/modelOverrides/gpt-5.6-terra/contextWindow",
				],
			},
		],
		dependsOn: [],
		requirements: [NODE, PI],
	},
	{
		id: "pi-config:keybindings",
		category: "pi-config",
		label: "Pi Keybindings",
		description: "Approved Pi keyboard bindings.",
		resources: [{ path: "pi/config/keybindings.json", kind: "file" }],
		outputs: [
			{
				strategy: "owned-json",
				destination: ".pi/agent/keybindings.json",
				pointers: ["/tui.editor.cursorLineEnd", "/tui.input.newLine", "/app.thinking.cycle"],
			},
		],
		dependsOn: [],
		requirements: [NODE, PI],
	},
	{
		id: "pi-package:mcp-adapter",
		category: "pi-package",
		label: "MCP Adapter",
		description: "Pinned Pi MCP runtime adapter.",
		resources: [{ path: "npm:pi-mcp-adapter@2.15.0", kind: "external" }],
		outputs: [
			{
				strategy: "pi-package-setting",
				destination: ".pi/agent/settings.json",
				source: "npm:pi-mcp-adapter@2.15.0",
			},
		],
		dependsOn: [],
		requirements: [
			{
				kind: "package",
				name: "pi-mcp-adapter",
				version: "2.15.0",
				integrity:
					"sha512-HJAVt2I5IB52pKpSUYbVJnzOmuXYBCc/ZrI9ylHxYQWmE7p75j7aWzsHe734EFN+gL7WaM23CTX3eYHz2THKBA==",
				license: "MIT",
				engines: { node: ">=20" },
			},
		],
	},
	{
		id: "pi-config:mcp-sentry",
		category: "pi-config",
		label: "Sentry MCP",
		description: "Pinned Sentry MCP server configuration.",
		resources: [{ path: "pi/config/mcp.json", kind: "file" }],
		outputs: [
			{
				strategy: "owned-json",
				destination: ".pi/agent/mcp.json",
				pointers: ["/mcpServers/sentry"],
			},
		],
		dependsOn: ["pi-package:mcp-adapter"],
		requirements: [
			NODE,
			{ kind: "command", command: "npx" },
			{
				kind: "package",
				name: "@sentry/mcp-server",
				version: "0.37.0",
				license: "FSL-1.1-ALv2",
				engines: { node: ">=22.13" },
			},
		],
	},
	{
		id: "pi-theme:claude-code",
		category: "pi-theme",
		label: "Claude Code Theme",
		description: "Claude Code inspired Pi theme.",
		resources: [{ path: "pi/themes/claude-code.json", kind: "file" }],
		outputs: [piFilter("themes", "pi/themes/claude-code.json")],
		dependsOn: [],
		legacyPaths: [".pi/agent/themes/claude-code.json"],
		requirements: [NODE, PI],
	},
	{
		id: "pi-prompt:orchestrate",
		category: "pi-prompt",
		label: "Orchestrate Prompt",
		description: "Reusable orchestration prompt.",
		resources: [{ path: "prompts/orchestrate.md", kind: "file" }],
		outputs: [piFilter("prompts", "prompts/orchestrate.md")],
		dependsOn: [],
		legacyPaths: [".pi/agent/prompts/orchestrate.md"],
		requirements: [NODE, PI],
	},
	{
		id: "pi-team:product",
		category: "pi-team",
		label: "Product Team",
		description: "Cross-functional product engineering team.",
		resources: [{ path: "teams/product.json", kind: "file" }],
		outputs: [{ strategy: "copy", destination: ".pi/agent/teams/product.json" }],
		dependsOn: ["pi-extension:team"],
		requirements: [NODE, PI],
	},
	{
		id: "instructions:shared",
		category: "instructions",
		label: "Shared Instructions",
		description: "Always-on guidance shared across supported harnesses.",
		resources: [{ path: "instructions/AGENTS.md", kind: "file" }],
		outputs: [
			block(".codex/AGENTS.md"),
			block(".config/opencode/AGENTS.md"),
			block(".pi/agent/AGENTS.md"),
			{ strategy: "copy", destination: ".claude/AGENTS.md" },
			block(".claude/CLAUDE.md", "@AGENTS.md"),
			{ strategy: "copy", destination: ".cursor/AGENTS.md" },
		],
		dependsOn: [],
		requirements: [],
	},
	{
		id: "harness:cursor",
		category: "harness",
		label: "Cursor Integration",
		description: "Injects shared instructions into Cursor conversations.",
		resources: [{ path: "harnesses/cursor/inject-agents.ts", kind: "file" }],
		outputs: [
			{ strategy: "copy", destination: ".cursor/hooks/inject-agents.ts" },
			{
				strategy: "cursor-hook",
				destination: ".cursor/hooks.json",
				event: "beforeSubmitPrompt",
				scriptDestination: ".cursor/hooks/inject-agents.ts",
				legacyScriptDestinations: [".cursor/hooks/inject-agents.py"],
			},
		],
		dependsOn: ["instructions:shared"],
		legacyPaths: [".cursor/hooks/inject-agents.py"],
		requirements: [NODE],
	},
];

const localOnlyComponentFiles: Partial<Record<ComponentId, keyof typeof localPiConfigFiles>> = {
	"pi-config:settings": "settings",
	"pi-config:models": "models",
	"pi-package:mcp-adapter": "mcp",
	"pi-config:mcp-sentry": "mcp",
};

// Personal Pi settings are loaded only from the local checkout when present. Public clones
// retain the open-source resources without exposing or trying to install those files.
export const components: readonly ComponentDefinition[] = [
	...skillComponents,
	...extensionComponents,
	...otherComponents,
].filter((component) => {
	const localFile = localOnlyComponentFiles[component.id];
	return localFile === undefined || localPiConfigFiles[localFile];
});

export const skillIds = skills.map((slug) => `skill:${slug}` as ComponentId);
export const piComponentIds = components
	.filter(
		({ category }) =>
			category === "pi-extension" ||
			category === "pi-config" ||
			category === "pi-package" ||
			category === "pi-prompt" ||
			category === "pi-theme" ||
			category === "pi-team",
	)
	.map(({ id }) => id);
