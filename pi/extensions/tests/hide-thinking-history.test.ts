import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import hideThinkingHistory, {
	installThinkingHistoryFilter,
	withoutThinkingForDisplay,
} from "../hide-thinking-history.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

const thinking = { type: "thinking", thinking: "private reasoning" };
const text = { type: "text", text: "Visible answer" };
const original = { role: "assistant", content: [thinking, text] } as any;
const displayed = withoutThinkingForDisplay(original);

assert(
	"display copy omits thinking blocks",
	displayed !== original && displayed.content.length === 1 && displayed.content[0] === text,
	JSON.stringify(displayed),
);
assert(
	"original assistant message remains unchanged",
	original.content.length === 2 && original.content[0] === thinking,
	JSON.stringify(original),
);

const beforeInstall = AssistantMessageComponent.prototype.updateContent;
hideThinkingHistory({} as any);
const afterInstall = AssistantMessageComponent.prototype.updateContent;
installThinkingHistoryFilter();
assert(
	"renderer patch installs once",
	afterInstall !== beforeInstall &&
		AssistantMessageComponent.prototype.updateContent === afterInstall,
	"renderer patch was missing or was applied more than once",
);

const thinkingOnlyMessage = {
	role: "assistant",
	content: [thinking],
	api: "responses",
	provider: "test",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
} as any;
const rendered = new AssistantMessageComponent(thinkingOnlyMessage, true).render(80);
assert(
	"thinking-only history leaves no marker or blank line",
	rendered.length === 0,
	JSON.stringify(rendered),
);
