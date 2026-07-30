export interface ModelUsageMetrics {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	model?: string;
	effort?: string;
}

export interface ModelUsageFormatOptions {
	model?: string;
	effort?: string;
	pending?: boolean;
}

function safeCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function formatCount(value: number): string {
	return safeCount(value).toLocaleString("en-US");
}

function formatCost(value: number): string {
	const cost = Number.isFinite(value) ? Math.max(0, value) : 0;
	if (cost > 0 && cost < 0.0001) return `$${cost.toFixed(6)}`;
	return `$${cost.toFixed(4)}`;
}

/**
 * Format the standard two-line model request summary used by generated views.
 * Input is total prompt traffic, including cache reads and writes.
 */
export function formatModelUsageLines(
	usage: ModelUsageMetrics | undefined,
	options: ModelUsageFormatOptions = {},
): string[] {
	const model = usage?.model ?? options.model ?? "unavailable";
	const effort = usage?.effort ?? options.effort ?? "unknown";
	const identity = `Model ${model} · Effort ${effort}`;

	if (options.pending) {
		return [identity, "Input pending · Output pending · Cache pending · Cost pending"];
	}
	if (!usage) {
		return [
			identity,
			"Input unavailable · Output unavailable · Cache unavailable · Cost unavailable",
		];
	}

	const uncached = safeCount(usage.input);
	const cacheRead = safeCount(usage.cacheRead);
	const cacheWrite = safeCount(usage.cacheWrite);
	const totalInput = uncached + cacheRead + cacheWrite;
	let cache =
		cacheRead > 0
			? `hit ${formatCount(cacheRead)} (${totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0}%)`
			: "miss";
	if (cacheWrite > 0) cache += ` · wrote ${formatCount(cacheWrite)}`;

	return [
		identity,
		`Input ${formatCount(totalInput)} · Output ${formatCount(usage.output)} · Cache ${cache} · Cost ${formatCost(usage.cost)}`,
	];
}
