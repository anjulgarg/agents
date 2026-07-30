import { extractTitleText, normalizeSessionTitle } from "../session-title/core.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

assert(
	"normalizes AI titles to compact kebab case",
	normalizeSessionTitle("  Publish Command Extension!  ") === "publish-command-extension",
	normalizeSessionTitle("  Publish Command Extension!  "),
);
assert(
	"limits AI titles to three words",
	normalizeSessionTitle("Improve Automatic Session Title Generation") ===
		"improve-automatic-session",
	normalizeSessionTitle("Improve Automatic Session Title Generation"),
);
assert(
	"extracts only textual model output",
	extractTitleText([
		{ type: "thinking", text: "ignore this" },
		{ type: "text", text: "Session Title" },
	]) === "Session Title",
	extractTitleText([{ type: "text", text: "Session Title" }]),
);
