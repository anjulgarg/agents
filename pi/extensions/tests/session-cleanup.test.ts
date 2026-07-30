/**
 * Session cleanup extension tests.
 *
 * Run: npm run test:extensions
 */

import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import sessionCleanupExtension, {
	cleanEmptyParents,
	collectCandidates,
	formatBytes,
	getDefaultSessionsRoot,
	getSessionScope,
	isWithin,
	parseDays,
} from "../session-cleanup.ts";

function assert(name: string, condition: boolean, details: string): void {
	if (!condition) throw new Error(`FAIL: ${name}\n${details}`);
	console.log(`PASS: ${name}`);
}

function sessionInfo(path: string, modified = new Date()): SessionInfo {
	return {
		path,
		id: path,
		cwd: "/tmp/project",
		created: modified,
		modified,
		messageCount: 1,
		firstMessage: "test",
		allMessagesText: "test",
	};
}

function exists(path: string): boolean {
	return existsSync(path);
}

assert(
	"parseDays defaults to seven days",
	parseDays(undefined) === 7 && parseDays("  ") === 7,
	"default mismatch",
);
assert(
	"parseDays accepts positive integers",
	parseDays("1") === 1 && parseDays("30") === 30,
	"valid mismatch",
);
assert(
	"parseDays rejects unsafe or malformed values",
	["0", "-1", "1.5", "abc", "01", "9007199254740992"].every(
		(value) => parseDays(value) === undefined,
	),
	"invalid value accepted",
);
assert(
	"formatBytes uses binary units",
	formatBytes(0) === "0 B" && formatBytes(500) === "500 B" && formatBytes(2048) === "2.0 KiB",
	`${formatBytes(0)}, ${formatBytes(500)}, ${formatBytes(2048)}`,
);
assert(
	"path containment rejects siblings and accepts descendants",
	isWithin("/tmp/sessions", "/tmp/sessions/project/file.jsonl") &&
		!isWithin("/tmp/sessions", "/tmp/sessions-elsewhere/file.jsonl") &&
		!isWithin("/tmp/sessions", "/tmp/sessions"),
	"containment mismatch",
);

const defaultRoot = getDefaultSessionsRoot();
assert(
	"default session subdirectories select all-project listing",
	getSessionScope(join(defaultRoot, "--project--")).listAllProjects &&
		getSessionScope(join(defaultRoot, "--project--")).root === defaultRoot,
	JSON.stringify(getSessionScope(join(defaultRoot, "--project--"))),
);

let commandHandler: ((args: string | undefined, ctx: any) => Promise<void>) | undefined;
sessionCleanupExtension({
	registerCommand(name: string, command: any) {
		if (name === "session:cleanup") commandHandler = command.handler;
	},
} as any);
assert("registers /session:cleanup", typeof commandHandler === "function", String(commandHandler));

const originalListAll = SessionManager.listAll;
let listedWith: unknown[] | undefined;
let listedSessions: SessionInfo[] = [];
(SessionManager as any).listAll = async (...args: unknown[]) => {
	listedWith = args;
	return listedSessions;
};

interface UiState {
	notifications: Array<{ message: string; type?: string }>;
	confirms: Array<{ title: string; message: string }>;
	confirm: (title: string, message: string) => Promise<boolean>;
}

function makeUi(confirm: UiState["confirm"]): UiState {
	const notifications: UiState["notifications"] = [];
	const confirms: UiState["confirms"] = [];
	return {
		notifications,
		confirms,
		async confirm(title, message) {
			confirms.push({ title, message });
			return confirm(title, message);
		},
	};
}

function context(root: string, currentFile: string | undefined, ui: UiState, hasUI = true): any {
	return {
		hasUI,
		mode: hasUI ? "tui" : "print",
		sessionManager: {
			getSessionDir: () => root,
			getSessionFile: () => currentFile,
		},
		ui: {
			confirm: ui.confirm,
			notify: (message: string, type?: string) => ui.notifications.push({ message, type }),
		},
	};
}

const tempRoot = mkdtempSync(join(tmpdir(), "pi-session-cleanup-"));
try {
	const customRoot = join(tempRoot, "custom-sessions");
	const projectDir = join(customRoot, "project");
	await mkdir(projectDir, { recursive: true });

	const oldFile = join(projectDir, "old.jsonl");
	const recentFile = join(projectDir, "recent.jsonl");
	const currentFile = join(projectDir, "current.jsonl");
	for (const path of [oldFile, recentFile, currentFile])
		writeFileSync(path, '{"type":"session"}\n');

	const now = Date.now();
	const oldDate = new Date(now - 14 * 24 * 60 * 60 * 1000);
	const recentDate = new Date(now - 60 * 60 * 1000);
	await utimes(oldFile, oldDate, oldDate);
	await utimes(recentFile, recentDate, recentDate);
	await utimes(currentFile, oldDate, oldDate);

	listedSessions = [
		sessionInfo(oldFile, recentDate),
		sessionInfo(recentFile, oldDate),
		sessionInfo(currentFile, oldDate),
	];
	listedWith = undefined;
	const cancelUi = makeUi(async () => false);
	await commandHandler!("", context(customRoot, currentFile, cancelUi));
	const customListArgs = listedWith as unknown[] | undefined;
	assert(
		"preview uses file mtime, excludes an old current session, and scopes custom listing",
		cancelUi.confirms.length === 1 &&
			cancelUi.confirms[0]!.message.includes("1 session(s)") &&
			cancelUi.confirms[0]!.message.includes("last modified more than 7 day(s)") &&
			customListArgs?.length === 1 &&
			customListArgs[0] === customRoot,
		JSON.stringify({ confirms: cancelUi.confirms, listedWith }),
	);
	assert(
		"cancelling preserves every candidate",
		exists(oldFile) &&
			cancelUi.notifications.some(({ message }) => message === "Session cleanup cancelled."),
		JSON.stringify(cancelUi.notifications),
	);

	const deleteUi = makeUi(async () => true);
	await commandHandler!("", context(customRoot, currentFile, deleteUi));
	assert(
		"confirmation permanently deletes only the eligible session",
		!exists(oldFile) &&
			exists(recentFile) &&
			exists(currentFile) &&
			deleteUi.notifications.some(
				({ message }) => message === "Deleted 1 session(s); skipped 0; failed 0.",
			),
		JSON.stringify(deleteUi.notifications),
	);

	writeFileSync(oldFile, '{"type":"session"}\n');
	await utimes(oldFile, oldDate, oldDate);
	listedSessions = [sessionInfo(oldFile)];
	const changedUi = makeUi(async () => {
		await utimes(oldFile, new Date(), new Date());
		return true;
	});
	await commandHandler!("7", context(customRoot, undefined, changedUi));
	assert(
		"a session updated after preview is skipped",
		exists(oldFile) &&
			changedUi.notifications.some(
				({ message }) => message === "Deleted 0 session(s); skipped 1; failed 0.",
			),
		JSON.stringify(changedUi.notifications),
	);

	await utimes(oldFile, oldDate, oldDate);
	listedSessions = [sessionInfo(oldFile), sessionInfo(join(projectDir, "raced.jsonl"))];
	const racedUi = makeUi(async () => {
		await unlink(oldFile);
		return true;
	});
	await commandHandler!("7", context(customRoot, undefined, racedUi));
	assert(
		"sessions removed during confirmation are harmlessly skipped",
		racedUi.confirms[0]!.message.includes("1 session(s)") &&
			racedUi.notifications.some(
				({ message }) => message === "Deleted 0 session(s); skipped 1; failed 0.",
			),
		JSON.stringify(racedUi.notifications),
	);

	const outsideDir = join(tempRoot, "outside");
	await mkdir(outsideDir);
	const outsideFile = join(outsideDir, "outside.jsonl");
	writeFileSync(outsideFile, '{"type":"session"}\n');
	await utimes(outsideFile, oldDate, oldDate);

	const linkedDir = join(customRoot, "linked");
	symlinkSync(outsideDir, linkedDir, "dir");
	const directLink = join(projectDir, "linked.jsonl");
	symlinkSync(outsideFile, directLink, "file");
	listedSessions = [
		sessionInfo(join(linkedDir, "outside.jsonl")),
		sessionInfo(directLink),
		sessionInfo(outsideFile),
	];
	const symlinkUi = makeUi(async () => true);
	await commandHandler!("7", context(customRoot, undefined, symlinkUi));
	assert(
		"outside paths and direct or parent symlinks are not deletion candidates",
		exists(outsideFile) &&
			symlinkUi.confirms.length === 0 &&
			symlinkUi.notifications.some(({ message }) => message.startsWith("No Pi sessions")),
		JSON.stringify({ confirms: symlinkUi.confirms, notifications: symlinkUi.notifications }),
	);

	listedSessions = [];
	listedWith = undefined;
	const defaultUi = makeUi(async () => false);
	await commandHandler!("7", context(join(defaultRoot, "--project--"), undefined, defaultUi));
	const defaultListArgs = listedWith as unknown[] | undefined;
	assert(
		"default storage lists sessions across projects without a custom root argument",
		defaultListArgs?.length === 0,
		JSON.stringify(listedWith),
	);

	for (const invalid of ["0", "-1", "1.5", "abc"]) {
		listedWith = undefined;
		const invalidUi = makeUi(async () => true);
		await commandHandler!(invalid, context(customRoot, undefined, invalidUi));
		assert(
			`invalid retention '${invalid}' fails before listing`,
			listedWith === undefined &&
				invalidUi.notifications.some(
					({ message, type }) => message.startsWith("Usage:") && type === "error",
				),
			JSON.stringify(invalidUi.notifications),
		);
	}

	listedWith = undefined;
	const noUi = makeUi(async () => true);
	await commandHandler!("7", context(customRoot, undefined, noUi, false));
	assert(
		"noninteractive execution fails closed before listing",
		listedWith === undefined &&
			noUi.confirms.length === 0 &&
			noUi.notifications.some(({ type }) => type === "error"),
		JSON.stringify(noUi.notifications),
	);

	const emptyRoot = join(tempRoot, "empty-root");
	const emptyLeaf = join(emptyRoot, "one", "two");
	await mkdir(emptyLeaf, { recursive: true });
	await cleanEmptyParents(emptyLeaf, emptyRoot);
	assert(
		"empty parent cleanup stops before the session root",
		exists(emptyRoot) && !exists(join(emptyRoot, "one")),
		JSON.stringify({ root: exists(emptyRoot), child: exists(join(emptyRoot, "one")) }),
	);

	const nonemptyLeaf = join(emptyRoot, "kept");
	await mkdir(nonemptyLeaf);
	writeFileSync(join(nonemptyLeaf, "keep.txt"), "keep\n");
	await cleanEmptyParents(nonemptyLeaf, emptyRoot);
	assert("nonempty session directories are preserved", exists(nonemptyLeaf), nonemptyLeaf);

	const missingCandidates = await collectCandidates(
		[sessionInfo(join(customRoot, "missing.jsonl"))],
		customRoot,
		undefined,
		Date.now(),
	);
	assert(
		"missing sessions are ignored during preflight",
		missingCandidates.length === 0,
		String(missingCandidates.length),
	);
} finally {
	(SessionManager as any).listAll = originalListAll;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("All session cleanup tests passed.");
