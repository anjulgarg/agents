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
		expect(result.summary).toMatchObject({ skills: 3, extensions: 28, prompts: 1, themes: 1 });
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
});
