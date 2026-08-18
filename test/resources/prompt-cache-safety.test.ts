import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

type ViolationKind = "parent-system-prompt" | "dynamic-tool-prompt-metadata";

interface Violation {
	kind: ViolationKind;
	path: string;
	line: number;
	column: number;
	message: string;
}

type CallableNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

interface SourceIndex {
	variables: Map<string, ts.VariableDeclaration[]>;
	functions: Map<string, ts.FunctionDeclaration[]>;
	functionValues: Map<string, ts.VariableDeclaration[]>;
}

interface EventScope {
	event: string;
	callback: CallableNode;
}

interface ToolDefinition {
	path: string;
	sourceFile: ts.SourceFile;
	name: string | undefined;
	metadata: Array<{ name: "promptSnippet" | "promptGuidelines"; node: ts.Node }>;
}

interface ToolActivation {
	sourceFile: ts.SourceFile;
	node: ts.CallExpression;
	names: Set<string>;
	known: boolean;
	dynamic: boolean;
}

interface SourceAnalysis {
	path: string;
	sourceFile: ts.SourceFile;
	parentViolations: Violation[];
	tools: ToolDefinition[];
	activations: ToolActivation[];
}

interface SourceInput {
	path: string;
	text: string;
}

const STATIC_PROMPT_TOOL_NAMES = new Set([
	"job",
	"todo",
	"question",
	"checkpoint",
	"load_tools",
	"lsp",
	"worktree_cleanup",
]);

const STARTUP_ACTIVATION_EVENTS = new Set(["session_start"]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function isFunctionBoundary(node: ts.Node): boolean {
	return (
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node) ||
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node)
	);
}

function isCallableNode(node: ts.Node): node is CallableNode {
	return (
		ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
	);
}

function literalText(node: ts.Node | undefined): string | undefined {
	if (!node) return undefined;
	if (ts.isStringLiteral(node)) return node.text;
	if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return node.getText().slice(1, -1);
	return undefined;
}

function nameText(node: ts.Node | undefined): string | undefined {
	if (!node) return undefined;
	if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
	return literalText(node);
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
	return nameText(node);
}

function callMethodName(call: ts.CallExpression): string | undefined {
	if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
	if (ts.isElementAccessExpression(call.expression))
		return literalText(call.expression.argumentExpression);
	return undefined;
}

function buildSourceIndex(sourceFile: ts.SourceFile): SourceIndex {
	const variables = new Map<string, ts.VariableDeclaration[]>();
	const functions = new Map<string, ts.FunctionDeclaration[]>();
	const functionValues = new Map<string, ts.VariableDeclaration[]>();

	function add<T>(map: Map<string, T[]>, name: string, value: T): void {
		const values = map.get(name) ?? [];
		values.push(value);
		map.set(name, values);
	}

	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			add(variables, node.name.text, node);
			if (node.initializer && isCallableNode(unwrapExpression(node.initializer))) {
				add(functionValues, node.name.text, node);
			}
		}
		if (ts.isFunctionDeclaration(node) && node.name) add(functions, node.name.text, node);
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return { variables, functions, functionValues };
}

function declarationBefore<T extends ts.Node>(
	declarations: readonly T[] | undefined,
	reference: ts.Node,
): T | undefined {
	return declarations
		?.filter((declaration) => declaration.getStart() < reference.getStart())
		.at(-1);
}

function variableDeclaration(
	identifier: ts.Identifier,
	index: SourceIndex,
): ts.VariableDeclaration | undefined {
	return declarationBefore(index.variables.get(identifier.text), identifier);
}

function resolveString(
	expression: ts.Expression,
	index: SourceIndex,
	seen = new Set<ts.Node>(),
): string | undefined {
	const value = unwrapExpression(expression);
	if (seen.has(value)) return undefined;
	seen.add(value);
	const direct = literalText(value);
	if (direct !== undefined) return direct;
	if (ts.isIdentifier(value)) {
		const declaration = variableDeclaration(value, index);
		return declaration?.initializer
			? resolveString(declaration.initializer, index, seen)
			: undefined;
	}
	return undefined;
}

function resolveObjectLiteral(
	expression: ts.Expression,
	index: SourceIndex,
	seen = new Set<ts.Node>(),
): ts.ObjectLiteralExpression | undefined {
	const value = unwrapExpression(expression);
	if (seen.has(value)) return undefined;
	seen.add(value);
	if (ts.isObjectLiteralExpression(value)) return value;
	if (ts.isIdentifier(value)) {
		const declaration = variableDeclaration(value, index);
		return declaration?.initializer
			? resolveObjectLiteral(declaration.initializer, index, seen)
			: undefined;
	}
	return undefined;
}

function resolveCallable(expression: ts.Expression, index: SourceIndex): CallableNode | undefined {
	const value = unwrapExpression(expression);
	if (isCallableNode(value)) return value;
	if (!ts.isIdentifier(value)) return undefined;

	const functionDeclaration = declarationBefore(index.functions.get(value.text), value);
	if (functionDeclaration) return functionDeclaration;
	const functionValue = declarationBefore(index.functionValues.get(value.text), value);
	const initializer = functionValue?.initializer;
	if (!initializer) return undefined;
	const unwrapped = unwrapExpression(initializer);
	return isCallableNode(unwrapped) ? unwrapped : undefined;
}

function returnedExpressions(callable: CallableNode): ts.Expression[] {
	if (ts.isArrowFunction(callable) && !ts.isBlock(callable.body)) return [callable.body];
	if (!callable.body || !ts.isBlock(callable.body)) return [];

	const expressions: ts.Expression[] = [];
	function visit(node: ts.Node): void {
		if (ts.isReturnStatement(node)) {
			if (node.expression) expressions.push(node.expression);
			return;
		}
		if (node !== callable && isFunctionBoundary(node)) return;
		ts.forEachChild(node, visit);
	}
	visit(callable.body);
	return expressions;
}

function returnedSystemPromptProperty(
	expression: ts.Expression,
	index: SourceIndex,
	seen = new Set<ts.Node>(),
	seenCallables = new Set<ts.Node>(),
): ts.Node | undefined {
	const value = unwrapExpression(expression);
	if (seen.has(value)) return undefined;
	seen.add(value);

	if (ts.isObjectLiteralExpression(value)) {
		for (const element of value.properties) {
			if (ts.isSpreadAssignment(element)) {
				const spreadPrompt = returnedSystemPromptProperty(
					element.expression,
					index,
					seen,
					seenCallables,
				);
				if (spreadPrompt) return spreadPrompt;
				continue;
			}
			if (propertyName(element.name) === "systemPrompt") return element.name;
		}
		return undefined;
	}

	if (ts.isIdentifier(value)) {
		const declaration = variableDeclaration(value, index);
		return declaration?.initializer
			? returnedSystemPromptProperty(declaration.initializer, index, seen, seenCallables)
			: undefined;
	}

	if (ts.isConditionalExpression(value)) {
		return (
			returnedSystemPromptProperty(value.whenTrue, index, seen, seenCallables) ??
			returnedSystemPromptProperty(value.whenFalse, index, seen, seenCallables)
		);
	}

	if (ts.isBinaryExpression(value)) {
		const operator = value.operatorToken.kind;
		if (
			operator === ts.SyntaxKind.AmpersandAmpersandToken ||
			operator === ts.SyntaxKind.BarBarToken ||
			operator === ts.SyntaxKind.QuestionQuestionToken
		) {
			return (
				returnedSystemPromptProperty(value.left, index, seen, seenCallables) ??
				returnedSystemPromptProperty(value.right, index, seen, seenCallables)
			);
		}
	}

	if (ts.isAwaitExpression(value)) {
		return returnedSystemPromptProperty(value.expression, index, seen, seenCallables);
	}

	if (ts.isCallExpression(value)) {
		const promiseResolve =
			ts.isPropertyAccessExpression(value.expression) &&
			nameText(value.expression.expression) === "Promise" &&
			value.expression.name.text === "resolve";
		if (promiseResolve) {
			return value.arguments
				.map((argument) => returnedSystemPromptProperty(argument, index, seen, seenCallables))
				.find((node): node is ts.Node => Boolean(node));
		}

		const callable = resolveCallable(value.expression, index);
		if (!callable || seenCallables.has(callable)) return undefined;
		seenCallables.add(callable);
		for (const returned of returnedExpressions(callable)) {
			const prompt = returnedSystemPromptProperty(returned, index, seen, seenCallables);
			if (prompt) return prompt;
		}
	}

	return undefined;
}

function collectEventScopes(sourceFile: ts.SourceFile, index: SourceIndex): EventScope[] {
	const scopes: EventScope[] = [];
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && callMethodName(node) === "on") {
			const event = resolveString(node.arguments[0], index);
			const callback = node.arguments[1] && resolveCallable(node.arguments[1], index);
			if (event && callback) scopes.push({ event, callback });
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return scopes;
}

function isInside(node: ts.Node, container: ts.Node): boolean {
	return node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd();
}

function containingEvent(node: ts.Node, scopes: readonly EventScope[]): EventScope | undefined {
	return scopes
		.filter((scope) => isInside(node, scope.callback))
		.sort((left, right) => left.callback.getWidth() - right.callback.getWidth())
		.at(0);
}

function propertyElement(
	object: ts.ObjectLiteralExpression,
	name: string,
	index: SourceIndex,
	seen = new Set<ts.Node>(),
): ts.ObjectLiteralElementLike | undefined {
	if (seen.has(object)) return undefined;
	seen.add(object);
	for (const element of object.properties) {
		if (!ts.isSpreadAssignment(element) && propertyName(element.name) === name) return element;
	}
	for (const element of object.properties) {
		if (!ts.isSpreadAssignment(element)) continue;
		const spreadObject = resolveObjectLiteral(element.expression, index);
		const nested = spreadObject && propertyElement(spreadObject, name, index, seen);
		if (nested) return nested;
	}
	return undefined;
}

function collectTools(
	path: string,
	sourceFile: ts.SourceFile,
	index: SourceIndex,
): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && callMethodName(node) === "registerTool") {
			const object = node.arguments[0] && resolveObjectLiteral(node.arguments[0], index);
			if (object) {
				const nameElement = propertyElement(object, "name", index);
				const nameExpression =
					nameElement &&
					(ts.isPropertyAssignment(nameElement) ? nameElement.initializer : undefined);
				const metadata: ToolDefinition["metadata"] = [];
				for (const name of ["promptSnippet", "promptGuidelines"] as const) {
					const element = propertyElement(object, name, index);
					if (element) metadata.push({ name, node: element.name ?? element });
				}
				if (metadata.length > 0) {
					tools.push({
						path,
						sourceFile,
						name: nameExpression ? resolveString(nameExpression, index) : undefined,
						metadata,
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return tools;
}

interface StaticNames {
	names: Set<string>;
	known: boolean;
}

function activeToolNames(
	expression: ts.Expression,
	index: SourceIndex,
	seen = new Set<ts.Node>(),
): StaticNames {
	const value = unwrapExpression(expression);
	if (seen.has(value)) return { names: new Set(), known: false };
	seen.add(value);

	const direct = literalText(value);
	if (direct !== undefined) return { names: new Set([direct]), known: true };
	if (ts.isIdentifier(value)) {
		const declaration = variableDeclaration(value, index);
		return declaration?.initializer
			? activeToolNames(declaration.initializer, index, seen)
			: { names: new Set(), known: false };
	}
	if (ts.isArrayLiteralExpression(value)) {
		const names = new Set<string>();
		let known = true;
		for (const element of value.elements) {
			if (ts.isOmittedExpression(element)) continue;
			const nested = activeToolNames(element, index, seen);
			for (const name of nested.names) names.add(name);
			known &&= nested.known;
		}
		return { names, known };
	}
	if (ts.isSpreadElement(value)) return activeToolNames(value.expression, index, seen);
	if (ts.isConditionalExpression(value)) {
		const whenTrue = activeToolNames(value.whenTrue, index, seen);
		const whenFalse = activeToolNames(value.whenFalse, index, seen);
		return {
			names: new Set([...whenTrue.names, ...whenFalse.names]),
			known: whenTrue.known && whenFalse.known,
		};
	}
	if (ts.isNewExpression(value) || ts.isCallExpression(value)) {
		const callee = ts.isNewExpression(value) ? value.expression : value.expression;
		const calleeName = nameText(callee);
		if (calleeName === "Set" || calleeName === "Array") {
			const names = new Set<string>();
			let known = true;
			for (const argument of value.arguments ?? []) {
				const nested = activeToolNames(argument, index, seen);
				for (const name of nested.names) names.add(name);
				known &&= nested.known;
			}
			return { names, known };
		}
	}
	return { names: new Set(), known: false };
}

function collectActivations(
	sourceFile: ts.SourceFile,
	index: SourceIndex,
	eventScopes: readonly EventScope[],
): ToolActivation[] {
	const activations: ToolActivation[] = [];
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && callMethodName(node) === "setActiveTools") {
			const extracted = node.arguments[0]
				? activeToolNames(node.arguments[0], index)
				: { names: new Set<string>(), known: false };
			const eventScope = containingEvent(node, eventScopes);
			activations.push({
				sourceFile,
				node,
				names: extracted.names,
				known: extracted.known,
				dynamic: !eventScope || !STARTUP_ACTIVATION_EVENTS.has(eventScope.event),
			});
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return activations;
}

function location(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
	const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return { line: point.line + 1, column: point.character + 1 };
}

function analyzeSource(input: SourceInput): SourceAnalysis {
	const sourceFile = ts.createSourceFile(
		input.path,
		input.text,
		ts.ScriptTarget.Latest,
		true,
		input.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const index = buildSourceIndex(sourceFile);
	const eventScopes = collectEventScopes(sourceFile, index);
	const parentViolations: Violation[] = [];

	for (const scope of eventScopes.filter(({ event }) => event === "before_agent_start")) {
		for (const expression of returnedExpressions(scope.callback)) {
			const property = returnedSystemPromptProperty(expression, index);
			if (!property) continue;
			const point = location(sourceFile, property);
			parentViolations.push({
				kind: "parent-system-prompt",
				path: input.path,
				...point,
				message: "parent before_agent_start handler returns a systemPrompt override",
			});
		}
	}

	return {
		path: input.path,
		sourceFile,
		parentViolations,
		tools: collectTools(input.path, sourceFile, index),
		activations: collectActivations(sourceFile, index, eventScopes),
	};
}

function scanSources(inputs: readonly SourceInput[]): Violation[] {
	const analyses = inputs.map(analyzeSource);
	const activations = analyses.flatMap((analysis) => analysis.activations);
	const violations = analyses.flatMap((analysis) => [...analysis.parentViolations]);

	for (const tool of analyses.flatMap((analysis) => analysis.tools)) {
		const dynamicActivation = activations.find(
			(activation) =>
				activation.dynamic &&
				(tool.name === undefined || activation.names.has(tool.name) || !activation.known),
		);
		if (
			!dynamicActivation ||
			(tool.name !== undefined && STATIC_PROMPT_TOOL_NAMES.has(tool.name))
		) {
			continue;
		}
		const point = location(tool.sourceFile, tool.metadata[0]!.node);
		const activationPoint = location(dynamicActivation.sourceFile, dynamicActivation.node);
		const toolLabel = tool.name ?? "<dynamic tool name>";
		const metadata = tool.metadata.map(({ name }) => name).join(" and ");
		violations.push({
			kind: "dynamic-tool-prompt-metadata",
			path: tool.path,
			...point,
			message:
				`first-party tool "${toolLabel}" carries ${metadata} but is dynamically activated ` +
				`at ${formatLocation(dynamicActivation.sourceFile.fileName, activationPoint)}`,
		});
	}

	return violations.sort((left, right) => {
		const pathOrder = left.path.localeCompare(right.path);
		if (pathOrder !== 0) return pathOrder;
		if (left.line !== right.line) return left.line - right.line;
		if (left.column !== right.column) return left.column - right.column;
		return left.kind.localeCompare(right.kind);
	});
}

function formatLocation(path: string, point: { line: number; column: number }): string {
	return `${path}:${point.line}:${point.column}`;
}

function formatViolation(violation: Violation): string {
	return `${formatLocation(violation.path, violation)} ${violation.kind}: ${violation.message}`;
}

function formatViolations(violations: readonly Violation[]): string {
	return violations.length === 0 ? "no violations" : violations.map(formatViolation).join("\n");
}

async function firstPartySources(root: string): Promise<SourceInput[]> {
	const extensionRoot = resolve(root, "pi", "extensions");
	const files: string[] = [];

	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
			} else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
				files.push(path);
			}
		}
	}

	await visit(extensionRoot);
	files.sort();
	return Promise.all(
		files.map(async (file) => ({
			path: relative(root, file).split(sep).join("/"),
			text: await readFile(file, "utf8"),
		})),
	);
}

describe("prompt cache safety invariant", () => {
	it("keeps first-party parent prompts and dynamic tool metadata cache-safe", async () => {
		const violations = scanSources(await firstPartySources(process.cwd()));
		expect(violations, formatViolations(violations)).toEqual([]);
	});

	it("reports parent overrides and dynamically activated prompt metadata with source locations", () => {
		const source = `
			const pi = {
				on(_event: string, _handler: unknown) {},
				registerTool(_tool: unknown) {},
				setActiveTools(_tools: string[]) {},
			};
			const parentOverride = { systemPrompt: "parent override" };
			pi.on("before_agent_start", () => parentOverride);
			pi.on("before_agent_start", () => {
				void completeDirectRequest(registry, model, {
					systemPrompt: "isolated direct request",
					messages: [],
				}, {});
				spawnChild({ systemPrompt: "child subagent prompt" });
			});
			pi.registerTool({
				name: "late_tool",
				promptSnippet: "late prompt",
				promptGuidelines: ["late guidance"],
			});
			function activateLateTool() {
				pi.setActiveTools(["late_tool"]);
			}
			pi.on("tool_call", activateLateTool);
		`;
		const violations = scanSources([{ path: "synthetic/violating.ts", text: source }]);

		expect(violations.map(({ kind, path }) => ({ kind, path }))).toEqual([
			{ kind: "parent-system-prompt", path: "synthetic/violating.ts" },
			{ kind: "dynamic-tool-prompt-metadata", path: "synthetic/violating.ts" },
		]);
		expect(formatViolations(violations)).toMatch(
			/synthetic\/violating\.ts:\d+:\d+ parent-system-prompt:.*systemPrompt override/,
		);
		expect(formatViolations(violations)).toMatch(
			/dynamic-tool-prompt-metadata:.*late_tool.*promptSnippet and promptGuidelines.*activated at synthetic\/violating\.ts:\d+:\d+/,
		);
	});

	it("allows isolated requests, child prompts, and static prompt-bearing tools", () => {
		const staticTools = [...STATIC_PROMPT_TOOL_NAMES]
			.map(
				(name) => `
					pi.registerTool({
						name: ${JSON.stringify(name)},
						promptSnippet: "static prompt",
						promptGuidelines: ["static guidance"],
					});`,
			)
			.join("\n");
		const source = `
			const pi = {
				on(_event: string, _handler: unknown) {},
				registerTool(_tool: unknown) {},
				setActiveTools(_tools: string[]) {},
			};
			${staticTools}
			pi.registerTool({ name: "static_fixture", promptSnippet: "static prompt" });
			pi.on("session_start", () => pi.setActiveTools(["static_fixture"]));
			pi.on("before_agent_start", () => {
				void completeDirectRequest(registry, model, {
					systemPrompt: "isolated direct request",
					messages: [],
				}, {});
				spawnChild({ systemPrompt: "child subagent prompt" });
				return { message: { customType: "hidden-tail", content: "safe", display: false } };
			});
		`;

		expect(scanSources([{ path: "synthetic/allowed.ts", text: source }])).toEqual([]);
	});
});
