import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { components, resolveSelection } from "../../src/registry/index.ts";
import { parseCliArgs } from "../../src/cli/parse.ts";
import { runCli } from "../../src/cli/run.ts";
import type { AgentsUiServices } from "../../src/ui/contracts.ts";
import { FakeServices } from "../ui/fakes.ts";

function output(columns = 80, isTTY = false) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		io: {
			stdout: { columns, isTTY, write: (value: string) => stdout.push(value) },
			stderr: { write: (value: string) => stderr.push(value) },
		},
	};
}

function interactiveCapture(commands: string[]) {
	return ((tree: ReactElement) => {
		commands.push((tree.props as { command: string }).command);
		return {
			waitUntilExit: async () => undefined,
		};
	}) as never;
}

describe("command parsing and execution", () => {
	it("T5 parses every command and automation flag, including spaced POSIX and Windows paths", () => {
		const parsed = parseCliArgs([
			"install",
			"--home",
			"/tmp/home with spaces",
			"--profile",
			"skills",
			"--component",
			"skill:foreman-plan",
			"--category",
			"pi-extension",
			"--all",
			"--yes",
			"--json",
		]);
		expect(parsed.home).toBe("/tmp/home with spaces");
		expect(parsed.components).toEqual(["skill:foreman-plan"]);
		expect(parsed).toMatchObject({
			profile: "skills",
			category: "pi-extension",
			all: true,
			yes: true,
		});
		expect(parseCliArgs(["list", "--home", "C:\\Users\\Agent User"])).toMatchObject({
			command: "list",
			home: "C:\\Users\\Agent User",
		});
	});

	it("T5 routes dashboard, install, remove, list, and doctor views", async () => {
		const seen: string[] = [];
		const services = new FakeServices();
		for (const args of [[], ["install"], ["remove"], ["doctor"]]) {
			const streams = output(80, true);
			expect(
				await runCli(
					args,
					{ services, sourceRoot: "/source root", renderInteractive: interactiveCapture(seen) },
					streams.io,
				),
			).toBe(0);
		}
		const listStreams = output();
		expect(await runCli(["list"], { services, sourceRoot: "/source root" }, listStreams.io)).toBe(
			0,
		);
		expect(listStreams.stdout.join("")).toContain("Components | status and ownership");
		expect(seen).toEqual(["dashboard", "install", "remove", "doctor"]);
		expect(services.applyCalls).toBe(0);
	});

	it("T5 emits deterministic list, doctor, and mutation JSON schemas", async () => {
		const services = new FakeServices();
		const list = output();
		expect(
			await runCli(["list", "--json"], { services, sourceRoot: "/source root" }, list.io),
		).toBe(0);
		const listValue = JSON.parse(list.stdout.join(""));
		expect(Object.keys(listValue)).toEqual([
			"schemaVersion",
			"source",
			"components",
			"unmanagedSkills",
			"warnings",
		]);
		expect(listValue.schemaVersion).toBe(1);

		const doctor = output();
		expect(
			await runCli(["doctor", "--json"], { services, sourceRoot: "/source root" }, doctor.io),
		).toBe(1);
		expect(JSON.parse(doctor.stdout.join(""))).toMatchObject({
			schemaVersion: 1,
			checks: expect.any(Array),
		});

		const install = output();
		expect(
			await runCli(
				["install", "--component", "skill:foreman-plan", "--yes", "--json"],
				{ services, sourceRoot: "/source root" },
				install.io,
			),
		).toBe(0);
		expect(JSON.parse(install.stdout.join(""))).toMatchObject({
			schemaVersion: 1,
			status: "success",
			plan: { operation: "install", requested: ["skill:foreman-plan"] },
		});
	});

	it("T5 maps invalid arguments to exit 2 and requires noninteractive confirmation", async () => {
		for (const args of [
			["unknown"],
			["list", "--all"],
			["install", "--json"],
			["remove", "--yes"],
		]) {
			const streams = output();
			expect(
				await runCli(
					args,
					{ services: new FakeServices(), sourceRoot: "/source root" },
					streams.io,
				),
			).toBe(2);
			expect(streams.stderr.join("")).toContain("ERROR [invalid-arguments]");
		}
	});

	it.each([
		"invalid-component",
		"unsupported-runtime",
		"unsafe-path",
		"malformed-config",
		"unsupported-state",
		"operation-in-progress",
		"requirement-missing",
		"transaction-failed",
		"rollback-failed",
	])("T6 renders %s concisely with recovery and no stack", async (code) => {
		const services = new FakeServices();
		const failure = Object.assign(new Error("Injected safe failure."), {
			code,
			recoveryPath: code === "rollback-failed" ? "/fixture home/recovery" : undefined,
		});
		const failing: AgentsUiServices = {
			...services,
			inspect: services.inspect.bind(services),
			planInstall: async () => {
				throw failure;
			},
			planRemove: services.planRemove.bind(services),
			applyPlan: services.applyPlan.bind(services),
			runDoctor: services.runDoctor.bind(services),
		};
		const streams = output();
		expect(
			await runCli(
				["install", "--component", "skill:foreman-plan", "--yes"],
				{ services: failing, sourceRoot: "/source root" },
				streams.io,
			),
		).toBe(1);
		const rendered = streams.stderr.join("");
		expect(rendered).toContain(`ERROR [${code}]`);
		expect(rendered).toContain("Recovery:");
		expect(rendered).not.toContain("cli.test.ts");
		if (code === "rollback-failed") expect(rendered).toContain("/fixture home/recovery");
	});

	it("T6 includes stack traces only in debug mode", async () => {
		const services = new FakeServices();
		const failing = {
			...services,
			inspect: async () => {
				throw Object.assign(new Error("Inspection failed."), { code: "transaction-failed" });
			},
		} as unknown as AgentsUiServices;
		const normal = output();
		await runCli(["list"], { services: failing, sourceRoot: "/source root" }, normal.io);
		expect(normal.stderr.join("")).not.toContain("cli.test.ts");
		const debug = output();
		await runCli(["list", "--debug"], { services: failing, sourceRoot: "/source root" }, debug.io);
		expect(debug.stderr.join("")).toContain("cli.test.ts");
	});

	it("T5 resolves category, profile, all, and repeated component selections deterministically", async () => {
		const services = new FakeServices();
		const streams = output();
		await runCli(
			[
				"install",
				"--profile",
				"skills",
				"--category",
				"skill",
				"--component",
				"skill:foreman-plan",
				"--all",
				"--yes",
			],
			{ services, sourceRoot: "/source root" },
			streams.io,
		);
		expect(services.plans[0]?.requested).toHaveLength(components.length);
		expect(services.plans[0]?.requested).toEqual(resolveSelection(components.map(({ id }) => id)));
	});
});
