export const COMPONENT_CATEGORIES = [
	"skill",
	"pi-extension",
	"pi-config",
	"pi-package",
	"pi-prompt",
	"pi-theme",
	"instructions",
] as const;

export type ComponentCategory = (typeof COMPONENT_CATEGORIES)[number];
export type ComponentId = `${ComponentCategory}:${string}`;
export type ComponentStatus = "available" | "installed" | "drifted" | "partial" | "unavailable";

export interface RuntimeRequirement {
	kind: "runtime";
	runtime: "node" | "pi";
	range: string;
	description?: string;
}

export interface CommandRequirement {
	kind: "command";
	command: string;
	description?: string;
}

export interface PackageRequirement {
	kind: "package";
	name: string;
	version: string;
	integrity?: string;
	license: string;
	engines?: Readonly<Record<string, string>>;
	description?: string;
}

export type Requirement = RuntimeRequirement | CommandRequirement | PackageRequirement;
export type PiResourceKind = "extensions" | "prompts" | "themes";

export interface CopyOutput {
	strategy: "copy";
	destination: string;
}

export interface PiFilterOutput {
	strategy: "pi-package-filter";
	destination: ".pi/agent/settings.json";
	resourceKind: PiResourceKind;
	filter: string;
}

export interface OwnedJsonOutput {
	strategy: "owned-json";
	destination: string;
	pointers: readonly string[];
}

export interface PackageSettingOutput {
	strategy: "pi-package-setting";
	destination: ".pi/agent/settings.json";
	source: string;
}

export interface ManagedBlockOutput {
	strategy: "managed-block";
	destination: string;
	beginMarker: string;
	endMarker: string;
	content: string;
}

export interface CursorHookOutput {
	strategy: "cursor-hook";
	destination: ".cursor/hooks.json";
	event: "beforeSubmitPrompt";
	scriptDestination: string;
	legacyScriptDestinations?: readonly string[];
}

export type OutputDefinition =
	| CopyOutput
	| PiFilterOutput
	| OwnedJsonOutput
	| PackageSettingOutput
	| ManagedBlockOutput
	| CursorHookOutput;

export interface ResourceDefinition {
	path: string;
	kind: "file" | "directory" | "external";
	supportOnly?: boolean;
}

export interface ComponentDefinition {
	id: ComponentId;
	category: ComponentCategory;
	label: string;
	description: string;
	resources: readonly ResourceDefinition[];
	outputs: readonly OutputDefinition[];
	dependsOn: readonly ComponentId[];
	requirements: readonly Requirement[];
	legacyPaths?: readonly string[];
}

export interface ProfileDefinition {
	id: "default" | "pi" | "skills" | (string & {});
	label: string;
	description: string;
	components: readonly ComponentId[];
}

export type OutputState = "missing" | "exact" | "drifted" | "unavailable" | "legacy";

export interface OutputInspection {
	strategy: OutputDefinition["strategy"] | "legacy-copy";
	path: string;
	state: OutputState;
	reason: string;
}

export interface ComponentInspection {
	id: ComponentId;
	status: ComponentStatus;
	managed: boolean;
	reasons: readonly string[];
	outputs: readonly OutputInspection[];
}

export interface UnmanagedSkillInspection {
	name: string;
	path: string;
}

export type ReceiptSchemaState = "absent" | "current" | "malformed" | "future";

export interface ReceiptInspection {
	path: string;
	schemaState: ReceiptSchemaState;
	schemaVersion: number | null;
	managedComponents: ReadonlySet<ComponentId>;
	warning?: string;
}

export interface ReadOnlyFileSystem {
	readFile(path: string): Promise<Uint8Array>;
	readdir(path: string): Promise<
		readonly {
			name: string;
			isFile(): boolean;
			isDirectory(): boolean;
			isSymbolicLink(): boolean;
		}[]
	>;
	lstat(
		path: string,
	): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
}

export interface InspectionContext {
	home: string;
	sourceRoot: string;
	fs?: ReadOnlyFileSystem;
}

export interface SystemInspection {
	source: { kind: "local"; root: string; revision: null };
	receipt: ReceiptInspection;
	components: readonly ComponentInspection[];
	unmanagedSkills: readonly UnmanagedSkillInspection[];
	warnings: readonly string[];
}
