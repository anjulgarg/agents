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
		expect(result.summary).toMatchObject({ skills: 3, extensions: 30, prompts: 1, themes: 1 });
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

	it("keeps Foreman Review transport-neutral with a fail-closed native worker contract", async () => {
		const worker = await readFile(join(root, "skills", "foreman-worker", "SKILL.md"), "utf8");
		const native = await readFile(
			join(root, "skills", "foreman-worker", "references", "native-subagent.md"),
			"utf8",
		);
		const review = await readFile(join(root, "skills", "foreman-review", "SKILL.md"), "utf8");

		expect(worker).toContain("`TRANSPORT`: `auto` by default");
		expect(worker).toContain("references/native-subagent.md");
		expect(worker).toContain("A failed persistent resume never creates a replacement worker");
		expect(worker).toContain("fall back only when no child session or invocation was created");
		expect(native).toContain("If any required capability is absent or uncertain");
		expect(native).toContain("resume that exact session by identifier");
		expect(native).toContain("`subagent_resume`");
		expect(native).toContain("`subagent_result`");
		expect(review).toContain("`TRANSPORT=auto`");
		expect(review).toContain("same exact session");
		expect(review).toContain("transport, harness, and session ID");
		expect(review).not.toContain("`subagent_resume`");
	});
});
