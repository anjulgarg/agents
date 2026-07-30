import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createFooter, wrapFooterSegments } from "../claude-code-ui.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

let branch: string | null = "main";
let branchChanged: (() => void) | undefined;
let renderRequests = 0;
let unsubscribed = false;
const footerData = {
	getGitBranch: () => branch,
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 1,
	onBranchChange(callback: () => void) {
		branchChanged = callback;
		return () => {
			unsubscribed = true;
		};
	},
} satisfies ReadonlyFooterDataProvider;
const ctx = {
	cwd: "/home/tester/.pi/agent/worktrees/dotfiles/worktree-list-tui-abd62747",
	model: {
		provider: "openai-codex",
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		contextWindow: 272_000,
	},
	getContextUsage: () => ({ tokens: 34_000, percent: 12.5 }),
} as unknown as ExtensionContext;
let mode = "auto";
const footer = createFooter(
	ctx,
	footerData,
	() => false,
	() => "medium",
	() => false,
	() => ({ fiveHourRemaining: 92, weeklyRemaining: 81 }),
	() => {
		renderRequests++;
	},
	() => mode,
);

const wideLines = footer.render(240);
const wide = wideLines.join("\n");
const narrowLines = footer.render(72);
const narrow = narrowLines.join("\n");

assert(
	"keeps all footer components on one line when they fit",
	wideLines.length === 1 &&
		wide.includes("auto") &&
		wide.includes("main") &&
		wide.includes(ctx.cwd) &&
		wide.includes("gpt-5.6 sol medium") &&
		wide.includes("34k/272k (13%)") &&
		wide.includes("5h 92%") &&
		wide.includes("7d 81%"),
	wide,
);
assert(
	"wraps whole footer components without truncating them",
	narrowLines.length > 1 &&
		narrowLines.every((line: string) => visibleWidth(line) <= 72) &&
		narrow.includes(ctx.cwd) &&
		narrow.includes("gpt-5.6 sol medium") &&
		!narrow.includes("…"),
	narrow,
);
assert(
	"wraps an oversized component without losing content",
	wrapFooterSegments(["alpha", "abcdefghijkl", "omega"], 5).join("") === "alphaabcdefghijklomega",
	JSON.stringify(wrapFooterSegments(["alpha", "abcdefghijkl", "omega"], 5)),
);
branch = "feature/reactive-footer";
branchChanged?.();
const updated = footer.render(240).join("\n");
assert(
	"reads the latest branch from Pi footer data",
	wide.includes("main") && updated.includes("feature/reactive-footer"),
	`${wide}\n${updated}`,
);
assert(
	"requests a render when Pi reports a branch change",
	renderRequests === 1,
	`render requests: ${renderRequests}`,
);
assert(
	"orders mode, branch, cwd, model, context, and quota components",
	wide.indexOf("auto") < wide.indexOf("main") &&
		wide.indexOf("main") < wide.indexOf(ctx.cwd) &&
		wide.indexOf(ctx.cwd) < wide.indexOf("gpt-5.6 sol medium") &&
		wide.indexOf("gpt-5.6 sol medium") < wide.indexOf("34k/272k (13%)") &&
		wide.indexOf("34k/272k (13%)") < wide.indexOf("5h 92%"),
	wide,
);
mode = "plan";
const planned = footer.render(240).join("\n");
assert(
	"shows the plan mode label at far-left in plan mode",
	planned.includes("plan") && planned.indexOf("plan") < planned.indexOf("feature/reactive-footer"),
	planned,
);
footer.dispose();
assert(
	"unsubscribes when the custom footer is disposed",
	unsubscribed,
	"branch subscription remained active",
);
