/** Focused role roster and inspector rendering tests. */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function ensurePiModulePath(): void {
	if (process.env.PI_TEAM_ROLE_TEST_READY === "1") return;
	const candidates: string[] = [];
	const which = spawnSync("which", ["pi"], { encoding: "utf8" });
	const piBin = which.stdout?.trim();
	if (piBin) {
		try {
			candidates.push(resolve(dirname(fs.realpathSync(piBin)), ".."));
		} catch {}
	}
	const require = createRequire(import.meta.url);
	try {
		candidates.push(dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")));
	} catch {}
	try {
		const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout?.trim();
		if (npmRoot) candidates.push(join(npmRoot, "@earendil-works/pi-coding-agent"));
	} catch {}
	const piRoot = candidates.find((candidate) =>
		fs.existsSync(join(candidate, "node_modules", "typebox")),
	);
	if (!piRoot) throw new Error("Cannot locate Pi dependencies for role inspector tests");
	const nodePath = [join(piRoot, "node_modules"), dirname(dirname(piRoot)), process.env.NODE_PATH]
		.filter(Boolean)
		.join(delimiter);
	const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
		stdio: "inherit",
		env: { ...process.env, NODE_PATH: nodePath, PI_TEAM_ROLE_TEST_READY: "1" },
	});
	process.exit(result.status ?? 1);
}

ensurePiModulePath();
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { TeamRoleInspector } = await import("./role-ui.ts");
const { TeamDashboard } = await import("./ui.ts");
const { buildTeamRoleSummaries } = await import("./role-model.ts");

const team = {
	name: "product",
	description: "Cross-functional product team.",
	manager: { model: "test/manager", thinking: "high" as const, instructions: "Coordinate safely." },
	defaults: { model: "test/default", thinking: "medium" as const, workspace: "shared" as const },
	roles: {
		builder: {
			description: "Builds the approved change.",
			modelPolicy: "manager" as const,
			model: "test/builder",
			maxInstances: 2,
		},
		gate: {
			description: "Independently reviews and verifies the result.",
			instructions: "Challenge correctness with concrete findings.",
			modelPolicy: "fixed" as const,
			model: "test/gate",
			thinking: "high" as const,
			maxInstances: 1,
			review: true,
			verification: true,
		},
	},
	limits: { maxConcurrency: 3, requirePlanApproval: true },
};

const maintenance = {
	...team,
	name: "maintenance",
	description: "Small maintenance team.",
};

const runs = [
	{
		id: "run-product",
		teamName: "product",
		goal: "Ship the feature",
		status: "executing" as const,
		startedAt: 1,
		updatedAt: 2,
		tasks: [
			{
				id: "build-1",
				title: "Build feature",
				description: "Implement the feature and verify it.",
				role: "builder",
				dependsOn: [],
				model: "test/builder",
				thinking: "medium" as const,
				workspace: "shared" as const,
				status: "running" as const,
				subagentRunId: "child-run",
				subagentTaskId: "child-run:0",
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			},
		],
	},
];

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_color: string, text: string) => text,
};
const keybindings = { matches: (_data: string, _binding: string) => false };
const tui = { terminal: { rows: 32 }, requestRender: () => {} };

function assert(name: string, condition: boolean, detail: string): void {
	if (!condition) throw new Error(`${name}: ${detail}`);
	console.log(`PASS: ${name}`);
}

const summaries = buildTeamRoleSummaries(team as any, runs as any);
const dashboard = new TeamDashboard(
	tui as any,
	theme as any,
	keybindings as any,
	() => runs as any,
	() => () => {},
	() => {},
	() => {},
	() => [team as any, maintenance as any],
);
dashboard.handleInput("r");
assert(
	"teams dashboard opens the role inspector",
	dashboard.render(80).join("\n").includes("Team roles"),
	"role view did not open",
);
dashboard.dispose();

assert(
	"role projection resolves effective settings and counts instances",
	summaries[0].name === "builder" &&
		summaries[0].activeInstances === 1 &&
		summaries[0].maxInstances === 2 &&
		summaries[0].modelFallback === "test/builder" &&
		summaries[1].plannedInstances === 0,
	JSON.stringify(summaries),
);

let closed = false;
const inspector = new TeamRoleInspector(
	tui as any,
	theme as any,
	keybindings as any,
	() => [team as any, maintenance as any],
	() => runs as any,
	() => () => {},
	() => {
		closed = true;
	},
);
const initial = inspector.render(80);
assert(
	"role inspector renders definition and live instance details",
	initial.every((line) => visibleWidth(line) === 80) &&
		initial.join("\n").includes("product / builder") &&
		initial.join("\n").includes("Cross-functional product team.") &&
		initial.join("\n").includes("child child-run/child-run:0"),
	initial.join("\n"),
);

inspector.handleInput("\u001b[B");
const gateView = inspector.render(80);
assert(
	"role inspector shows child instructions",
	gateView.join("\n").includes("Child instructions") &&
		gateView.join("\n").includes("Challenge correctness with concrete findings."),
	gateView.join("\n"),
);
inspector.handleInput("\t");
inspector.handleInput("\u001b[B");
const second = inspector.render(48);
assert(
	"role inspector supports multiple teams and narrow rendering",
	second.every((line) => visibleWidth(line) === 48) && second.join("\n").includes("maintenance"),
	second.join("\n"),
);
inspector.handleInput("\u001b");
assert("role inspector closes from team selection", closed, "Esc did not close the inspector");
inspector.dispose();
