import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditRepository, type AuditCategory } from "../../scripts/audit-repository.ts";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "agents-audit-"));
	temporaryDirectories.push(root);
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ name: "fixture", private: true, type: "module", pi: {} }),
	);
	return root;
}

async function expectFailure(root: string, category: AuditCategory, path: string): Promise<void> {
	const result = await auditRepository(root);
	expect(result.failures).toEqual(
		expect.arrayContaining([expect.objectContaining({ category, path })]),
	);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("repository audit failures", () => {
	it("rejects explicit exclusions", async () => {
		const root = await fixture();
		await mkdir(join(root, "skills", "find-skills"), { recursive: true });
		await expectFailure(root, "excluded-asset", "skills/find-skills");
	});

	it("rejects symbolic links", async () => {
		const root = await fixture();
		await writeFile(join(root, "target.ts"), "export {};\n");
		await symlink(join(root, "target.ts"), join(root, "linked.ts"));
		await expectFailure(root, "unsafe-link", "linked.ts");
	});

	it("rejects credential and cache paths", async () => {
		const root = await fixture();
		await writeFile(join(root, "auth.json"), "{}\n");
		await expectFailure(root, "secret-pattern", "auth.json");
	});

	it("rejects Python and shell files", async () => {
		const root = await fixture();
		await writeFile(join(root, "install.sh"), "echo unsafe\n", { mode: 0o755 });
		await expectFailure(root, "disallowed-script", "install.sh");
	});

	it("rejects token-shaped literals without flagging environment variable names", async () => {
		const root = await fixture();
		await writeFile(join(root, "expected.ts"), 'const name = "OPENAI_API_KEY";\n');
		const clean = await auditRepository(root);
		expect(clean.failures.filter((failure) => failure.path === "expected.ts")).toEqual([]);
		await writeFile(
			join(root, "leaked.ts"),
			`export const leaked = "${"ghp_" + "a".repeat(36)}";\n`,
		);
		await expectFailure(root, "secret-pattern", "leaked.ts");
	});

	it("rejects manifest test entrypoints", async () => {
		const root = await fixture();
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				name: "@anjulgarg/agents",
				private: true,
				type: "module",
				engines: { node: ">=22.19.0" },
				bin: { agents: "dist/cli.js" },
				dependencies: { ink: "7.1.1", react: "19.2.8" },
				pi: { extensions: ["pi/extensions/example.test.ts"], skills: [], prompts: [], themes: [] },
			}),
		);
		await mkdir(join(root, "pi", "extensions"), { recursive: true });
		await writeFile(join(root, "pi", "extensions", "example.test.ts"), "export {};\n");
		await expectFailure(root, "invalid-manifest", "pi/extensions/example.test.ts");
	});

	it("rejects source payloads above 2.5 MiB", async () => {
		const root = await fixture();
		await writeFile(join(root, "payload.bin"), Buffer.alloc(2.5 * 1024 * 1024 + 1));
		await expectFailure(root, "size-budget", ".");
	});
});
