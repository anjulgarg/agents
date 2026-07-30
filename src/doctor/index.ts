import { constants } from "node:fs";
import { access, lstat, readdir } from "node:fs/promises";
import { delimiter, extname, join, resolve } from "node:path";
import type { InspectionContext, SystemInspection } from "../domain/contracts.ts";
import { components } from "../registry/catalog.ts";
import { validateRegistry } from "../registry/registry.ts";
import { inspectSystem } from "../status/inspect.ts";

export type DoctorCheckStatus = "ok" | "warning" | "error";
export interface DoctorCheck {
	id: string;
	status: DoctorCheckStatus;
	message: string;
	details?: readonly string[];
}
export interface DoctorReport {
	healthy: boolean;
	checks: readonly DoctorCheck[];
	inspection: SystemInspection;
	durationMs: number;
}
export interface DoctorContext extends InspectionContext {
	nodeVersion?: string;
	piVersion?: string | null;
	path?: string;
	platform?: NodeJS.Platform;
	emit?: (event: {
		name: "agents.doctor";
		count: number;
		durationMs: number;
		errorCode?: string;
	}) => void;
}

function versionTuple(value: string): [number, number, number] | undefined {
	const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(value);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
function atLeast(value: string, expected: [number, number, number]): boolean {
	const actual = versionTuple(value);
	if (!actual) return false;
	return (
		actual[0] > expected[0] ||
		(actual[0] === expected[0] &&
			(actual[1] > expected[1] || (actual[1] === expected[1] && actual[2] >= expected[2])))
	);
}
async function commandExists(command: string, context: DoctorContext): Promise<boolean> {
	const platform = context.platform ?? process.platform;
	const extensions =
		platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
	for (const directory of (context.path ?? process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)) {
		for (const extension of extensions) {
			const path = join(
				directory,
				platform === "win32" && !extname(command) ? command + extension.toLowerCase() : command,
			);
			try {
				await access(path, constants.X_OK);
				return true;
			} catch {
				/* continue */
			}
		}
	}
	return false;
}

export async function runDoctor(context: DoctorContext): Promise<DoctorReport> {
	const options = context;
	const started = Date.now();
	const checks: DoctorCheck[] = [];
	const nodeVersion = options.nodeVersion ?? process.version;
	checks.push({
		id: "runtime:node",
		status: atLeast(nodeVersion, [22, 19, 0]) ? "ok" : "error",
		message: `Node ${nodeVersion} ${atLeast(nodeVersion, [22, 19, 0]) ? "is supported" : "is unsupported"}.`,
	});
	const piVersion = options.piVersion;
	if (piVersion === null)
		checks.push({ id: "runtime:pi", status: "warning", message: "Pi was not found." });
	else if (piVersion !== undefined)
		checks.push({
			id: "runtime:pi",
			status: atLeast(piVersion, [0, 83, 0]) ? "ok" : "error",
			message: `Pi ${piVersion} ${atLeast(piVersion, [0, 83, 0]) ? "is supported" : "is unsupported"}.`,
		});
	else
		checks.push({
			id: "runtime:pi",
			status: (await commandExists("pi", options)) ? "ok" : "warning",
			message: (await commandExists("pi", options))
				? "Pi command is available; version was not supplied."
				: "Pi was not found.",
		});
	try {
		const info = await lstat(resolve(context.sourceRoot));
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
		await validateRegistry(components, resolve(context.sourceRoot));
		checks.push({ id: "source", status: "ok", message: "Local source and registry are valid." });
	} catch {
		checks.push({ id: "source", status: "error", message: "Local source or registry is invalid." });
	}
	const inspection = await inspectSystem(context);
	checks.push({
		id: "receipt",
		status:
			inspection.receipt.schemaState === "malformed" || inspection.receipt.schemaState === "future"
				? "error"
				: "ok",
		message: `Receipt state: ${inspection.receipt.schemaState}.`,
	});
	const unhealthy = inspection.components.filter(
		(item) => item.managed && item.status !== "installed",
	);
	checks.push({
		id: "components",
		status: unhealthy.length ? "error" : "ok",
		message: unhealthy.length
			? `${unhealthy.length} managed component(s) are drifted or incomplete.`
			: "Managed components are consistent.",
		details: unhealthy.map(({ id }) => id),
	});
	const legacy = inspection.components.filter((item) =>
		item.outputs.some((output) => output.strategy === "legacy-copy"),
	);
	checks.push({
		id: "legacy",
		status: legacy.length ? "warning" : "ok",
		message: legacy.length
			? `${legacy.length} stale legacy duplicate(s) detected.`
			: "No stale legacy duplicates detected.",
		details: legacy.map(({ id }) => id),
	});
	const journalRoot = join(resolve(context.home), ".agents", ".transactions");
	let journals: string[] = [];
	try {
		journals = (await readdir(journalRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.map((entry) => entry.name)
			.sort();
	} catch {
		/* absent or unreadable is reported only when visible */
	}
	checks.push({
		id: "transactions",
		status: journals.length ? "error" : "ok",
		message: journals.length
			? "An incomplete transaction requires manual recovery."
			: "No incomplete transactions detected.",
		details: journals,
	});
	for (const command of ["npx", "typescript-language-server", "claude", "codex", "opencode"]) {
		const exists = await commandExists(command, options);
		const required = command === "npx" || command === "typescript-language-server";
		checks.push({
			id: `command:${command}`,
			status: exists ? "ok" : required ? "error" : "warning",
			message: exists ? `${command} is available.` : `${command} is unavailable.`,
		});
	}
	const durationMs = Date.now() - started;
	const healthy = !checks.some(({ status }) => status === "error");
	options.emit?.({
		name: "agents.doctor",
		count: checks.length,
		durationMs,
		...(healthy ? {} : { errorCode: "doctor-unhealthy" }),
	});
	return { healthy, checks, inspection, durationMs };
}
