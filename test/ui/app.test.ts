import React from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { components } from "../../src/registry/index.ts";
import { App } from "../../src/ui/App.ts";
import { FakeServices, inspection } from "./fakes.ts";

const context = { home: "/fixture home", sourceRoot: "/source root" };
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
	delete process.env.DEBUG;
});

describe("interactive dashboard and selector", () => {
	it("T1 drives profiles, item/category controls, search, clear, and preview", async () => {
		const services = new FakeServices();
		const dashboard = render(React.createElement(App, { command: "dashboard", services, context }));
		await pause();
		expect(dashboard.lastFrame()).toContain("Install");
		expect(dashboard.lastFrame()).toContain("Installed Components");
		dashboard.unmount();

		const view = render(
			React.createElement(App, {
				command: "install",
				services,
				context,
				initialSelection: [],
			}),
		);
		await pause();
		view.stdin.write("3");
		await pause();
		expect(view.lastFrame()).toContain("Selected 3/");
		expect(view.lastFrame()).toContain("Skills (3)");
		expect(view.lastFrame()).toContain("Pi Extensions (28)");
		expect(view.lastFrame()).toContain("Prompts (1)");
		view.stdin.write(" ");
		await pause();
		view.stdin.write("\t");
		await pause();
		view.stdin.write("\t");
		await pause();
		view.stdin.write("c");
		await pause();
		expect(view.lastFrame()).toContain("Category: pi-extension");
		view.stdin.write("/");
		await pause();
		view.stdin.write("team");
		await pause();
		view.stdin.write("\r");
		await pause();
		expect(view.lastFrame()).toContain("Search: team");
		view.stdin.write("x");
		await pause();
		view.stdin.write(" ");
		await pause();
		view.stdin.write("\r");
		await pause();
		expect(view.lastFrame()).toContain("Review install");
		expect(view.lastFrame()).toContain("Dependency-added: pi-extension:subagent");
		expect(view.lastFrame()).toContain("Requirements:");
		view.stdin.write("\r");
		await pause();
		expect(view.lastFrame()).toContain("Apply this plan? [y/N]");
		view.stdin.write("n");
		await pause();
		expect(services.applyCalls).toBe(0);
		view.unmount();
	});

	it("T2 initializes safely and cancellation never applies", async () => {
		const fresh = new FakeServices();
		const install = render(
			React.createElement(App, { command: "install", services: fresh, context }),
		);
		await pause();
		expect(install.lastFrame()).toContain(`Selected ${components.length}/${components.length}`);
		install.stdin.write("\u001B");
		await pause();
		expect(fresh.applyCalls).toBe(0);
		install.unmount();

		const legacy = new FakeServices(
			inspection({
				"skill:foreman-plan": { status: "installed", managed: false, legacy: true },
			}),
		);
		const remove = render(
			React.createElement(App, { command: "remove", services: legacy, context }),
		);
		await pause();
		expect(remove.lastFrame()).toContain("Selected 0/");
		expect(remove.lastFrame()).toContain("legacy detected");
		remove.stdin.write("\u001B");
		await pause();
		expect(legacy.applyCalls).toBe(0);
		remove.unmount();
	});
});
