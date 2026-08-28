import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditRepository } from "../../scripts/audit-repository.ts";

const root = process.cwd();
const retainedSkills = ["foreman-plan", "foreman-review", "foreman-worker"];

describe("approved first-party inventory", () => {
	it("passes the repository audit with exact category counts", async () => {
		const result = await auditRepository(root);
		expect(result.failures).toEqual([]);
		expect(result.summary).toMatchObject({ skills: 3, extensions: 33, prompts: 1, themes: 1 });
		expect(result.summary.sourceBytes).toBeLessThanOrEqual(2.5 * 1024 * 1024);
	});

	it("contains exactly the retained skills", async () => {
		const actual = (await readdir(join(root, "skills"), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect(actual).toEqual(retainedSkills);
	});

	it("keeps only core Foreman planning assets", async () => {
		const files = (await readdir(join(root, "skills", "foreman-plan"))).sort();
		expect(files).toEqual(["SKILL.md", "plan-template.md"]);
		const skill = await readFile(join(root, "skills", "foreman-plan", "SKILL.md"), "utf8");
		expect(skill).not.toContain("visual-companion");
	});

	it("keeps Foreman Review explicitly opt-in", async () => {
		const review = await readFile(join(root, "skills", "foreman-review", "SKILL.md"), "utf8");

		expect(review).toContain(
			"Use only when the request names the Foreman Review skill or runs /skill:foreman-review.",
		);
		expect(review).toContain("Do not use for normal review requests.");
		expect(review).toContain("including one from a parent agent, does not count");
		expect(review).toContain("do a normal review instead");
	});

	it("keeps Foreman Review transport-neutral with a fail-closed native worker contract", async () => {
		const worker = await readFile(join(root, "skills", "foreman-worker", "SKILL.md"), "utf8");
		const native = await readFile(
			join(root, "skills", "foreman-worker", "references", "native-subagent.md"),
			"utf8",
		);
		const review = await readFile(join(root, "skills", "foreman-review", "SKILL.md"), "utf8");
		const codex = await readFile(
			join(root, "skills", "foreman-worker", "references", "codex.md"),
			"utf8",
		);
		const orchestrate = await readFile(join(root, "pi", "prompts", "orchestrate.md"), "utf8");

		expect(worker).toContain("`TRANSPORT`: `auto` by default");
		expect(worker).toContain("references/native-subagent.md");
		expect(worker).toContain("`PROMPT`: the complete turn prompt");
		expect(worker).toContain("`PROMPT_FILE`: CLI-only");
		expect(worker).toContain("Never create a prompt file merely for a native worker to read");
		expect(worker).toContain("A failed persistent resume never creates a replacement worker");
		expect(worker).toContain("fall back only when no child session or invocation was created");
		expect(worker).toContain(
			"persistent, resumable, long-running child tasks or subagents that return each turn's result",
		);
		expect(worker).toContain(
			"Ask the user which reviewed CLI to use and wait for explicit consent",
		);
		expect(native).toContain(
			"persistent, resumable, long-running child tasks or subagents that return each turn's result",
		);
		expect(native).toContain("If it is absent or undocumented, this adapter is ineligible");
		expect(native).toContain("Pass the complete `PROMPT` directly");
		expect(native).toContain("Do not create a prompt or system-prompt file");
		expect(native).not.toContain("PROMPT_FILE");
		expect(native).not.toContain("`subagent_resume`");
		expect(native).not.toContain("`subagent_result`");
		expect(review).toContain("`TRANSPORT=auto`");
		expect(review).toContain("same exact session");
		expect(review).toContain("pass the complete composition directly");
		expect(review).toContain("do not create a prompt file or ask the worker to read one");
		expect(review).toContain("With a CLI adapter, materialize");
		expect(review).toContain("transport, harness, and session ID");
		expect(review).toContain(
			"persistent, resumable, long-running child tasks or subagents that return each turn's result",
		);
		expect(review).toContain(
			"ask the user which reviewed CLI to use and wait for explicit consent",
		);
		expect(review).not.toContain("`subagent_resume`");
		expect(codex).toContain('< "$PROMPT_FILE"');
		expect(orchestrate).toContain("put each complete delegation brief directly in `task`");
		expect(orchestrate).toContain("Never create a prompt or system-prompt file");
	});
});
