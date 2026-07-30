/**
 * /jobs command and full-screen TUI overlay for browsing background jobs.
 *
 * Follows the same patterns as CheckpointsView (git-checkpoint.ts) and
 * SubagentThreadView (subagent/ui.ts): selectable list with shared chrome
 * from ../lib/tui/, live polling refresh, and keybindings consistent with
 * /subagents and /checkpoints.
 *
 * The list opens a per-job log view (Enter) and can kill the selected job (x)
 * or every active job (Shift+X). Kills use a two-press confirmation like
 * /subagents; `k` stays bound to vim-style navigation here, so the kill keys
 * are x/Shift+X instead.
 */

import {
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	formatToolDuration,
	fullscreenOverlayOptions,
	getContentWidth,
	renderFullscreenScreen,
	ScrollViewportController,
	SelectableViewportState,
	type KeyHint,
	type ViewportRange,
} from "../lib/tui/index.ts";
import { formatBytes, jobDisplayName, jobOutcomeEmphasis, jobOutcomeLabel } from "./tools.ts";
import { isTerminalJobStatus, type JobManagerApi, type JobSnapshot } from "./contracts.ts";

/** How often to poll manager.status() for live updates while the overlay is open. */
const POLL_INTERVAL_MS = 1000;

/** Rows consumed by the title, the header divider, and the whole footer. */
const SCREEN_CHROME_ROWS = 5;

/** Recorded on the job and echoed in the wake, so agent cancels stay distinguishable. */
const USER_CANCEL_REASON = "cancelled by the user from /jobs";

type KillTarget = "job" | "all";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function newestFirst(jobs: JobSnapshot[]): JobSnapshot[] {
	return [...jobs].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Wall-clock start time, `hh:mm:ss am` for jobs started today and
 * `MM-DD hh:mm am` for older ones, so restored sessions never show a
 * misleading bare clock. Hours stay zero-padded to keep the column aligned.
 */
function formatStartTime(startedAt: number, now: number = Date.now()): string {
	const started = new Date(startedAt);
	if (Number.isNaN(started.getTime())) return "--:--:-- --";
	const pad = (value: number): string => String(value).padStart(2, "0");
	const hours24 = started.getHours();
	const clock = `${pad(hours24 % 12 === 0 ? 12 : hours24 % 12)}:${pad(started.getMinutes())}`;
	const meridiem = hours24 < 12 ? "am" : "pm";
	const today = new Date(now);
	const sameDay =
		started.getFullYear() === today.getFullYear() &&
		started.getMonth() === today.getMonth() &&
		started.getDate() === today.getDate();
	if (!sameDay) {
		return `${pad(started.getMonth() + 1)}-${pad(started.getDate())} ${clock} ${meridiem}`;
	}
	return `${clock}:${pad(started.getSeconds())} ${meridiem}`;
}

/**
 * Two-press kill confirmation shared by the list and the log view.
 *
 * The first press arms, the second one cancels. manager.cancel() settles
 * asynchronously (SIGTERM, then SIGKILL), so the outcome is reported through a
 * transient notice rather than by blocking input.
 */
class KillController {
	armed?: KillTarget;
	notice?: string;

	constructor(
		private readonly manager: JobManagerApi,
		private readonly onChange: () => void,
	) {}

	/** Footer hints while armed; undefined when the normal hints apply. */
	hints(): KeyHint[] | undefined {
		if (this.armed === "all") {
			return [
				{ key: "Shift+X", label: "again to KILL ALL jobs" },
				{ key: "Esc", label: "cancel" },
			];
		}
		if (this.armed === "job") {
			return [
				{ key: "x", label: "again to KILL this job" },
				{ key: "Esc", label: "cancel" },
			];
		}
		return undefined;
	}

	request(target: KillTarget, candidates: JobSnapshot[]): void {
		const live = candidates.filter((job) => !isTerminalJobStatus(job.status));
		if (live.length === 0) {
			this.armed = undefined;
			this.notice = target === "all" ? "No active jobs to kill." : "That job already finished.";
			this.onChange();
			return;
		}
		if (this.armed !== target) {
			this.armed = target;
			this.notice = undefined;
			this.onChange();
			return;
		}
		this.armed = undefined;
		this.notice =
			live.length === 1 ? `Killing ${jobDisplayName(live[0]!)}…` : `Killing ${live.length} jobs…`;
		this.onChange();
		void this.run(live);
	}

	/** Returns true when the press was consumed by disarming. */
	disarm(): boolean {
		if (this.armed === undefined) return false;
		this.armed = undefined;
		this.onChange();
		return true;
	}

	clearNotice(): void {
		if (this.notice === undefined) return;
		this.notice = undefined;
		this.onChange();
	}

	private async run(targets: JobSnapshot[]): Promise<void> {
		const settled = await Promise.allSettled(
			targets.map((job) => this.manager.cancel(job.jobId, USER_CANCEL_REASON)),
		);
		const failures = settled.filter(
			(outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
		);
		if (failures.length === 0) {
			this.notice =
				targets.length === 1
					? `Killed ${jobDisplayName(targets[0]!)}.`
					: `Killed ${targets.length} jobs.`;
		} else {
			this.notice =
				`Kill failed for ${failures.length} of ${targets.length}: ` +
				errorText(failures[0]!.reason);
		}
		this.onChange();
	}
}

/**
 * Full-screen log for one job: metadata header plus captured output.
 *
 * Output comes from manager.result(), which returns the whole retained buffer;
 * the list snapshots only carry a short tail. The view follows new output until
 * the user scrolls up, and End resumes following.
 */
export class JobLogView implements Component {
	private readonly scroll = new ScrollViewportController();
	private readonly kill: KillController;
	private job?: JobSnapshot;
	private output = "";
	private loadError?: string;
	private followTail = true;
	private wrapWidth = -1;
	private wrapSource?: string;
	private wrapped: string[] = [];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly manager: JobManagerApi,
		private readonly jobId: string,
		private readonly back: () => void,
		private readonly close: () => void,
	) {
		this.kill = new KillController(manager, () => this.tui.requestRender());
		this.refresh();
	}

	/** Driven by the list's poll timer; the log view owns no timer of its own. */
	refresh(): void {
		try {
			const result = this.manager.result(this.jobId);
			this.job = result.snapshot;
			this.output = result.output;
			this.loadError = undefined;
		} catch (error) {
			this.loadError = errorText(error);
		}
	}

	private outputLines(width: number): string[] {
		if (this.wrapSource === this.output && this.wrapWidth === width) return this.wrapped;
		const trimmed = this.output.replace(/\n+$/, "");
		this.wrapped =
			trimmed === ""
				? []
				: trimmed
						.split("\n")
						.flatMap((line) =>
							line === "" ? [""] : wrapTextWithAnsi(this.theme.fg("toolOutput", line), width),
						);
		this.wrapSource = this.output;
		this.wrapWidth = width;
		return this.wrapped;
	}

	private headerLines(job: JobSnapshot): string[] {
		const muted = (text: string): string => this.theme.fg("muted", text);
		const outcome = jobOutcomeLabel(job);
		const emphasis = jobOutcomeEmphasis(job);
		const state = outcome ? `${job.status} · ${outcome}` : job.status;
		const stateColor = emphasis ?? (isTerminalJobStatus(job.status) ? "success" : "warning");
		const summary = [
			this.theme.fg(stateColor, state),
			muted(`started ${formatStartTime(job.startedAt)}`),
			muted(formatToolDuration(job.durationMs) ?? "0.0s"),
			muted(
				`${job.outputLines} lines · ${formatBytes(job.outputBytes)}${job.truncated ? " · truncated" : ""}`,
			),
		].join(muted(" · "));
		const lines = [
			summary,
			muted(
				[
					`cwd ${job.cwd}`,
					`pid ${job.pid ?? "none"}`,
					`timeout ${Math.round(job.timeoutMs / 1000)}s`,
					job.jobId,
				].join(" · "),
			),
		];
		if (job.cancelReason) lines.push(muted(`cancel reason ${job.cancelReason}`));
		if (job.error) lines.push(this.theme.fg("error", `error ${job.error}`));
		return lines;
	}

	private subtitle(total: number, range: ViewportRange): string {
		if (this.kill.notice) return this.kill.notice;
		if (total === 0) return "no output";
		if (this.followTail) return `following · ${total} lines`;
		return `lines ${range.start + 1}-${range.end} of ${total}`;
	}

	private keyHints(job: JobSnapshot): KeyHint[] {
		const armed = this.kill.hints();
		if (armed) return armed;
		const hints: KeyHint[] = [
			{ key: "↑↓/PgUp/PgDn", label: "scroll" },
			{ key: "End", label: "follow" },
		];
		if (!isTerminalJobStatus(job.status)) hints.push({ key: "x", label: "kill" });
		hints.push({ key: "Esc", label: "back" });
		return hints;
	}

	render(width: number): string[] {
		const height = Math.max(0, Math.floor(this.tui.terminal.rows));
		const renderWidth = Math.max(1, width);
		const job = this.job;
		if (!job) {
			return renderFullscreenScreen({
				width: renderWidth,
				height,
				title: "Job",
				body: [this.theme.fg("error", this.loadError ?? "This job is no longer available.")],
				keyHints: [{ key: "Esc", label: "back" }],
				theme: this.theme,
			});
		}

		const headerLines = this.headerLines(job);
		const content = this.outputLines(getContentWidth(renderWidth));
		const bodyHeight = Math.max(0, height - headerLines.length - SCREEN_CHROME_ROWS);
		this.scroll.update(content.length, bodyHeight);
		if (this.followTail) this.scroll.end(true);
		const range = this.scroll.range;

		return renderFullscreenScreen({
			width: renderWidth,
			height,
			title: jobDisplayName(job),
			subtitle: this.subtitle(content.length, range),
			headerLines,
			body:
				content.length === 0
					? [this.theme.fg("dim", "(no output captured)")]
					: content.slice(range.start, range.end),
			keyHints: this.keyHints(job),
			theme: this.theme,
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") && this.kill.disarm()) return;
		if (matchesKey(data, "x")) {
			this.kill.request("job", this.job ? [this.job] : []);
			return;
		}
		this.kill.disarm();
		this.kill.clearNotice();

		if (matchesKey(data, "escape") || matchesKey(data, "left") || data === "q") {
			this.back();
			return;
		}
		if (matchesKey(data, "f6")) {
			this.close();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.scroll.scrollBy(-1);
			this.followTail = false;
		} else if (matchesKey(data, "down") || data === "j") {
			this.scroll.scrollBy(1);
			this.followTail = false;
		} else if (matchesKey(data, "pageUp")) {
			this.scroll.pageBy(-1);
			this.followTail = false;
		} else if (matchesKey(data, "pageDown")) {
			this.scroll.pageBy(1);
			this.followTail = false;
		} else if (matchesKey(data, "home")) {
			this.scroll.home();
			this.followTail = false;
		} else if (matchesKey(data, "end")) {
			this.scroll.end(true);
			this.followTail = true;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	invalidate(): void {}
}

/**
 * Full-screen overlay for browsing background jobs.
 *
 * Jobs are listed by start time, most recently invoked first, each row showing
 * the wall-clock time it was invoked. The list is capped at STATUS_LIST_LIMIT
 * via the manager's status() result. A polling interval keeps the view live
 * while open; it is cleared when the view closes.
 */
export class JobsListView implements Component {
	private readonly selection = new SelectableViewportState();
	private readonly kill: KillController;
	private readonly pollTimer: ReturnType<typeof setInterval>;
	private jobs: JobSnapshot[] = [];
	private log?: JobLogView;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly manager: JobManagerApi,
		private readonly done: () => void,
	) {
		this.kill = new KillController(manager, () => this.tui.requestRender());
		this.refresh();
		this.pollTimer = setInterval(() => {
			this.refresh();
			this.log?.refresh();
			this.tui.requestRender();
		}, POLL_INTERVAL_MS);
		this.pollTimer.unref?.();
	}

	private refresh(): void {
		this.jobs = newestFirst(this.manager.status());
	}

	private jobLine(job: JobSnapshot, selected: boolean, width: number): string {
		const isActive = !isTerminalJobStatus(job.status);
		const name = jobDisplayName(job);
		const duration = formatToolDuration(job.durationMs) ?? "0.0s";
		const icon = isActive
			? this.theme.fg("warning", "◌")
			: job.status === "completed"
				? this.theme.fg("success", "✓")
				: this.theme.fg("error", "✗");
		const outcome = jobOutcomeLabel(job);
		const emphasis = jobOutcomeEmphasis(job);

		let suffix: string;
		if (isActive) {
			suffix = `· ${this.theme.fg("warning", job.status)} ${this.theme.fg("muted", duration)}`;
		} else if (outcome && emphasis) {
			suffix = `· ${this.theme.fg(emphasis, outcome)} · ${this.theme.fg("muted", duration)}`;
		} else if (outcome) {
			suffix = `· ${this.theme.fg("muted", outcome)} · ${this.theme.fg("muted", duration)}`;
		} else {
			suffix = `· ${this.theme.fg("muted", duration)}`;
		}

		const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
		const started = this.theme.fg("muted", formatStartTime(job.startedAt));
		const line = `${prefix}${icon} ${started} ${this.theme.fg("text", name)} ${suffix}`;
		return truncateToWidth(line, width, "…");
	}

	private keyHints(activeCount: number): KeyHint[] {
		const armed = this.kill.hints();
		if (armed) return armed;
		const hints: KeyHint[] = [
			{ key: "↑↓", label: "j/k select" },
			{ key: "Enter", label: "log" },
		];
		if (activeCount > 0) {
			hints.push({ key: "x", label: "kill" }, { key: "Shift+X", label: "kill all" });
		}
		hints.push({ key: "Esc", label: "close" });
		return hints;
	}

	private openLog(job: JobSnapshot): void {
		this.log = new JobLogView(
			this.tui,
			this.theme,
			this.manager,
			job.jobId,
			() => {
				this.log = undefined;
				this.tui.requestRender();
			},
			() => this.done(),
		);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.log) return this.log.render(width);

		const height = Math.max(0, Math.floor(this.tui.terminal.rows));
		const renderWidth = Math.max(1, width);
		const count = this.jobs.length;
		const activeCount = this.jobs.filter((job) => !isTerminalJobStatus(job.status)).length;
		const counts = `${count} job${count === 1 ? "" : "s"}${activeCount > 0 ? ` (${activeCount} active)` : ""}`;
		const subtitle = this.kill.notice ? `${counts} · ${this.kill.notice}` : counts;

		const bodyHeight = Math.max(0, height - SCREEN_CHROME_ROWS);
		let body: string[];
		if (count === 0) {
			body = [this.theme.fg("dim", "No jobs in this session.")];
		} else {
			const range = this.selection.update(count, bodyHeight);
			body = [];
			for (let index = range.start; index < range.end; index++) {
				body.push(this.jobLine(this.jobs[index]!, index === this.selection.selected, renderWidth));
			}
		}

		return renderFullscreenScreen({
			width: renderWidth,
			height,
			title: "Jobs",
			subtitle,
			body,
			keyHints: this.keyHints(activeCount),
			theme: this.theme,
		});
	}

	handleInput(data: string): void {
		if (this.log) {
			this.log.handleInput(data);
			return;
		}
		if (matchesKey(data, "escape") && this.kill.disarm()) return;
		const killAll = matchesKey(data, "shift+x");
		if (killAll || matchesKey(data, "x")) {
			const selected = this.jobs[this.selection.selected];
			this.kill.request(killAll ? "all" : "job", killAll ? this.jobs : selected ? [selected] : []);
			return;
		}
		this.kill.disarm();
		this.kill.clearNotice();

		if (matchesKey(data, "escape") || matchesKey(data, "f6") || data === "q") {
			this.done();
			return;
		}
		if (this.jobs.length === 0) return;

		if (matchesKey(data, "enter") || matchesKey(data, "right") || data === "l") {
			const job = this.jobs[this.selection.selected];
			if (job) this.openLog(job);
			return;
		}

		const previous = this.selection.selected;
		if (matchesKey(data, "up") || data === "k") {
			this.selection.moveBy(-1, this.jobs.length);
		} else if (matchesKey(data, "down") || data === "j") {
			this.selection.moveBy(1, this.jobs.length);
		} else if (matchesKey(data, "pageUp")) {
			this.selection.pageBy(-1, this.jobs.length);
		} else if (matchesKey(data, "pageDown")) {
			this.selection.pageBy(1, this.jobs.length);
		} else if (matchesKey(data, "home")) {
			this.selection.home();
		} else if (matchesKey(data, "end")) {
			this.selection.end(this.jobs.length);
		} else {
			return;
		}
		if (this.selection.selected !== previous) this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.pollTimer);
	}
}

export function registerJobCommand(pi: ExtensionAPI, manager: JobManagerApi): void {
	pi.registerCommand("jobs", {
		description: "List background jobs in this session (active first, then recent terminal jobs)",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Jobs require interactive mode.", "warning");
				return;
			}
			const jobs = manager.status();
			if (jobs.length === 0) {
				ctx.ui.notify("No jobs in this session.", "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new JobsListView(tui, theme, manager, done),
				fullscreenOverlayOptions(),
			);
		},
	});
}
