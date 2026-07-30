import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PATCH_MARKER = Symbol.for("dotfiles.pi.hide-thinking-history");

type PatchablePrototype = typeof AssistantMessageComponent.prototype & {
	[PATCH_MARKER]?: true;
};

/** Remove thinking only from the renderer input, preserving the original message. */
export function withoutThinkingForDisplay(message: AssistantMessage): AssistantMessage {
	const content = message.content.filter((part) => part.type !== "thinking");
	return content.length === message.content.length ? message : { ...message, content };
}

export function installThinkingHistoryFilter(): void {
	const prototype = AssistantMessageComponent.prototype as PatchablePrototype;
	if (prototype[PATCH_MARKER]) return;

	const renderMessage = prototype.updateContent;
	prototype.updateContent = function (message: AssistantMessage): void {
		renderMessage.call(this, withoutThinkingForDisplay(message));
	};
	Object.defineProperty(prototype, PATCH_MARKER, { value: true });
}

export default function (_pi: ExtensionAPI): void {
	installThinkingHistoryFilter();
}
