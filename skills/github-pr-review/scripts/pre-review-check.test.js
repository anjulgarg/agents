#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pre-review-check-"));
const fakeGh = path.join(temp, "gh");
const longPatch = "x".repeat(500);

fs.writeFileSync(
	fakeGh,
	`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') console.log('tester');
else if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify({number:1,title:'Test',state:'OPEN',isDraft:false,mergeStateStatus:process.env.MERGE_STATE || 'CLEAN',headRefName:'feature',baseRefName:'develop',headRefOid:'abc',updatedAt:'2026-07-10',author:{login:'dev'},url:'https://example.test/pr/1'}));
else if (args[0] === 'api' && args[1].includes('/files')) console.log(JSON.stringify([[{filename:process.env.FILE_NAME || 'src/a.js',status:'modified',additions:2,deletions:1,changes:3,patch:${JSON.stringify(longPatch)},raw_url:'raw',blob_url:'blob'}]]));
else throw new Error('Unexpected gh call: ' + args.join(' '));
`,
	{ mode: 0o755 },
);

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-review-check.js");
const env = { ...process.env, PATH: `${temp}${path.delimiter}${process.env.PATH}` };

function run(extra = [], overrides = {}) {
	return JSON.parse(
		execFileSync(process.execPath, [script, "--repo", "owner/repo", "--pr", "1", ...extra], {
			encoding: "utf8",
			env: { ...env, ...overrides },
		}),
	);
}

try {
	const compact = run();
	assert.equal(compact.metadata.raw, undefined);
	assert.equal(compact.metadata.files[0].patchPreview.length, 160);
	assert.equal(compact.metadata.files[0].rawUrl, undefined);

	const raw = run(["--raw"]);
	assert.equal(raw.metadata.raw.files[0].patch.length, 500);

	const behind = run([], { MERGE_STATE: "BEHIND" });
	assert.equal(behind.decision.canReview, true);
	assert.deepEqual(behind.decision.warnings, ["behind_base"]);

	const conflicted = run([], { MERGE_STATE: "DIRTY" });
	assert.equal(conflicted.decision.canReview, false);
	assert.deepEqual(conflicted.decision.hardSkips, ["merge_conflicts"]);

	const sensitive = run([], { FILE_NAME: "src/auth/login.js" });
	assert.equal(sensitive.decision.suggestedDepth, "deep");
	console.log("pre-review-check compact-output tests passed");
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
