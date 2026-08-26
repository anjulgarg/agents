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

export const MCP_ADAPTER = { name: "pi-mcp-adapter", version: "2.15.0" } as const;
export const MCP_ADAPTER_REF = `npm:${MCP_ADAPTER.name}@${MCP_ADAPTER.version}`;
export const INSTRUCTIONS_RESOURCE_REF = "{{resource:pi/AGENTS.md}}";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = basename(moduleRoot) === "dist" ? resolve(moduleRoot, "..") : moduleRoot;
const localPiConfigRoot = resolve(repositoryRoot, "pi/config");

export const localPiConfigFiles = {
	mcp: existsSync(resolve(localPiConfigRoot, "mcp.json")),
} as const;

const skills = ["foreman-plan", "foreman-review", "foreman-worker"] as const;

const extensions = [
	["announce-step", "announce-step.ts"],
	["branch", "branch.ts"],
	["btw", "btw.ts"],
	["changes", "changes.ts"],
	["claude-code-ui", "claude-code-ui.ts"],
	["codex-usage", "codex-usage.ts"],
	["codex-web-search", "codex-web-search.ts"],
	["compaction-model", "compaction-model.ts"],
	["context", "context.ts"],
	["conversation-separator", "conversation-separator.ts"],
	["escape-unsend", "escape-unsend.ts"],
	["find", "find/index.ts"],
	["git-checkpoint", "git-checkpoint.ts"],
	["handoff", "handoff.ts"],
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
	["todo", "todo.ts"],
	["token-speed", "token-speed.ts"],
	["tool-loader", "tool-loader.ts"],
	["utility-model", "utility-model.ts"],
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

function extensionDependencies(slug: string): ComponentId[] {
	switch (slug) {
		case "plan-mode":
			return ["skill:foreman-plan"];
		default:
			return [];
	}
}

/**
 * Destinations of retired components that installs must clean up.
 * The teams feature was removed; its product definition is pruned by the subagent
 * extension, which every prior teams install already depended on.
 */
function extensionLegacyPaths(slug: string, entrypoint: string): string[] {
	const paths = [`.pi/agent/extensions/${entrypoint}`];
	if (slug === "subagent")
		paths.push(".pi/agent/teams/product.json", ".pi/agent/extensions/team/index.ts");
	return paths;
}

const extensionComponents: ComponentDefinition[] = extensions.map(([slug, entrypoint]) => ({
	id: `pi-extension:${slug}`,
	category: "pi-extension",
	label: title(slug),
	description: `${title(slug)} Pi extension.`,
	resources: [{ path: `pi/extensions/${entrypoint}`, kind: "file" }],
	outputs: [piFilter("extensions", `pi/extensions/${entrypoint}`)],
	dependsOn: extensionDependencies(slug),
	requirements: [NODE, PI],
	legacyPaths: extensionLegacyPaths(slug, entrypoint),
}));

const instructionBegin = "<!-- agents:instructions:begin -->";
const instructionEnd = "<!-- agents:instructions:end -->";
const block = (destination: string, content = INSTRUCTIONS_RESOURCE_REF) => ({
	strategy: "managed-block" as const,
	destination,
	beginMarker: instructionBegin,
	endMarker: instructionEnd,
	content,
});

const otherComponents: ComponentDefinition[] = [
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
		resources: [{ path: MCP_ADAPTER_REF, kind: "external" }],
		outputs: [
			{
				strategy: "pi-package-setting",
				destination: ".pi/agent/settings.json",
				source: MCP_ADAPTER_REF,
			},
		],
		dependsOn: [],
		requirements: [
			{
				kind: "package",
				name: MCP_ADAPTER.name,
				version: MCP_ADAPTER.version,
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
		resources: [{ path: "pi/prompts/orchestrate.md", kind: "file" }],
		outputs: [piFilter("prompts", "pi/prompts/orchestrate.md")],
		dependsOn: [],
		legacyPaths: [".pi/agent/prompts/orchestrate.md"],
		requirements: [NODE, PI],
	},
	{
		id: "instructions:shared",
		category: "instructions",
		label: "Shared Instructions",
		description: "Always-on guidance shared across supported harnesses.",
		resources: [{ path: "pi/AGENTS.md", kind: "file" }],
		outputs: [
			block(".codex/AGENTS.md"),
			block(".config/opencode/AGENTS.md"),
			{ strategy: "copy", destination: ".pi/agent/AGENTS.md" },
			{ strategy: "copy", destination: ".claude/AGENTS.md" },
			block(".claude/CLAUDE.md", "@AGENTS.md"),
			{ strategy: "copy", destination: ".cursor/AGENTS.md" },
		],
		dependsOn: [],
		requirements: [],
	},
];

const localOnlyComponentFiles: Partial<Record<ComponentId, keyof typeof localPiConfigFiles>> = {
	"pi-package:mcp-adapter": "mcp",
	"pi-config:mcp-sentry": "mcp",
};

// Personal Pi configuration components are loaded only from the local checkout when present.
// Public clones retain the open-source resources without exposing or trying to install those files.
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
			category === "pi-theme",
	)
	.map(({ id }) => id);
