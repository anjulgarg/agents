import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	createGlobalUtilityModelStore,
	resolvePreferredUtilityModel,
} from "../model-preference.ts";
import utilityModelExtension from "../utility-model.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const configuredModel = {
	provider: "utility-provider",
	id: "utility-fast",
	name: "Utility Fast",
	reasoning: true,
	thinkingLevelMap: { high: "high", off: "off" },
} as any;
const activeModel = {
	provider: "active-provider",
	id: "active-main",
	name: "Active Main",
	reasoning: true,
	thinkingLevelMap: { medium: "medium", off: "off" },
} as any;
const models = [configuredModel, activeModel];
const registry = {
	getAvailable: () => models,
	find: (provider: string, id: string) =>
		models.find((model) => model.provider === provider && model.id === id),
};
const context = {
	model: activeModel,
	thinkingLevel: "medium",
	modelRegistry: registry,
	ui: {
		notify: () => undefined,
	},
} as any;
const stateDir = mkdtempSync(join(tmpdir(), "pi-utility-model-"));
const store = createGlobalUtilityModelStore(join(stateDir, "utility-model.json"));

try {
	store.write({
		provider: configuredModel.provider,
		id: configuredModel.id,
		thinkingLevel: "high",
	});
	const selected = resolvePreferredUtilityModel(context, store);
	assert(
		"utility resolution selects the configured model and preserves the active fallback",
		selected.preferred?.model === configuredModel &&
			selected.preferred?.thinkingLevel === "high" &&
			selected.fallback?.model === activeModel &&
			selected.fallback?.thinkingLevel === "medium",
		JSON.stringify(selected),
	);

	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const notices: Array<{ message: string; type?: string }> = [];
	utilityModelExtension(
		{
			registerCommand: (name: string, command: unknown) => commands.set(name, command),
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				const entries = handlers.get(event) ?? [];
				entries.push(handler);
				handlers.set(event, entries);
			},
		} as any,
		store,
	);
	const command = commands.get("utility-model");
	assert("registers the utility-model command", Boolean(command), String([...commands.keys()]));
	await handlers.get("session_start")?.[0]?.(
		{},
		{
			...context,
			ui: {
				notify: (message: string, type?: string) => notices.push({ message, type }),
			},
		},
	);
	await command.handler("active-provider/active-main medium", {
		...context,
		waitForIdle: async () => undefined,
		ui: {
			notify: (message: string, type?: string) => notices.push({ message, type }),
		},
	});
	const selectedState = store.read();
	assert(
		"utility-model command persists the selected model and effort",
		selectedState.status === "configured" &&
			selectedState.model !== null &&
			selectedState.model.provider === activeModel.provider &&
			selectedState.model.id === activeModel.id &&
			selectedState.model.thinkingLevel === "medium" &&
			notices.at(-1)?.message === "Utility model set to active-provider/active-main medium",
		JSON.stringify({ selectedState, notices }),
	);
	await command.handler("clear", {
		...context,
		waitForIdle: async () => undefined,
		ui: {
			notify: (message: string, type?: string) => notices.push({ message, type }),
		},
	});
	const clearedState = store.read();
	assert(
		"utility-model command persists clearing the selection",
		clearedState.status === "configured" &&
			clearedState.model === null &&
			notices.at(-1)?.message ===
				"Utility model cleared globally. Using the active conversation model.",
		JSON.stringify({ clearedState, notices }),
	);
} finally {
	rmSync(stateDir, { recursive: true, force: true });
}
