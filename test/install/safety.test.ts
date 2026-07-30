import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateDestination, validateSafeRoots } from "../../src/install/safety.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("source and destination containment", () => {
	it("allows a source repository inside home but outside every managed destination", async () => {
		const root = await mkdtemp(join(tmpdir(), "agents-safety-"));
		temporary.push(root);
		const home = join(root, "home");
		const sourceRoot = join(home, "Workspace", "agents");
		await mkdir(sourceRoot, { recursive: true });

		await expect(validateSafeRoots(home, sourceRoot)).resolves.toEqual({ home, sourceRoot });
		await expect(
			validateDestination(home, join(home, ".agents", "skills", "foreman-plan"), sourceRoot),
		).resolves.toBeUndefined();
	});

	it("rejects writes into the source and target homes inside the source", async () => {
		const root = await mkdtemp(join(tmpdir(), "agents-safety-"));
		temporary.push(root);
		const home = join(root, "home");
		const sourceRoot = join(home, "Workspace", "agents");
		await mkdir(sourceRoot, { recursive: true });

		await expect(
			validateDestination(home, join(sourceRoot, "src", "install.ts"), sourceRoot),
		).rejects.toMatchObject({ code: "unsafe-path" });
		await expect(
			validateSafeRoots(join(sourceRoot, "nested-home"), sourceRoot),
		).rejects.toMatchObject({ code: "unsafe-path" });
	});
});
