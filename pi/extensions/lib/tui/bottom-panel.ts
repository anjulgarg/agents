import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

export const BOTTOM_PANEL_WIDGET_KEY = "activity-panel";
export const BOTTOM_PANEL_MAX_LINES = 10;
export const BOTTOM_PANEL_SECTION_ORDER = {
	asyncCommands: 10,
	subagents: 20,
	todos: 30,
} as const;

export type BottomPanelSectionRenderer = (width: number, theme: Theme) => readonly string[];

export interface BottomPanelSectionOptions {
	/** Lower values render closer to the top of the panel. */
	order: number;
	/** Hard maximum for this section, including a possible overflow hint. */
	maxLines: number;
	render: BottomPanelSectionRenderer;
	/** Called when the section has more lines than its allocated space. */
	overflowLabel?: (omitted: number, theme: Theme) => string;
	/** Optional repaint interval for time-based section rendering. */
	refreshIntervalMs?: number;
}

export type BottomPanelSectionPatch = Partial<
	Omit<BottomPanelSectionOptions, "refreshIntervalMs">
> & {
	/** Use null to stop a previously configured repaint interval. */
	refreshIntervalMs?: number | null;
};

interface StoredSection extends BottomPanelSectionOptions {
	id: string;
}

export interface BottomPanelSectionHandle {
	update(patch?: BottomPanelSectionPatch): void;
	remove(): void;
}

interface PanelContext {
	mode: ExtensionContext["mode"];
	ui: ExtensionContext["ui"];
}

class BottomPanelHost implements Component {
	constructor(
		private readonly panel: BottomPanel,
		private readonly tui: TUI,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		return this.panel.render(width, this.theme);
	}

	invalidate(): void {}

	dispose(): void {
		this.panel.hostDisposed(this);
	}

	getTui(): TUI {
		return this.tui;
	}
}

/**
 * Shared compositor for fixed widgets above the editor. Sections own only
 * their content and declaration; ordering, allocation, separators, and the
 * single host widget remain centralized here.
 */
export class BottomPanel {
	private readonly sections = new Map<string, StoredSection>();
	private ui?: ExtensionContext["ui"];
	private interactive = false;
	private mounted = false;
	private host?: BottomPanelHost;
	private refreshTimer?: ReturnType<typeof setInterval>;
	private refreshIntervalMs?: number;

	attach(context: PanelContext): void {
		const nextInteractive = context.mode === "tui";
		if (this.ui !== context.ui || this.interactive !== nextInteractive) {
			this.unmount();
			this.ui = context.ui;
			this.interactive = nextInteractive;
		}
		if (this.interactive && this.sections.size > 0) this.mount();
	}

	registerSection(id: string, options: BottomPanelSectionOptions): BottomPanelSectionHandle {
		const key = id.trim();
		if (!key) throw new Error("bottom panel section id must not be empty");
		const section: StoredSection = { id: key, ...normalizeSection(options) };
		this.sections.set(key, section);
		this.mount();
		this.syncRefreshTimer();
		this.requestRender();

		return {
			update: (patch = {}) => {
				if (this.sections.get(key) !== section) return;
				this.updateSection(key, patch);
			},
			remove: () => {
				if (this.sections.get(key) !== section) return;
				this.removeSection(key);
			},
		};
	}

	updateSection(id: string, patch: BottomPanelSectionPatch = {}): void {
		const current = this.sections.get(id);
		if (!current) return;
		Object.assign(current, normalizePatch(patch));
		this.mount();
		this.syncRefreshTimer();
		this.requestRender();
	}

	removeSection(id: string): void {
		if (!this.sections.delete(id)) return;
		this.syncRefreshTimer();
		if (this.sections.size === 0) this.unmount();
		else this.requestRender();
	}

	clear(): void {
		this.sections.clear();
		this.unmount();
	}

	dispose(): void {
		this.clear();
		this.ui = undefined;
		this.interactive = false;
	}

	/** Rendered directly by tests and by the one mounted host component. */
	render(width: number, theme: Theme): string[] {
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		const ordered = [...this.sections.values()]
			.filter((section) => section.maxLines > 0)
			.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
		const rendered = ordered
			.map((section) => ({ section, lines: renderSection(section, safeWidth, theme) }))
			.filter(({ lines }) => lines.length > 0);
		if (rendered.length === 0) return [];

		// Every visible section needs one content line and, after the first,
		// one separator. Reserve that space before an earlier section expands.
		const visible = rendered.slice(0, Math.floor((BOTTOM_PANEL_MAX_LINES + 1) / 2));
		let remaining = BOTTOM_PANEL_MAX_LINES;
		const output: string[] = [];
		for (const [index, { section, lines }] of visible.entries()) {
			if (remaining <= 0) break;
			const separatorLines = output.length > 0 ? 1 : 0;
			const laterSectionLines = (visible.length - index - 1) * 2;
			const available = Math.max(0, remaining - separatorLines - laterSectionLines);
			const allocation = Math.min(section.maxLines, available);
			if (allocation <= 0) continue;
			const limited = limitSection(lines, allocation, section.overflowLabel, theme);
			if (limited.length === 0) continue;
			if (output.length > 0) {
				output.push("");
				remaining--;
			}
			output.push(...limited);
			remaining = Math.max(0, remaining - limited.length);
			if (output.length >= BOTTOM_PANEL_MAX_LINES) break;
		}

		return output
			.slice(0, BOTTOM_PANEL_MAX_LINES)
			.map((line) => (safeWidth > 0 ? truncateToWidth(line, safeWidth, "…") : ""));
	}

	/** Repaint the mounted host without touching transcript components. */
	invalidate(): void {
		this.requestRender();
	}

	hostDisposed(host: BottomPanelHost): void {
		if (this.host !== host) return;
		this.host = undefined;
		this.mounted = false;
		this.stopRefreshTimer();
	}

	private mount(): void {
		if (!this.interactive || !this.ui || this.mounted) return;
		const ui = this.ui;
		this.mounted = true;
		try {
			ui.setWidget(
				BOTTOM_PANEL_WIDGET_KEY,
				(tui, theme) => {
					const host = new BottomPanelHost(this, tui, theme);
					this.host = host;
					this.syncRefreshTimer();
					return host;
				},
				{ placement: "aboveEditor" },
			);
		} catch (error) {
			this.mounted = false;
			this.host = undefined;
			throw error;
		}
	}

	private unmount(): void {
		const ui = this.ui;
		this.mounted = false;
		this.host = undefined;
		this.stopRefreshTimer();
		if (ui) ui.setWidget(BOTTOM_PANEL_WIDGET_KEY, undefined);
	}

	private requestRender(): void {
		this.host?.getTui().requestRender();
	}

	private syncRefreshTimer(): void {
		const requested = [...this.sections.values()]
			.map((section) => section.refreshIntervalMs)
			.filter((interval): interval is number => interval !== undefined && interval > 0)
			.reduce<number | undefined>(
				(minimum, interval) => Math.min(minimum ?? interval, interval),
				undefined,
			);
		if (requested === this.refreshIntervalMs && (requested === undefined || this.refreshTimer))
			return;
		this.stopRefreshTimer();
		this.refreshIntervalMs = requested;
		if (!requested || !this.host) return;
		const timer = setInterval(() => this.requestRender(), requested);
		timer.unref?.();
		this.refreshTimer = timer;
	}

	private stopRefreshTimer(): void {
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
		this.refreshIntervalMs = undefined;
	}
}

const BOTTOM_PANEL_REGISTRY_KEY = Symbol.for("@anjulgarg/agents.bottom-panel-registry.v1");

function sharedPanelRegistry(): WeakMap<object, BottomPanel> {
	const scope = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = scope[BOTTOM_PANEL_REGISTRY_KEY];
	if (existing instanceof WeakMap) return existing as WeakMap<object, BottomPanel>;
	const registry = new WeakMap<object, BottomPanel>();
	scope[BOTTOM_PANEL_REGISTRY_KEY] = registry;
	return registry;
}

export function getBottomPanel(context: PanelContext): BottomPanel {
	const panelsByUi = sharedPanelRegistry();
	const key = context.ui as object;
	let panel = panelsByUi.get(key);
	if (!panel) {
		panel = new BottomPanel();
		panelsByUi.set(key, panel);
	}
	panel.attach(context);
	return panel;
}

function normalizeSection(options: BottomPanelSectionOptions): Omit<StoredSection, "id"> {
	return {
		order: finiteInteger(options.order, 0),
		maxLines: boundedLines(options.maxLines),
		render: options.render,
		overflowLabel: options.overflowLabel,
		refreshIntervalMs: positiveInteger(options.refreshIntervalMs),
	};
}

function normalizePatch(patch: BottomPanelSectionPatch): BottomPanelSectionPatch {
	return {
		...(patch.order === undefined ? {} : { order: finiteInteger(patch.order, 0) }),
		...(patch.maxLines === undefined ? {} : { maxLines: boundedLines(patch.maxLines) }),
		...(patch.render === undefined ? {} : { render: patch.render }),
		...(patch.overflowLabel === undefined ? {} : { overflowLabel: patch.overflowLabel }),
		...(Object.prototype.hasOwnProperty.call(patch, "refreshIntervalMs")
			? { refreshIntervalMs: positiveInteger(patch.refreshIntervalMs ?? undefined) }
			: {}),
	};
}

function finiteInteger(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function boundedLines(value: number): number {
	return Math.max(0, Math.min(BOTTOM_PANEL_MAX_LINES, finiteInteger(value, 0)));
}

function positiveInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	const safe = Math.floor(value);
	return safe > 0 ? safe : undefined;
}

function renderSection(section: StoredSection, width: number, theme: Theme): string[] {
	try {
		const lines = section.render(width, theme);
		if (!Array.isArray(lines)) return [];
		return lines.flatMap((line) => String(line).replace(/\r/g, "").split("\n"));
	} catch {
		return [];
	}
}

function limitSection(
	lines: readonly string[],
	allocation: number,
	overflowLabel: BottomPanelSectionOptions["overflowLabel"],
	theme: Theme,
): string[] {
	if (lines.length <= allocation) return lines.slice();
	if (!overflowLabel) return lines.slice(0, allocation);
	const retained = Math.max(0, allocation - 1);
	const omitted = Math.max(0, lines.length - retained);
	let hint = "";
	try {
		hint = String(overflowLabel(omitted, theme));
	} catch {
		hint = `+ ${omitted} more`;
	}
	return [...lines.slice(0, retained), hint];
}
