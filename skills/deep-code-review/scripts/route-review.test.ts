import { describe, expect, it } from "vitest";
import { route } from "./route-review.ts";

function diff(path: string, body: string): string {
	return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`;
}

function roles(patch: string): string[] {
	return route(patch).reviewers.map((reviewer) => reviewer.role);
}

describe("deep review routing", () => {
	it("uses only the skeptic for documentation", () => {
		const patch = diff("docs/authentication.md", "+Document token setup");
		expect(roles(patch)).toEqual(["skeptic"]);
		expect(route(patch).risk).toBe("low");
	});

	it("adds correctness for normal production code", () => {
		expect(roles(diff("src/math.py", "+def total(values):\n+    return sum(values)"))).toEqual([
			"skeptic",
			"intent/correctness",
		]);
	});

	it("routes a deleted source file", () => {
		const patch =
			"diff --git a/src/legacy.py b/src/legacy.py\ndeleted file mode 100644\n--- a/src/legacy.py\n+++ /dev/null\n-old_behavior()\n";
		expect(roles(patch)).toContain("intent/correctness");
	});

	it("routes security and contract signals", () => {
		const selected = roles(
			diff("src/api/auth.ts", "+export function authorize(token) { return token; }"),
		);
		expect(selected[0]).toBe("skeptic");
		expect(selected).toContain("security/privacy");
		expect(selected).toContain("contract/compatibility");
		expect(selected.length).toBeLessThanOrEqual(4);
	});

	it("never exceeds the reviewer cap", () => {
		const patch = [
			diff(
				"src/api/auth.tsx",
				"+export async function authorize(token) { await db.transaction(); }",
			),
			diff("migrations/schema.sql", "+ALTER TABLE credentials ADD secret TEXT;"),
			diff(".github/workflows/deploy.yml", "+timeout: 30"),
		].join("");
		expect(roles(patch)).toHaveLength(4);
	});
});
