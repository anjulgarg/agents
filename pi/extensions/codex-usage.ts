import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI } from "@earendil-works/pi-tui";

import {
	codexUsageClient,
	CodexUsageError,
	resolveCodexCredentials,
	selectResetCredit,
	type CodexCredentials,
	type CodexResetResult,
	type CodexUsageClient,
	type CodexUsageReport,
	type CodexUsageWindow,
} from "./lib/codex-usage.ts";
import { fullscreenOverlayOptions, renderFullscreenScreen } from "./lib/tui/index.ts";

const REQUEST_TIMEOUT_MS = 10_000;

function formatPercent(value: number | undefined): string {
	if (value === undefined) return "unknown";
	return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

function formatWindowDuration(seconds: number | undefined, fallback: string): string {
	if (seconds === undefined) return fallback;
	const days = seconds / 86_400;
	if (Number.isInteger(days) && days >= 1) return `${days} ${days === 1 ? "day" : "days"}`;
	const hours = seconds / 3_600;
	if (Number.isInteger(hours) && hours >= 1) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	return fallback;
}

function formatResetTime(timestamp: number | undefined): string {
	if (timestamp === undefined) return "reset time unavailable";
	return `resets ${new Date(timestamp).toLocaleString()}`;
}

function formatWindow(window: CodexUsageWindow, fallback: string): string {
	return [
		`${formatWindowDuration(window.durationSeconds, fallback)}: ${formatPercent(window.usedPercent)} used`,
		`${formatPercent(window.remainingPercent)} remaining`,
		formatResetTime(window.resetsAt),
	].join(" · ");
}

export function formatUsageReport(report: CodexUsageReport): string[] {
	const lines = [
		`Plan: ${report.planType ?? "unknown"}`,
		report.limitReached
			? "Status: limit reached"
			: report.allowed === false
				? "Status: unavailable"
				: "Status: available",
		"",
	];
	if (report.primary) lines.push(formatWindow(report.primary, "Primary window"));
	if (report.secondary) lines.push(formatWindow(report.secondary, "Secondary window"));
	if (!report.primary && !report.secondary) lines.push("No standard quota windows reported.");

	for (const limit of report.additionalLimits) {
		if (limit.primary)
			lines.push(`${limit.name} · ${formatWindow(limit.primary, "Primary window")}`);
		if (limit.secondary)
			lines.push(`${limit.name} · ${formatWindow(limit.secondary, "Secondary window")}`);
	}
	lines.push("", `Saved resets: ${report.resetCreditsAvailable}`);
	if (report.resetCreditsAvailable > 0) lines.push("Run /usage reset to consume one.");
	lines.push(`Updated: ${new Date(report.fetchedAt).toLocaleString()}`);
	return lines;
}

class CodexUsageView {
	constructor(
		private readonly report: CodexUsageReport,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly tui: TUI,
	) {}

	render(width: number): string[] {
		const body = formatUsageReport(this.report).map((line) => this.theme.fg("text", line));
		return renderFullscreenScreen({
			width,
			height: Math.max(0, Math.floor(this.tui.terminal.rows)),
			title: "Codex Usage",
			subtitle: "ChatGPT plan quota and saved resets",
			body,
			keyHints: [
				{ key: "Esc", label: "close" },
				{ key: "Ctrl+C", label: "close" },
			],
			theme: this.theme,
			footerPadding: 1,
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.done();
	}

	invalidate(): void {}
}

async function showUsage(ctx: ExtensionCommandContext, report: CodexUsageReport): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(formatUsageReport(report).join("\n"), "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new CodexUsageView(report, theme, done, tui),
		fullscreenOverlayOptions(),
	);
}

function describeResetResult(result: CodexResetResult): string {
	switch (result.code) {
		case "already_redeemed":
			return "That Codex reset was already consumed.";
		case "no_credit":
			return "No Codex reset credit is currently available.";
		case "nothing_to_reset":
			return "Codex reports that there is no active limit window to reset.";
		default:
			return `Codex reset failed (${result.code}, HTTP ${result.status}).`;
	}
}

function formatCreditExpiry(expiresAt: string | undefined): string {
	if (!expiresAt) return "Expiry unavailable.";
	const timestamp = Date.parse(expiresAt);
	return Number.isFinite(timestamp)
		? `Credit expires ${new Date(timestamp).toLocaleString()}.`
		: `Credit expiry: ${expiresAt}.`;
}

async function runReset(
	ctx: ExtensionCommandContext,
	client: CodexUsageClient,
	credentials: CodexCredentials,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/usage reset requires interactive confirmation.", "error");
		return;
	}
	const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const usage = await client.getUsage(credentials, { force: true, signal });
	if (usage.resetCreditsAvailable < 1) {
		ctx.ui.notify("No Codex reset credit is currently available.", "info");
		return;
	}
	const credits = await client.listResetCredits(credentials, signal);
	const selected = selectResetCredit(credits);
	if (!selected) {
		ctx.ui.notify(
			"Codex reports a saved reset, but no redeemable credit details are available.",
			"error",
		);
		return;
	}
	const confirmed = await ctx.ui.confirm(
		"Consume one Codex reset?",
		[
			"This will immediately attempt to reset your current Codex rate-limit window and cannot be undone.",
			`${credits.availableCount} reset(s) available. ${formatCreditExpiry(selected.expiresAt)}`,
		].join(" "),
	);
	if (!confirmed) {
		ctx.ui.notify("Codex reset cancelled.", "info");
		return;
	}

	const result = await client.consumeResetCredit(
		credentials,
		selected.id,
		AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	);
	if (!result.ok) {
		ctx.ui.notify(describeResetResult(result), "error");
		return;
	}
	ctx.ui.notify("Codex reset consumed.", "info");
	try {
		await showUsage(
			ctx,
			await client.getUsage(credentials, {
				force: true,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}),
		);
	} catch {
		// Consumption succeeded. A follow-up refresh failure must not obscure that result.
	}
}

export function registerCodexUsageExtension(
	pi: ExtensionAPI,
	client: CodexUsageClient = codexUsageClient,
): void {
	pi.registerCommand("usage", {
		description: "Show Codex plan usage or consume a saved reset",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{ value: "show", label: "show", description: "Refresh Codex plan usage" },
				{ value: "reset", label: "reset", description: "Confirm and consume one saved reset" },
			];
			const matches = options.filter((option) =>
				option.value.startsWith(prefix.trim().toLowerCase()),
			);
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "show";
			if (action !== "show" && action !== "reset") {
				ctx.ui.notify("Usage: /usage [show|reset]", "error");
				return;
			}
			const credentials = await resolveCodexCredentials(ctx);
			if (!credentials) {
				ctx.ui.notify(
					"Codex subscription authentication is not configured. Run /login openai-codex.",
					"error",
				);
				return;
			}
			try {
				if (action === "reset") {
					await runReset(ctx, client, credentials);
					return;
				}
				const report = await client.getUsage(credentials, {
					force: true,
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				await showUsage(ctx, report);
			} catch (error) {
				const message =
					error instanceof CodexUsageError || error instanceof Error
						? error.message
						: String(error);
				ctx.ui.notify(`Could not load Codex usage: ${message}`, "error");
			}
		},
	});
}

export default function codexUsageExtension(pi: ExtensionAPI): void {
	registerCodexUsageExtension(pi);
}
