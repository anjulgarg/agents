import { readFile as nodeReadFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ComponentId, ReadOnlyFileSystem, ReceiptInspection } from "../domain/contracts.ts";

const componentIdPattern =
	/^(?:skill|pi-extension|pi-config|pi-package|pi-prompt|pi-theme|pi-team|instructions|harness):[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(path: string, warning: string): ReceiptInspection {
	return {
		path,
		schemaState: "malformed",
		schemaVersion: null,
		managedComponents: new Set(),
		warning,
	};
}

export async function readReceipt(
	home: string,
	fs?: Pick<ReadOnlyFileSystem, "readFile">,
): Promise<ReceiptInspection> {
	const path = join(resolve(home), ".agents", "anjulgarg-agents.json");
	let bytes: Uint8Array;
	try {
		bytes = await (fs?.readFile(path) ?? nodeReadFile(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				path,
				schemaState: "absent",
				schemaVersion: null,
				managedComponents: new Set(),
			};
		}
		return malformed(path, "Install receipt is unreadable; ownership was not inferred.");
	}

	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return malformed(path, "Install receipt is malformed; ownership was not inferred.");
	}
	if (!isRecord(value) || typeof value.schemaVersion !== "number") {
		return malformed(path, "Install receipt is malformed; ownership was not inferred.");
	}
	if (value.schemaVersion > 1) {
		return {
			path,
			schemaState: "future",
			schemaVersion: value.schemaVersion,
			managedComponents: new Set(),
			warning: "Install receipt uses a future schema; ownership was not inferred.",
		};
	}
	if (value.schemaVersion !== 1 || !isRecord(value.source) || !isRecord(value.components)) {
		return malformed(path, "Install receipt is malformed; ownership was not inferred.");
	}

	const managed = new Set<ComponentId>();
	for (const [id, entry] of Object.entries(value.components)) {
		if (!componentIdPattern.test(id) || !isRecord(entry) || !Array.isArray(entry.outputs)) {
			return malformed(path, "Install receipt is malformed; ownership was not inferred.");
		}
		managed.add(id as ComponentId);
	}
	return {
		path,
		schemaState: "current",
		schemaVersion: 1,
		managedComponents: managed,
	};
}
