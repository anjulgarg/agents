import { basename, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

import {
	fullscreenOverlayOptions,
	getContentWidth,
	renderFullscreenScreen,
} from "../lib/tui/index.ts";
import {
	resolveSessionSearchRoot,
	SessionSearchIndex,
	type RefreshProgress,
	type RefreshSummary,
	type SessionSearchResult,
	type TextMatchRange,
} from "./core.ts";
import { createSessionPinStore, type SessionPinStore } from "./pins.ts";

export {
	buildSnippet,
	discoverSessionFiles,
	extractEntryText,
	findTextMatchRanges,
	normalizeSearchText,
	parseSessionFile,
	resolveSessionSearchRoot,
	SessionSearchIndex,
} from "./core.ts";
export { createSessionPinStore, GLOBAL_SESSION_PINS_PATH } from "./pins.ts";

function formatAge(date: Date): string {
	const elapsed = Math.max(0, Date.now() - date.getTime());
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

function projectLabel(cwd: string): string {
	return cwd ? basename(cwd) || cwd : "unknown project";
}

export function highlightMatchedText(
	text: string,
	ranges: readonly TextMatchRange[],
	theme: Theme,
): string {
	let rendered = "";
	let cursor = 0;
	for (const range of ranges) {
		const start = Math.max(cursor, Math.min(text.length, range.start));
		const end = Math.max(start, Math.min(text.length, range.end));
		if (start > cursor) rendered += theme.fg("text", text.slice(cursor, start));
		if (end > start) rendered += theme.inverse(theme.bold(text.slice(start, end)));
		cursor = end;
	}
	if (cursor < text.length) rendered += theme.fg("text", text.slice(cursor));
	return rendered || theme.fg("text", text);
}

export class FindSessionsView implements Component, Focusable {
	readonly controller = new AbortController();
	private readonly input = new Input();
	private state: "indexing" | "ready" | "error" = "indexing";
	private progress: RefreshProgress = { loaded: 0, total: 0 };
	private summary?: RefreshSummary;
	private error?: string;
	private results: SessionSearchResult[] = [];
	private pinnedPaths: Set<string>;
	private pinBusy = false;
	private pinStatus?: { message: string; type: "info" | "error" };
	private allProjects = true;
	private selected = 0;
	private offset = 0;
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines?: string[];
	private _focused = false;

	constructor(
		private readonly index: SessionSearchIndex,
		private readonly theme: Theme,
		initialQuery: string,
		private readonly currentCwd: string,
		private readonly currentSessionFile: string | undefined,
		pinnedPaths: ReadonlySet<string>,
		private readonly setPinned: (path: string, pinned: boolean) => Promise<void>,
		private readonly done: (path: string | null) => void,
		private readonly tui: TUI,
	) {
		this.pinnedPaths = new Set(pinnedPaths);
		this.input.setValue(initialQuery);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	setProgress(progress: RefreshProgress): void {
		this.progress = progress;
		this.refresh();
	}

	setReady(summary: RefreshSummary): void {
		this.state = "ready";
		this.summary = summary;
		this.updateResults();
	}

	setError(error: string): void {
		this.state = "error";
		this.error = error;
		this.refresh();
	}

	private refresh(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	private updateResults(): void {
		this.results = this.index.search(this.input.getValue(), {
			cwd: this.allProjects ? undefined : this.currentCwd,
			pinnedPaths: this.pinnedPaths,
		});
		this.selected = Math.min(this.selected, Math.max(0, this.results.length - 1));
		this.revealSelected();
		this.refresh();
	}

	private visibleCount(): number {
		const height = Math.max(1, Math.floor(this.tui.terminal.rows));
		return Math.max(1, Math.floor((height - 8) / 3));
	}

	private revealSelected(): void {
		const visible = this.visibleCount();
		if (this.selected < this.offset) this.offset = this.selected;
		else if (this.selected >= this.offset + visible) this.offset = this.selected - visible + 1;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.results.length - visible)));
	}

	private async toggleSelectedPin(): Promise<void> {
		const selected = this.results[this.selected];
		if (!selected || this.pinBusy) return;
		const pinned = !selected.pinned;
		this.pinBusy = true;
		this.pinStatus = { message: pinned ? "Pinning session…" : "Unpinning session…", type: "info" };
		this.refresh();
		try {
			await this.setPinned(selected.path, pinned);
			if (pinned) this.pinnedPaths.add(resolve(selected.path));
			else this.pinnedPaths.delete(resolve(selected.path));
			this.updateResults();
			const nextIndex = this.results.findIndex(
				({ path }) => resolve(path) === resolve(selected.path),
			);
			if (nextIndex >= 0) this.selected = nextIndex;
			this.pinStatus = { message: pinned ? "Session pinned" : "Session unpinned", type: "info" };
		} catch (error) {
			this.pinStatus = {
				message: `Pin update failed: ${error instanceof Error ? error.message : String(error)}`,
				type: "error",
			};
		} finally {
			this.pinBusy = false;
			this.revealSelected();
			this.refresh();
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.controller.abort();
			this.done(null);
			return;
		}
		if (this.state !== "ready") return;
		if (matchesKey(data, "ctrl+p")) {
			void this.toggleSelectedPin();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.allProjects = !this.allProjects;
			this.selected = 0;
			this.offset = 0;
			this.updateResults();
			return;
		}
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down"))
			this.selected = Math.min(Math.max(0, this.results.length - 1), this.selected + 1);
		else if (matchesKey(data, "pageUp"))
			this.selected = Math.max(0, this.selected - this.visibleCount());
		else if (matchesKey(data, "pageDown"))
			this.selected = Math.min(
				Math.max(0, this.results.length - 1),
				this.selected + this.visibleCount(),
			);
		else if (matchesKey(data, "home")) this.selected = 0;
		else if (matchesKey(data, "end")) this.selected = Math.max(0, this.results.length - 1);
		else if (matchesKey(data, "enter")) {
			const selected = this.results[this.selected];
			if (selected) this.done(selected.path);
			return;
		} else {
			const previous = this.input.getValue();
			this.input.handleInput(data);
			if (this.input.getValue() !== previous) {
				this.selected = 0;
				this.offset = 0;
				this.updateResults();
			}
			return;
		}
		this.revealSelected();
		this.refresh();
	}

	private renderResults(width: number): string[] {
		if (this.results.length === 0) {
			return [
				this.theme.fg("warning", "No matching sessions"),
				this.theme.fg("dim", "Try fewer words, an incomplete identifier, or Tab to change scope."),
			].map((line) => truncateToWidth(line, width));
		}
		const lines: string[] = [];
		const visible = this.visibleCount();
		for (
			let index = this.offset;
			index < Math.min(this.results.length, this.offset + visible);
			index++
		) {
			const result = this.results[index]!;
			const selected = index === this.selected;
			const marker = selected ? this.theme.fg("accent", "❯") : " ";
			const pinMarker = result.pinned ? this.theme.fg("warning", "📌 ") : "";
			const title = result.name || result.snippet || "(no searchable text)";
			const isCurrent =
				this.currentSessionFile !== undefined &&
				resolve(result.path) === resolve(this.currentSessionFile);
			const separator = this.theme.fg("dim", " · ");
			const metadata = [
				isCurrent ? this.theme.fg("success", this.theme.bold("current")) : undefined,
				this.theme.fg("accent", this.theme.bold(projectLabel(result.cwd))),
				this.theme.fg("text", formatAge(result.modified)),
				this.theme.fg("text", result.source),
			]
				.filter((part): part is string => Boolean(part))
				.join(separator);
			const prefix = `${marker} `;
			const titleWidth = Math.max(
				1,
				width - visibleWidth(prefix) - visibleWidth(pinMarker) - visibleWidth(metadata) - 1,
			);
			const titleText = truncateToWidth(title, titleWidth, "…");
			const styledTitle = selected
				? this.theme.fg("accent", this.theme.bold(titleText))
				: titleText;
			const gap = Math.max(
				1,
				width -
					visibleWidth(prefix) -
					visibleWidth(pinMarker) -
					visibleWidth(styledTitle) -
					visibleWidth(metadata),
			);
			lines.push(
				truncateToWidth(`${prefix}${pinMarker}${styledTitle}${" ".repeat(gap)}${metadata}`, width),
			);
			const contextPrefix = `  ${this.theme.fg("accent", "↳")} `;
			const context = highlightMatchedText(result.snippet, result.matchRanges, this.theme);
			lines.push(truncateToWidth(`${contextPrefix}${context}`, width, "…"));
			lines.push("");
		}
		return lines;
	}

	render(width: number): string[] {
		const height = Math.max(1, Math.floor(this.tui.terminal.rows));
		if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height)
			return this.cachedLines;
		const contentWidth = getContentWidth(width);
		let body: string[];
		let subtitle: string;
		let hints: Array<{ key: string; label: string }>;
		if (this.state === "indexing") {
			const progress =
				this.progress.total > 0 ? `${this.progress.loaded}/${this.progress.total}` : "…";
			subtitle = `Indexing historical sessions ${progress}`;
			body = [
				"",
				this.theme.fg("accent", "Searching conversation text across your session history…"),
			];
			hints = [{ key: "Esc", label: "cancel" }];
		} else if (this.state === "error") {
			subtitle = "Index unavailable";
			body = ["", this.theme.fg("error", this.error ?? "Could not index historical sessions")];
			hints = [{ key: "Esc", label: "close" }];
		} else {
			const scope = this.allProjects ? "all projects" : projectLabel(this.currentCwd);
			const warnings = [
				this.summary?.failed ? `${this.summary.failed} unreadable` : "",
				this.summary?.malformedLines
					? `${this.summary.malformedLines} malformed lines skipped`
					: "",
			].filter(Boolean);
			const pinStatus = this.pinStatus
				? ` · ${this.pinStatus.type === "error" ? "⚠ " : ""}${this.pinStatus.message}`
				: "";
			subtitle = `${this.results.length} match${this.results.length === 1 ? "" : "es"} · ${scope}${warnings.length ? ` · ${warnings.join(" · ")}` : ""}${pinStatus}`;
			body = [
				this.theme.fg("muted", "Search"),
				...this.input.render(contentWidth),
				"",
				...this.renderResults(contentWidth),
			];
			const selectedResult = this.results[this.selected];
			hints = [
				{ key: "↑↓", label: "select" },
				{ key: "Enter", label: "resume" },
				{
					key: "Ctrl+P",
					label: selectedResult?.pinned ? "unpin" : "pin",
				},
				{ key: "Tab", label: this.allProjects ? "current project" : "all projects" },
				{ key: "Esc", label: "cancel" },
			];
		}
		const rendered = renderFullscreenScreen({
			width,
			height,
			title: "Find Sessions",
			subtitle,
			body,
			keyHints: hints,
			theme: this.theme,
			footerPadding: 1,
		});
		this.cachedWidth = width;
		this.cachedHeight = height;
		this.cachedLines = rendered;
		return rendered;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
		this.input.invalidate();
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function findExtension(
	pi: ExtensionAPI,
	pinStore: SessionPinStore = createSessionPinStore(),
): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	const index = new SessionSearchIndex();

	const registerPinCommand = (name: "session:pin" | "session:unpin", pinned: boolean): void => {
		pi.registerCommand(name, {
			description: `${pinned ? "Pin" : "Unpin"} the current session in /session:find`,
			handler: async (_args, ctx) => {
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) {
					ctx.ui.notify("Ephemeral sessions cannot be pinned", "error");
					return;
				}
				try {
					const changed = await pinStore.setPinned(sessionFile, pinned);
					const message = pinned
						? changed
							? "Session pinned in /session:find"
							: "Session is already pinned"
						: changed
							? "Session unpinned in /session:find"
							: "Session is not pinned";
					ctx.ui.notify(message, "info");
				} catch (error) {
					ctx.ui.notify(`Could not update session pin: ${errorText(error)}`, "error");
				}
			},
		});
	};

	registerPinCommand("session:pin", true);
	registerPinCommand("session:unpin", false);
	pi.registerCommand("session:find", {
		description: "Fuzzy-search complete historical sessions and resume one",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/session:find requires interactive mode", "error");
				return;
			}
			const initialQuery = args?.trim() ?? "";
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const currentCwd = ctx.cwd;
			const sessionsRoot = resolveSessionSearchRoot(
				ctx.sessionManager.getSessionDir(),
				join(getAgentDir(), "sessions"),
			);
			let pinnedPaths: ReadonlySet<string> = new Set();
			try {
				pinnedPaths = await pinStore.read();
			} catch (error) {
				ctx.ui.notify(`Could not load session pins: ${errorText(error)}`, "error");
			}
			const selectedPath = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
				const view = new FindSessionsView(
					index,
					theme,
					initialQuery,
					currentCwd,
					currentSessionFile,
					pinnedPaths,
					async (path, pinned) => {
						await pinStore.setPinned(path, pinned);
					},
					done,
					tui,
				);
				void index
					.refresh(sessionsRoot, view.controller.signal, (progress) => view.setProgress(progress))
					.then((summary) => view.setReady(summary))
					.catch((error: unknown) => {
						if (view.controller.signal.aborted) return;
						view.setError(errorText(error));
					});
				return view;
			}, fullscreenOverlayOptions());
			if (!selectedPath || selectedPath === currentSessionFile) return;
			await ctx.switchSession(selectedPath, {
				withSession: async (nextCtx) => {
					nextCtx.ui.notify("Resumed matching session", "info");
				},
			});
		},
	});
}
