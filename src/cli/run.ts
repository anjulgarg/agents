import { homedir } from "node:os";
import { resolve } from "node:path";
import React from "react";
import { render } from "ink";
import type { ComponentId, InspectionContext } from "../domain/contracts.ts";
import { components, resolveProfile } from "../registry/index.ts";
import { App } from "../ui/App.ts";
import type { AgentsUiServices, OperationPlanView } from "../ui/contracts.ts";
import { renderError, renderList, renderPreview, renderResult } from "../ui/presenters.ts";
import { CliArgumentError, parseCliArgs } from "./parse.ts";

export interface CliIo {
	readonly stdout: { write(value: string): unknown; columns?: number; isTTY?: boolean };
	readonly stderr: { write(value: string): unknown };
	readonly stdin?: NodeJS.ReadStream;
}

export interface RunCliDependencies {
	readonly services: AgentsUiServices;
	readonly sourceRoot: string;
	readonly renderInteractive?: typeof render;
}

function writeLine(stream: { write(value: string): unknown }, value: string): void {
	stream.write(`${value}\n`);
}

function hasExplicitSelection(options: ReturnType<typeof parseCliArgs>): boolean {
	return Boolean(options.profile || options.components.length || options.category || options.all);
}

function operationSelection(
	options: ReturnType<typeof parseCliArgs>,
	defaultInstall: boolean,
): readonly ComponentId[] {
	const selected = new Set<ComponentId>(options.components);
	if (options.profile) for (const id of resolveProfile(options.profile)) selected.add(id);
	if (options.category)
		for (const component of components)
			if (component.category === options.category) selected.add(component.id);
	if (options.all) for (const component of components) selected.add(component.id);
	if (!selected.size && defaultInstall && options.command === "install") {
		for (const id of resolveProfile("default")) selected.add(id);
	}
	return components
		.filter(({ id }) => selected.has(id))
		.sort(
			(a, b) =>
				a.category.localeCompare(b.category) ||
				a.label.localeCompare(b.label) ||
				a.id.localeCompare(b.id),
		)
		.map(({ id }) => id);
}

function errorCode(error: unknown): number {
	return error instanceof CliArgumentError ? 2 : 1;
}

function listJson(inspection: Awaited<ReturnType<AgentsUiServices["inspect"]>>) {
	return {
		schemaVersion: 1 as const,
		source: inspection.source,
		components: inspection.components,
		unmanagedSkills: inspection.unmanagedSkills,
		warnings: inspection.warnings,
	};
}

function doctorJson(report: Awaited<ReturnType<AgentsUiServices["runDoctor"]>>) {
	return {
		schemaVersion: 1 as const,
		checks: report.checks,
		warnings: report.warnings ?? [],
	};
}

export async function runCli(
	argv: readonly string[],
	dependencies: RunCliDependencies,
	io: CliIo = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
): Promise<number> {
	let debug = process.env.DEBUG !== undefined;
	try {
		const options = parseCliArgs(argv);
		debug ||= options.debug;
		const context: InspectionContext = {
			home: resolve(options.home ?? homedir()),
			sourceRoot: resolve(dependencies.sourceRoot),
		};
		if (options.command === "list") {
			const inspection = await dependencies.services.inspect(context);
			writeLine(
				io.stdout,
				options.json
					? JSON.stringify(listJson(inspection))
					: renderList(inspection, components, io.stdout.columns ?? 80),
			);
			return 0;
		}
		if (options.command === "doctor" && options.json) {
			const report = await dependencies.services.runDoctor(context);
			writeLine(io.stdout, JSON.stringify(doctorJson(report)));
			return report.checks.some(({ severity }) => severity === "failure") ? 1 : 0;
		}
		const mutation = options.command === "install" || options.command === "remove";
		if (mutation && !io.stdout.isTTY && !options.yes) {
			throw new CliArgumentError("Non-interactive mutation requires explicit --yes confirmation.");
		}
		if (mutation && options.yes) {
			const ids = operationSelection(options, true);
			if (options.command === "remove" && !ids.length) {
				throw new CliArgumentError("Remove requires --component, --profile, --category, or --all.");
			}
			const plan: OperationPlanView =
				options.command === "install"
					? await dependencies.services.planInstall(context, ids)
					: await dependencies.services.planRemove(context, ids);
			const result = await dependencies.services.applyPlan(context, plan);
			if (options.json) {
				writeLine(io.stdout, JSON.stringify({ schemaVersion: 1, status: "success", plan, result }));
			} else {
				writeLine(io.stdout, renderPreview(plan, io.stdout.columns ?? 80, components));
				writeLine(io.stdout, renderResult(result, io.stdout.columns ?? 80));
			}
			return 0;
		}
		const initialSelection =
			mutation && hasExplicitSelection(options) ? operationSelection(options, false) : undefined;
		const instance = (dependencies.renderInteractive ?? render)(
			React.createElement(App, {
				command: options.command,
				services: dependencies.services,
				context,
				width: io.stdout.columns ?? 80,
				debug,
				initialSelection,
			}),
			io.stdin ? { stdin: io.stdin, stdout: io.stdout as NodeJS.WriteStream } : undefined,
		);
		await instance.waitUntilExit();
		return 0;
	} catch (error) {
		const width = io.stdout.columns ?? 80;
		writeLine(io.stderr, renderError(error, debug, width));
		return errorCode(error);
	}
}
