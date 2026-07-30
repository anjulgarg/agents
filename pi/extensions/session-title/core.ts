const MAX_TITLE_LENGTH = 48;
const MAX_TITLE_WORDS = 3;

export function normalizeSessionTitle(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.slice(0, MAX_TITLE_WORDS)
		.join("-")
		.slice(0, MAX_TITLE_LENGTH)
		.replace(/-+$/g, "");
}

export function extractTitleText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join(" ");
}
