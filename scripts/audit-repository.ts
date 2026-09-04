import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

const MAX_SOURCE_BYTES = 2.5 * 1024 * 1024;
const EXPECTED_SKILLS = ["foreman-plan", "foreman-review", "foreman-worker"] as const;
const EXPECTED_EXTENSIONS = [
	"pi/extensions/announce-step.ts",
	"pi/extensions/branch.ts",
	"pi/extensions/btw.ts",
	"pi/extensions/changes.ts",
	"pi/extensions/codex-usage.ts",
	"pi/extensions/codex-web-search.ts",
	"pi/extensions/compaction-model.ts",
	"pi/extensions/context.ts",
	"pi/extensions/conversation-separator.ts",
	"pi/extensions/escape-unsend.ts",
	"pi/extensions/find/index.ts",
	"pi/extensions/foreman-theme.ts",
	"pi/extensions/git-checkpoint.ts",
	"pi/extensions/handoff.ts",
	"pi/extensions/hide-thinking-history.ts",
	"pi/extensions/jobs/index.ts",
	"pi/extensions/lsp/index.ts",
	"pi/extensions/memory/index.ts",
	"pi/extensions/minimal-mode.ts",
	"pi/extensions/plan-mode/index.ts",
	"pi/extensions/context-overflow-guard.ts",
	"pi/extensions/publish.ts",
	"pi/extensions/pull.ts",
	"pi/extensions/question.ts",
	"pi/extensions/session-cleanup.ts",
	"pi/extensions/session-recap/index.ts",
	"pi/extensions/session-title/index.ts",
	"pi/extensions/subagent/index.ts",
	"pi/extensions/todo.ts",
	"pi/extensions/token-speed.ts",
	"pi/extensions/tool-loader.ts",
	"pi/extensions/utility-model.ts",
	"pi/extensions/worktree.ts",
] as const;

const EXCLUDED_NAMES = new Set([
	"find-skills",
	"impeccable",
	"using-git-worktrees",
	"visual-companion.md",
	"pi-mcp-adapter",
	"pi-better-compaction",
	"sync-pi-mcp-adapter.sh",
]);
const PRIVATE_PATH_NAMES = new Set([
	"auth.json",
	"credentials.json",
	"sessions",
	"state",
	"npm-cache",
	".npm",
	".cache",
]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);
const SECRET_SCAN_EXTENSIONS = new Set([".json", ".jsonc", ".js", ".cjs", ".mjs", ".ts", ".tsx"]);
const SECRET_PATTERNS: Array<[string, RegExp]> = [
	["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
	["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
	["openai-token", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
	["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
];

export type AuditCategory =
	| "excluded-asset"
	| "unsafe-link"
	| "secret-pattern"
	| "disallowed-script"
	| "invalid-manifest"
	| "size-budget";

export interface AuditFailure {
	category: AuditCategory;
	path: string;
	detail: string;
}

export interface AuditSummary {
	skills: number;
	extensions: number;
	prompts: number;
	themes: number;
	excludedPathChecks: number;
	sourceBytes: number;
}

function posixPath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/") || ".";
}

async function walk(
	root: string,
): Promise<{ files: string[]; failures: AuditFailure[]; sourceBytes: number }> {
	const files: string[] = [];
	const failures: AuditFailure[] = [];
	let sourceBytes = 0;

	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
			const path = join(directory, entry.name);
			const displayPath = posixPath(root, path);
			const info = await lstat(path);
			if (info.isSymbolicLink()) {
				failures.push({
					category: "unsafe-link",
					path: displayPath,
					detail: "symbolic links are forbidden",
				});
				continue;
			}
			const lowerName = entry.name.toLowerCase();
			if (EXCLUDED_NAMES.has(lowerName)) {
				failures.push({
					category: "excluded-asset",
					path: displayPath,
					detail: "explicitly excluded resource",
				});
			}
			if (PRIVATE_PATH_NAMES.has(lowerName)) {
				failures.push({
					category: "secret-pattern",
					path: displayPath,
					detail: "credential or cache path is forbidden",
				});
			}
			if (info.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!info.isFile()) continue;
			files.push(path);
			if (extname(lowerName) === ".py" || extname(lowerName) === ".sh") {
				failures.push({
					category: "disallowed-script",
					path: displayPath,
					detail: "Python and shell files are forbidden",
				});
			}
			if (basename(path) !== "package-lock.json") sourceBytes += info.size;
			if (SECRET_SCAN_EXTENSIONS.has(extname(lowerName))) {
				const content = await readFile(path, "utf8");
				for (const [name, pattern] of SECRET_PATTERNS) {
					if (pattern.test(content))
						failures.push({ category: "secret-pattern", path: displayPath, detail: name });
				}
			}
		}
	}

	await visit(root);
	return { files, failures, sourceBytes };
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? value
		: undefined;
}

function equalSorted(actual: readonly string[], expected: readonly string[]): boolean {
	return [...actual].sort().join("\n") === [...expected].sort().join("\n");
}

async function validateManifest(root: string, files: readonly string[]): Promise<AuditFailure[]> {
	const failures: AuditFailure[] = [];
	const packagePath = join(root, "package.json");
	let manifest: Record<string, any>;
	try {
		manifest = JSON.parse(await readFile(packagePath, "utf8"));
	} catch {
		return [
			{
				category: "invalid-manifest",
				path: "package.json",
				detail: "missing or malformed package manifest",
			},
		];
	}
	const invalid = (detail: string, path = "package.json"): void => {
		failures.push({ category: "invalid-manifest", path, detail });
	};
	if (
		manifest.name !== "@anjulgarg/agents" ||
		manifest.private !== true ||
		manifest.type !== "module"
	)
		invalid("identity, privacy, or ESM contract differs");
	if (manifest.engines?.node !== ">=22.19.0") invalid("Node engine must be >=22.19.0");
	if (manifest.bin?.agents !== "dist/cli.js") invalid("agents bin must target dist/cli.js");
	if (manifest.dependencies?.ink !== "7.1.1" || manifest.dependencies?.react !== "19.2.8")
		invalid("runtime dependencies must be exact approved versions");
	const extensions = stringArray(manifest.pi?.extensions);
	const skills = stringArray(manifest.pi?.skills);
	const prompts = stringArray(manifest.pi?.prompts);
	const themes = stringArray(manifest.pi?.themes);
	if (!extensions || !equalSorted(extensions, EXPECTED_EXTENSIONS))
		invalid(
			`Pi extensions must be the exact ${EXPECTED_EXTENSIONS.length} approved entrypoints`,
			"package.json#pi.extensions",
		);
	if (
		!skills ||
		!equalSorted(
			skills,
			EXPECTED_SKILLS.map((name) => `skills/${name}`),
		)
	)
		invalid("Pi skills must be the exact three approved resources", "package.json#pi.skills");
	if (!prompts || !equalSorted(prompts, ["pi/prompts/orchestrate.md"]))
		invalid("Pi prompt manifest differs", "package.json#pi.prompts");
	if (!themes || !equalSorted(themes, ["pi/themes/foreman.json"]))
		invalid("Pi theme manifest differs", "package.json#pi.themes");
	const declared = [
		...(extensions ?? []),
		...(skills ?? []),
		...(prompts ?? []),
		...(themes ?? []),
	];
	const fileSet = new Set(files.map((path) => posixPath(root, path)));
	for (const entry of declared) {
		if (/\.(?:test|smoke|e2e)\.ts$/.test(entry) || entry.includes("/lib/"))
			invalid("tests and helpers cannot be entrypoints", entry);
		const skillFile = `${entry}/SKILL.md`;
		if (!fileSet.has(entry) && !fileSet.has(skillFile))
			invalid("declared resource does not exist", entry);
	}
	return failures;
}

export async function auditRepository(
	root: string,
): Promise<{ summary: AuditSummary; failures: AuditFailure[] }> {
	const walked = await walk(root);
	const failures = [...walked.failures, ...(await validateManifest(root, walked.files))];
	if (walked.sourceBytes > MAX_SOURCE_BYTES) {
		failures.push({
			category: "size-budget",
			path: ".",
			detail: `${walked.sourceBytes} bytes exceeds ${MAX_SOURCE_BYTES} bytes`,
		});
	}
	const countFiles = (prefix: string, suffix: string): number =>
		walked.files.filter((path) => posixPath(root, path).startsWith(prefix) && path.endsWith(suffix))
			.length;
	return {
		summary: {
			skills: countFiles("skills/", "SKILL.md"),
			extensions: EXPECTED_EXTENSIONS.length,
			prompts: countFiles("pi/prompts/", ".md"),
			themes: countFiles("pi/themes/", ".json"),
			excludedPathChecks: EXCLUDED_NAMES.size,
			sourceBytes: walked.sourceBytes,
		},
		failures,
	};
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { root: { type: "string" } } });
	const root = values.root ?? process.cwd();
	const result = await auditRepository(root);
	for (const failure of result.failures)
		process.stderr.write(`${failure.category}: ${failure.path}: ${failure.detail}\n`);
	const summary = result.summary;
	process.stdout.write(
		`audit summary: skills=${summary.skills} extensions=${summary.extensions} prompts=${summary.prompts} themes=${summary.themes} excluded-checks=${summary.excludedPathChecks} source-bytes=${summary.sourceBytes}\n`,
	);
	if (result.failures.length > 0) process.exitCode = 1;
}

if (
	process.argv[1]?.endsWith("audit-repository.ts") ||
	process.argv[1]?.endsWith("audit-repository.js")
) {
	main().catch((error: unknown) => {
		process.stderr.write(
			`invalid-manifest: .: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
