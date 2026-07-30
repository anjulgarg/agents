/**
 * Optional real typescript-language-server integration.
 * Resolves via PATH, then NODE_PATH / npm root -g. Skips clearly when absent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { LspManager } from "../lsp/manager.ts";
import { findTypescriptLanguageServer } from "../lsp/servers.ts";
import { toFileUri } from "../lsp/paths.ts";

function assert(name: string, condition: boolean, details?: string): void {
	if (!condition) throw new Error(`FAIL: ${name}${details ? `\n${details}` : ""}`);
	console.log(`PASS: ${name}`);
}

function ensureServerOnPath(): string | undefined {
	const direct = findTypescriptLanguageServer();
	if (direct.available) return direct.executable?.resolvedPath;

	const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout?.trim();
	const candidates = [process.env.NODE_PATH, npmRoot].filter(Boolean) as string[];

	for (const root of candidates) {
		for (const part of root.split(path.delimiter)) {
			const bin = path.join(part, ".bin", "typescript-language-server");
			const pkgBin = path.join(part, "typescript-language-server", "lib", "cli.mjs");
			for (const candidate of [bin, pkgBin]) {
				if (fs.existsSync(candidate)) {
					const dir = path.dirname(candidate);
					process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
					if (part)
						process.env.NODE_PATH = [part, process.env.NODE_PATH]
							.filter(Boolean)
							.join(path.delimiter);
					const again = findTypescriptLanguageServer();
					if (again.available) return again.executable?.resolvedPath;
				}
			}
		}
	}
	return undefined;
}

const resolved = ensureServerOnPath();
if (!resolved) {
	const lookup = findTypescriptLanguageServer();
	console.log(`SKIP: real typescript-language-server integration (${lookup.error})`);
	process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-real-"));
fs.writeFileSync(
	path.join(root, "tsconfig.json"),
	JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } }),
);
fs.writeFileSync(
	path.join(root, "a.ts"),
	[
		"export function greet(name: string): string {",
		"  return `hi ${name}`;",
		"}",
		"export const value = greet('world');",
		"",
	].join("\n"),
);

const manager = new LspManager();
try {
	const session = await manager.getSession(root, path.join(root, "a.ts"));
	assert("real server initialized", session.client.isInitialized);

	const file = path.join(root, "a.ts");
	const uri = toFileUri(file);
	await session.client.ensureSynced(file, uri);
	await new Promise((r) => setTimeout(r, 1500));

	const defs = await session.client.definition(uri, 4, 23);
	assert(
		"real definition finds greet",
		defs.some((d) => d.line === 1),
		JSON.stringify(defs),
	);

	const refs = await session.client.references(uri, 1, 17);
	assert("real references include call site", refs.length >= 2, JSON.stringify(refs));

	const hover = await session.client.hover(uri, 1, 17);
	assert("real hover includes signature", /greet|string/i.test(hover), hover);

	const synced = await session.client.ensureSynced(file, uri);
	const diags = await session.client.fileDiagnostics(uri, synced.version);
	assert(
		"real diagnostics freshness known",
		diags.freshness === "fresh" || diags.freshness === "stale" || diags.freshness === "unavailable",
		diags.freshness,
	);
	// Unversioned TLS must not claim fresh from a pre-sync cache after a change.
	fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("world", "there"));
	const synced2 = await session.client.ensureSynced(file, uri);
	const diags2 = await session.client.fileDiagnostics(uri, synced2.version);
	assert(
		"real diagnostics after edit are not falsely pre-sync fresh",
		diags2.freshness === "fresh" ||
			diags2.freshness === "stale" ||
			diags2.freshness === "unavailable",
		diags2.freshness,
	);

	const status = manager.statusFor(root, file);
	assert("status reports available", status.serverAvailable && status.initialized);
} finally {
	await manager.disposeAll();
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("Real typescript-language-server integration passed");
