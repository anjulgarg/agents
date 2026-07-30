import { parseArgs } from "node:util";
import type { ComponentCategory, ComponentId } from "../domain/contracts.ts";
import { COMPONENT_CATEGORIES } from "../domain/contracts.ts";
import { getComponent, profiles } from "../registry/index.ts";

export type CliCommand = "dashboard" | "install" | "remove" | "list" | "doctor";

export interface CliOptions {
	readonly command: CliCommand;
	readonly home?: string;
	readonly json: boolean;
	readonly debug: boolean;
	readonly yes: boolean;
	readonly profile?: string;
	readonly components: readonly ComponentId[];
	readonly category?: ComponentCategory;
	readonly all: boolean;
}

export class CliArgumentError extends Error {
	readonly code = "invalid-arguments";
	constructor(message: string) {
		super(message);
		this.name = "CliArgumentError";
	}
}

const commands = new Set(["install", "remove", "list", "doctor"]);

export function parseCliArgs(argv: readonly string[]): CliOptions {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			strict: true,
			options: {
				home: { type: "string" },
				json: { type: "boolean", default: false },
				debug: { type: "boolean", default: false },
				yes: { type: "boolean", short: "y", default: false },
				profile: { type: "string" },
				component: { type: "string", multiple: true, default: [] },
				category: { type: "string" },
				all: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new CliArgumentError((error as Error).message);
	}
	if (parsed.positionals.length > 1)
		throw new CliArgumentError("Only one command may be provided.");
	const values = parsed.values as {
		home?: string;
		json: boolean;
		debug: boolean;
		yes: boolean;
		profile?: string;
		component: string[];
		category?: string;
		all: boolean;
	};
	const rawCommand = parsed.positionals[0];
	if (rawCommand && !commands.has(rawCommand))
		throw new CliArgumentError(`Unknown command: ${rawCommand}`);
	const command = (rawCommand ?? "dashboard") as CliCommand;
	const selectionUsed =
		Boolean(values.profile) ||
		values.component.length > 0 ||
		Boolean(values.category) ||
		values.all;
	if (selectionUsed && command !== "install" && command !== "remove") {
		throw new CliArgumentError("Selection options are valid only with install or remove.");
	}
	if (values.yes && command !== "install" && command !== "remove") {
		throw new CliArgumentError("--yes is valid only with install or remove.");
	}
	if (values.json && command === "dashboard") {
		throw new CliArgumentError("--json requires list, doctor, install, or remove.");
	}
	if (values.profile && !profiles.some(({ id }) => id === values.profile)) {
		throw new CliArgumentError(`Unknown profile: ${values.profile}`);
	}
	const category = values.category;
	if (category && !COMPONENT_CATEGORIES.includes(category as ComponentCategory)) {
		throw new CliArgumentError(`Unknown category: ${category}`);
	}
	const componentIds = values.component as ComponentId[];
	for (const id of componentIds) {
		try {
			getComponent(id);
		} catch {
			throw new CliArgumentError(`Unknown component: ${id}`);
		}
	}
	if (values.json && (command === "install" || command === "remove") && !values.yes) {
		throw new CliArgumentError("Non-interactive mutation requires explicit --yes confirmation.");
	}
	return {
		command,
		home: values.home,
		json: values.json,
		debug: values.debug,
		yes: values.yes,
		profile: values.profile,
		components: componentIds,
		category: category as ComponentCategory | undefined,
		all: values.all,
	};
}
