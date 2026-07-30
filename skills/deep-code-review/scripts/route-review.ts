import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseArgs } from "node:util";

export const MAX_REVIEWERS = 4;

const SOURCE_EXTENSIONS = new Set([
	".c",
	".cc",
	".cpp",
	".cs",
	".dart",
	".ex",
	".exs",
	".fs",
	".fsx",
	".go",
	".groovy",
	".hs",
	".java",
	".js",
	".jsx",
	".jl",
	".kt",
	".kts",
	".lua",
	".m",
	".mm",
	".php",
	".pl",
	".ps1",
	".py",
	".r",
	".rb",
	".rs",
	".scala",
	".sh",
	".sol",
	".swift",
	".ts",
	".tsx",
	".vb",
	".vue",
	".svelte",
	".zig",
]);
const TEST_PATTERN = /(^|\/)(tests?|specs?|__tests__)(\/|$)|[._](test|spec)\./i;
const DOC_PATTERN = /(^|\/)(docs?|examples?)(\/|$)|\.(md|mdx|rst|txt)$/i;
const GENERATED_PATTERN = /(^|\/)(dist|build|vendor|generated|node_modules)(\/|$)|\.min\./i;

type RoleRule = readonly [number, RegExp, RegExp];
const ROLE_RULES: Readonly<Record<string, RoleRule>> = {
	"security/privacy": [
		10,
		/auth|oauth|permission|policy|security|crypto|secret|token|session|credential|middleware/i,
		/authorize|authenticate|password|credential|secret|token|encrypt|decrypt|eval\(|exec\(|subprocess|shell=True|innerHTML|pickle|yaml\.load|SELECT\s|INSERT\s|UPDATE\s/i,
	],
	"data/concurrency": [
		9,
		/migration|schema|database|\bdb\b|sql|model|repository|queue|cache|worker/i,
		/transaction|rollback|commit|async|await|thread|mutex|lock|atomic|race|deadlock|retry|idempoten|enqueue|dequeue/i,
	],
	"contract/compatibility": [
		8,
		/api|proto|schema|config|manifest|package\.json|lock|requirements|public|interface|types?/i,
		/export |public |interface |version|serialize|deserialize|deprecated|breaking|request|response/i,
	],
	"frontend/accessibility": [
		7,
		/\.(tsx|jsx|vue|svelte|html|css|scss)$|(^|\/)(ui|components?|pages?|views?)(\/|$)/i,
		/aria-|role=|tabindex|keydown|onclick|focus|screen reader|responsive|viewport/i,
	],
	"reliability/operations": [
		6,
		/docker|k8s|kubernetes|helm|terraform|deploy|workflow|\.github|monitor|logging|infra/i,
		/timeout|healthcheck|readiness|liveness|retry|backoff|shutdown|signal|metric|trace|log/i,
	],
};

export interface ReviewRoute {
	risk: "low" | "medium" | "high";
	reviewers: Array<{ role: string; reason: string }>;
	reviewerCount: number;
	maxReviewers: number;
	reserveSlots: number;
	signals: {
		authoredFiles: number;
		sourceFiles: number;
		changedLines: number;
		docsOnly: boolean;
		topLevelAreas: number;
	};
}

export function parseDiff(text: string): { files: string[]; changes: number } {
	const files: string[] = [];
	let changes = 0;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("diff --git ")) {
			const match = /^diff --git (?:"a\/.*"|a\/\S+) (?:"b\/(.*)"|b\/(\S+))$/.exec(line);
			const target = match?.[1] ?? match?.[2];
			if (target) files.push(target.replaceAll('\\"', '"'));
		} else if (line.startsWith("+++ b/")) {
			files.push(line.slice(6));
		} else if (
			(line.startsWith("+") || line.startsWith("-")) &&
			!line.startsWith("+++") &&
			!line.startsWith("---")
		) {
			changes += 1;
		}
	}
	return { files: [...new Set(files)].sort(), changes };
}

export function route(text: string): ReviewRoute {
	const { files, changes } = parseDiff(text);
	const authored = files.filter((path) => !GENERATED_PATTERN.test(path));
	const source = authored.filter((path) => SOURCE_EXTENSIONS.has(extname(path).toLowerCase()));
	const production = source.filter((path) => !TEST_PATTERN.test(path));
	const docsOnly = authored.length > 0 && authored.every((path) => DOC_PATTERN.test(path));
	const candidates: Array<[number, string, string]> = [];

	if (authored.length > 0 && !docsOnly) {
		for (const [role, [weight, pathPattern, contentPattern]] of Object.entries(ROLE_RULES)) {
			const pathHits = authored.filter((path) => pathPattern.test(path)).sort();
			const contentHit = contentPattern.test(text);
			if (pathHits.length > 0 || contentHit) {
				const score = weight + Math.min(pathHits.length, 3) + (contentHit ? 2 : 0);
				candidates.push([
					score,
					role,
					`matched ${pathHits.length > 0 ? pathHits.slice(0, 3).join(", ") : "changed code"}`,
				]);
			}
		}
	}

	const topDirs = new Set(authored.map((path) => path.split("/", 1)[0]));
	if (!docsOnly && (authored.length >= 8 || topDirs.size >= 4 || changes >= 500)) {
		candidates.push([8, "architect", "broad or cross-cutting change"]);
	}
	if (production.length > 0 && !docsOnly) {
		candidates.push([5, "intent/correctness", "production behavior changed"]);
	}

	candidates.sort((left, right) => right[0] - left[0] || left[1].localeCompare(right[1]));
	const reviewers = [{ role: "skeptic", reason: "required adversarial baseline" }];
	const seen = new Set(["skeptic"]);
	for (const [, role, reason] of candidates) {
		if (!seen.has(role) && reviewers.length < MAX_REVIEWERS) {
			reviewers.push({ role, reason });
			seen.add(role);
		}
	}
	const highRisk = candidates.some(([score]) => score >= 10) || changes >= 500;
	return {
		risk: highRisk ? "high" : reviewers.length > 1 ? "medium" : "low",
		reviewers,
		reviewerCount: reviewers.length,
		maxReviewers: MAX_REVIEWERS,
		reserveSlots: MAX_REVIEWERS - reviewers.length,
		signals: {
			authoredFiles: authored.length,
			sourceFiles: source.length,
			changedLines: changes,
			docsOnly,
			topLevelAreas: topDirs.size,
		},
	};
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { patch: { type: "string", short: "p" } } });
	if (!values.patch) throw new Error("Missing required --patch <path>");
	const text = await readFile(values.patch, { encoding: "utf8" });
	process.stdout.write(`${JSON.stringify(route(text), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
