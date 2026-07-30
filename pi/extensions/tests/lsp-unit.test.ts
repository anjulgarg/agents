import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
	formatDiagnostics,
	formatLocationList,
	formatWorkspaceSymbols,
	paginate,
	dedupeLocations,
	type LocationResult,
} from "../lsp/format.ts";
import {
	normalizeInputPath,
	resolveWorkspacePath,
	PathSecurityError,
	assertUriInWorkspace,
} from "../lsp/paths.ts";
import { resolveColumn } from "../lsp/position.ts";
import {
	applyEditsToText,
	offsetAt,
	validateWorkspaceEdit,
	WorkspaceEditError,
} from "../lsp/workspace-edit.ts";
import { DocumentStore } from "../lsp/documents.ts";
import { toFileUri } from "../lsp/paths.ts";

function assert(name: string, condition: boolean, details?: string): void {
	if (!condition) throw new Error(`FAIL: ${name}${details ? `\n${details}` : ""}`);
	console.log(`PASS: ${name}`);
}

// paths
assert("strips leading @", normalizeInputPath("@src/foo.ts") === "src/foo.ts");
assert("trims whitespace", normalizeInputPath("  src/a.ts  ") === "src/a.ts");

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-path-"));
	fs.writeFileSync(path.join(root, "ok.ts"), "export {}\n");
	const resolved = resolveWorkspacePath("ok.ts", root);
	assert("resolves project-relative path", resolved.relativePath === "ok.ts");
	const at = resolveWorkspacePath("@ok.ts", root);
	assert("resolves @-prefixed path", at.relativePath === "ok.ts");

	let escaped = false;
	try {
		resolveWorkspacePath("../outside.ts", root);
	} catch (error) {
		escaped = error instanceof PathSecurityError;
	}
	assert("rejects path escape", escaped);

	let badScheme = false;
	try {
		assertUriInWorkspace("https://example.com/x", root);
	} catch (error) {
		badScheme = error instanceof PathSecurityError;
	}
	assert("rejects non-file URI", badScheme);
	fs.rmSync(root, { recursive: true, force: true });
}

// position / symbol
{
	const content = "const foo = 1;\nconst bar = foo;\n";
	assert("uses explicit column", resolveColumn(content, 1, 7, undefined).column === 7);
	assert("resolves unique symbol", resolveColumn(content, 2, undefined, "bar").column === 7);
	let ambiguous = false;
	try {
		resolveColumn("foo foo\n", 1, undefined, "foo");
	} catch {
		ambiguous = true;
	}
	assert("rejects ambiguous symbol", ambiguous);
}

// format / limits
{
	const locs: LocationResult[] = [];
	for (let i = 0; i < 5; i++) {
		locs.push({ path: "a.ts", line: i + 1, column: 1 });
		locs.push({ path: "a.ts", line: i + 1, column: 1 }); // dup
	}
	const deduped = dedupeLocations(locs);
	assert("dedupes locations", deduped.length === 5);
	const page = paginate(deduped, { offset: 0, limit: 2 });
	assert("paginates with hasMore", page.meta.hasMore && page.meta.returned === 2);
	const text = formatLocationList("references", deduped, { limit: 2 });
	assert("format mentions truncation", text.includes("truncated"));
	assert(
		"workspace symbols stable order",
		formatWorkspaceSymbols([
			{ name: "b", path: "b.ts", line: 1, column: 1, kind: 12 },
			{ name: "a", path: "a.ts", line: 1, column: 1, kind: 12 },
		]).indexOf("a.ts") <
			formatWorkspaceSymbols([
				{ name: "b", path: "b.ts", line: 1, column: 1, kind: 12 },
				{ name: "a", path: "a.ts", line: 1, column: 1, kind: 12 },
			]).indexOf("b.ts"),
	);
	const diagText = formatDiagnostics("a.ts", [], { freshness: "fresh" });
	assert("empty diagnostics header", diagText.includes("[fresh]"));
}

// workspace edit validation + apply text
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-edit-"));
	const file = path.join(root, "a.ts");
	fs.writeFileSync(file, "const foo = 1;\n");
	const uri = toFileUri(file);
	const store = new DocumentStore();

	let rejectedCreate = false;
	try {
		validateWorkspaceEdit(
			{ documentChanges: [{ kind: "create", uri: toFileUri(path.join(root, "b.ts")) }] },
			root,
			store,
		);
	} catch (error) {
		rejectedCreate = error instanceof WorkspaceEditError;
	}
	assert("rejects create resource operation", rejectedCreate);

	let rejectedOverlap = false;
	try {
		validateWorkspaceEdit(
			{
				changes: {
					[uri]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							newText: "x",
						},
						{
							range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } },
							newText: "y",
						},
					],
				},
			},
			root,
			store,
		);
	} catch (error) {
		rejectedOverlap = error instanceof WorkspaceEditError;
	}
	assert("rejects overlapping edits", rejectedOverlap);

	let rejectedEscape = false;
	try {
		validateWorkspaceEdit(
			{
				changes: {
					[pathToFileURL("/tmp/evil.ts").href]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							newText: "z",
						},
					],
				},
			},
			root,
			store,
		);
	} catch {
		rejectedEscape = true;
	}
	assert("rejects URI outside workspace", rejectedEscape);

	const applied = applyEditsToText("abcdef", [
		{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } }, newText: "XY" },
		{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "Q" },
	]);
	assert("applies edits end-to-start", applied === "QcXYf", applied);
	assert("offsetAt basic", offsetAt("ab\ncd", 1, 1) === 4);

	fs.rmSync(root, { recursive: true, force: true });
}

console.log("All format/path/edit unit tests passed");
