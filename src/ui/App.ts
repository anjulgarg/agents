import React, { useEffect, useMemo, useState } from "react";
import { Text, useApp, useInput } from "ink";
import type {
	ComponentCategory,
	ComponentDefinition,
	ComponentId,
	SystemInspection,
} from "../domain/contracts.ts";
import { COMPONENT_CATEGORIES } from "../domain/contracts.ts";
import { components, profiles, resolveProfile } from "../registry/index.ts";
import type {
	AgentsUiServices,
	DoctorReportView,
	OperationPlanView,
	OperationResultView,
	UiContext,
} from "./contracts.ts";
import {
	DASHBOARD_ITEMS,
	renderConfirmation,
	renderDashboard,
	renderDoctor,
	renderError,
	renderList,
	renderMinimumWidth,
	renderPreview,
	renderProgress,
	renderResult,
	renderSelector,
} from "./presenters.ts";

export type InteractiveCommand = "dashboard" | "install" | "remove" | "list" | "doctor";
type Screen = InteractiveCommand | "preview" | "confirm" | "progress" | "result" | "error";

export interface AppProps {
	readonly command: InteractiveCommand;
	readonly services: AgentsUiServices;
	readonly context: UiContext;
	readonly width?: number;
	readonly debug?: boolean;
	readonly definitions?: readonly ComponentDefinition[];
	readonly initialSelection?: readonly ComponentId[];
	readonly onCancelled?: () => void;
}

const categories: readonly ("all" | ComponentCategory)[] = ["all", ...COMPONENT_CATEGORIES];

function initialInstallSelection(inspection: SystemInspection): Set<ComponentId> {
	const installed = inspection.components
		.filter(({ status }) => status === "installed")
		.map(({ id }) => id);
	if (installed.length) return new Set(installed);
	return new Set(resolveProfile("default"));
}

function selectableForRemove(inspection: SystemInspection): Set<ComponentId> {
	return new Set(
		inspection.components
			.filter(
				({ status, outputs }) =>
					status !== "available" || outputs.some(({ state }) => state === "legacy"),
			)
			.map(({ id }) => id),
	);
}

export function App({
	command,
	services,
	context,
	width = process.stdout.columns || 80,
	debug = false,
	definitions = components,
	initialSelection,
	onCancelled,
}: AppProps): React.ReactElement {
	const { exit } = useApp();
	const [screen, setScreen] = useState<Screen>(command);
	const [inspection, setInspection] = useState<SystemInspection>();
	const [doctor, setDoctor] = useState<DoctorReportView>();
	const [selected, setSelected] = useState<Set<ComponentId>>(new Set());
	const [focus, setFocus] = useState(0);
	const [categoryIndex, setCategoryIndex] = useState(0);
	const [search, setSearch] = useState("");
	const [searching, setSearching] = useState(false);
	const [installedOnly, setInstalledOnly] = useState(false);
	const [plan, setPlan] = useState<OperationPlanView>();
	const [progress, setProgress] = useState("Preparing transaction");
	const [result, setResult] = useState<OperationResultView>();
	const [failure, setFailure] = useState<unknown>();
	const [dashboardFocus, setDashboardFocus] = useState(0);

	const inspectionContext = useMemo(
		() => ({ home: context.home, sourceRoot: context.sourceRoot }),
		[context.home, context.sourceRoot],
	);

	useEffect(() => {
		let current = true;
		void services
			.inspect(inspectionContext)
			.then((value) => {
				if (!current) return;
				setInspection(value);
				if (command === "install")
					setSelected(
						initialSelection ? new Set(initialSelection) : initialInstallSelection(value),
					);
				else if (command === "remove" && initialSelection) setSelected(new Set(initialSelection));
			})
			.catch((error: unknown) => {
				if (!current) return;
				setFailure(error);
				setScreen("error");
			});
		if (command === "doctor") {
			void services
				.runDoctor(inspectionContext)
				.then((value) => current && setDoctor(value))
				.catch((error: unknown) => {
					if (!current) return;
					setFailure(error);
					setScreen("error");
				});
		}
		return () => {
			current = false;
		};
	}, [command, initialSelection, inspectionContext, services]);

	const inspections = useMemo(
		() => new Map(inspection?.components.map((item) => [item.id, item]) ?? []),
		[inspection],
	);
	const removeEligible = useMemo(
		() => (inspection ? selectableForRemove(inspection) : new Set<ComponentId>()),
		[inspection],
	);
	const operation = screen === "remove" || plan?.operation === "remove" ? "remove" : "install";
	const category = categories[categoryIndex]!;
	const visible = useMemo(() => {
		const query = search.toLocaleLowerCase();
		return definitions.filter((definition) => {
			if (screen === "remove" && !removeEligible.has(definition.id)) return false;
			if (category !== "all" && definition.category !== category) return false;
			if (installedOnly && inspections.get(definition.id)?.status !== "installed") return false;
			return (
				!query ||
				definition.label.toLocaleLowerCase().includes(query) ||
				definition.id.includes(query) ||
				definition.description.toLocaleLowerCase().includes(query)
			);
		});
	}, [category, definitions, inspections, installedOnly, removeEligible, screen, search]);

	function cancel(): void {
		onCancelled?.();
		exit();
	}

	function toggle(id: ComponentId): void {
		setSelected((before) => {
			const next = new Set(before);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function chooseProfile(index: number): void {
		const profile = profiles[index];
		if (!profile) return;
		const ids = resolveProfile(profile.id);
		setSelected(new Set(operation === "remove" ? ids.filter((id) => removeEligible.has(id)) : ids));
	}

	async function review(): Promise<void> {
		try {
			const requested = [...selected].sort();
			const value =
				operation === "install"
					? await services.planInstall(inspectionContext, requested)
					: await services.planRemove(inspectionContext, requested);
			setPlan(value);
			setScreen("preview");
		} catch (error) {
			setFailure(error);
			setScreen("error");
		}
	}

	async function apply(): Promise<void> {
		if (!plan) return;
		setScreen("progress");
		try {
			const value = await services.applyPlan(inspectionContext, plan, setProgress);
			setResult(value);
			setInspection(await services.inspect(inspectionContext));
			setScreen("result");
		} catch (error) {
			setFailure(error);
			setScreen("error");
		}
	}

	useInput((input, key) => {
		if (width < 60) {
			if (key.escape || (key.ctrl && input === "c")) cancel();
			return;
		}
		if (searching) {
			if (key.escape || key.return) setSearching(false);
			else if (key.backspace || key.delete) setSearch((value) => value.slice(0, -1));
			else if (!key.ctrl && !key.meta && input) setSearch((value) => value + input);
			return;
		}
		if (key.ctrl && input === "c") return cancel();
		if (screen === "dashboard") {
			if (key.upArrow)
				setDashboardFocus((value) => (value + DASHBOARD_ITEMS.length - 1) % DASHBOARD_ITEMS.length);
			else if (key.downArrow) setDashboardFocus((value) => (value + 1) % DASHBOARD_ITEMS.length);
			else if (key.escape) cancel();
			else if (key.return) {
				const next = DASHBOARD_ITEMS[dashboardFocus]!.command;
				if (next === "install" && inspection) setSelected(initialInstallSelection(inspection));
				if (next === "remove") setSelected(new Set());
				if (next === "doctor") {
					setDoctor(undefined);
					void services
						.runDoctor(inspectionContext)
						.then(setDoctor)
						.catch((error: unknown) => {
							setFailure(error);
							setScreen("error");
						});
				}
				setScreen(next);
			}
			return;
		}
		if (screen === "install" || screen === "remove") {
			if (key.escape) return cancel();
			if (key.upArrow) setFocus((value) => Math.max(0, value - 1));
			else if (key.downArrow) setFocus((value) => Math.min(visible.length - 1, value + 1));
			else if (key.tab) {
				setCategoryIndex(
					(value) => (value + (key.shift ? categories.length - 1 : 1)) % categories.length,
				);
				setFocus(0);
			} else if (key.return) void review();
			else if (input === " " && visible[focus]) toggle(visible[focus].id);
			else if (input.toLowerCase() === "a")
				setSelected((before) => new Set([...before, ...visible.map(({ id }) => id)]));
			else if (input === "c")
				setSelected((before) => new Set([...before, ...visible.map(({ id }) => id)]));
			else if (input === "C")
				setSelected(
					(before) => new Set([...before].filter((id) => !visible.some((item) => item.id === id))),
				);
			else if (input.toLowerCase() === "x") setSelected(new Set());
			else if (input === "/") setSearching(true);
			else if (input.toLowerCase() === "f") setInstalledOnly((value) => !value);
			else if (/^[123]$/.test(input)) chooseProfile(Number(input) - 1);
			return;
		}
		if (screen === "preview") {
			if (key.escape) cancel();
			else if (key.return) setScreen("confirm");
			return;
		}
		if (screen === "confirm") {
			if (key.escape || input.toLowerCase() === "n") cancel();
			else if (input.toLowerCase() === "y") void apply();
			return;
		}
		if (screen === "list" || screen === "doctor") {
			if (key.escape) cancel();
			return;
		}
		if (screen === "result" && key.return) setScreen("dashboard");
		if (screen === "error" && key.escape) cancel();
	});

	let output: string;
	if (width < 60) output = renderMinimumWidth(width);
	else if (screen === "dashboard") output = renderDashboard(width, dashboardFocus);
	else if (screen === "list")
		output = inspection ? renderList(inspection, definitions, width) : "Loading component status…";
	else if (screen === "doctor")
		output = doctor ? renderDoctor(doctor, width) : "Running doctor checks…";
	else if (screen === "install" || screen === "remove")
		output = inspection
			? renderSelector(
					{
						operation: screen,
						selected,
						visible,
						inspections,
						focus,
						category,
						search: searching ? `${search}_` : search,
						installedOnly,
					},
					definitions.length,
					width,
				)
			: "Inspecting local components…";
	else if (screen === "preview" && plan) output = renderPreview(plan, width, definitions);
	else if (screen === "confirm" && plan) output = renderConfirmation(plan, width);
	else if (screen === "progress") output = renderProgress(progress, width);
	else if (screen === "result" && result) output = renderResult(result, width);
	else output = renderError(failure, debug, width);

	return React.createElement(Text, null, output);
}
