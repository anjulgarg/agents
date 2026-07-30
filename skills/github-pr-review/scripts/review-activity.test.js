#!/usr/bin/env node

import assert from "node:assert/strict";
import { decideReviewActivity } from "./lib/review-activity-core.js";

const ghLogin = "reviewer";
const basePr = {
	number: 1,
	state: "OPEN",
	isDraft: false,
	mergeStateStatus: "CLEAN",
};

function commit(date) {
	return {
		sha: `sha-${date}`,
		commit: {
			committer: { date },
			author: { date },
			message: "change",
		},
		html_url: `https://example.test/${date}`,
	};
}

function comment(id, login, createdAt, body = "comment", extra = {}) {
	return {
		id,
		user: { login },
		created_at: createdAt,
		updated_at: createdAt,
		body,
		html_url: `https://example.test/comments/${id}`,
		...extra,
	};
}

function review(id, login, submittedAt, state = "COMMENTED", body = "review") {
	return {
		id,
		user: { login },
		submitted_at: submittedAt,
		state,
		body,
		html_url: `https://example.test/reviews/${id}`,
	};
}

function decide(overrides = {}) {
	return decideReviewActivity({
		repo: "owner/repo",
		prNumber: 1,
		ghLogin,
		pr: overrides.pr || basePr,
		reviewComments: overrides.reviewComments || [],
		conversationComments: overrides.conversationComments || [],
		reviews: overrides.reviews || [],
		commits: overrides.commits || [],
	});
}

const noPrior = decide({ commits: [commit("2026-01-01T00:00:00Z")] });
assert.equal(noPrior.decision.action, "review");
assert.deepEqual(noPrior.decision.reasons, ["no_prior_activity_by_gh_login"]);

const reviewMarkerNoChanges = decide({
	reviews: [review(1, ghLogin, "2026-01-02T00:00:00Z", "APPROVED")],
	commits: [commit("2026-01-01T00:00:00Z")],
});
assert.equal(reviewMarkerNoChanges.decision.action, "skip");
assert.equal(reviewMarkerNoChanges.decision.lastActivityAt, "2026-01-02T00:00:00Z");

const commitAfterReview = decide({
	reviews: [review(1, ghLogin, "2026-01-01T00:00:00Z")],
	commits: [commit("2026-01-02T00:00:00Z")],
});
assert.equal(commitAfterReview.decision.action, "review");
assert.deepEqual(commitAfterReview.decision.reasons, ["commits_after_last_activity"]);

const replyToInline = decide({
	reviewComments: [
		comment(10, ghLogin, "2026-01-01T00:00:00Z", "please fix"),
		comment(11, "author", "2026-01-02T00:00:00Z", "fixed", { in_reply_to_id: 10 }),
	],
});
assert.equal(replyToInline.decision.action, "review");
assert.deepEqual(replyToInline.decision.reasons, ["reply_to_own_review_comment"]);

const mentionAfterReview = decide({
	reviews: [review(1, ghLogin, "2026-01-01T00:00:00Z")],
	conversationComments: [
		comment(20, "author", "2026-01-02T00:00:00Z", "@reviewer please re-check"),
	],
});
assert.equal(mentionAfterReview.decision.action, "review");
assert.deepEqual(mentionAfterReview.decision.reasons, [
	"conversation_comment_after_last_activity",
	"mention_after_last_activity",
]);

const mentionInReviewBody = decide({
	reviews: [
		review(1, ghLogin, "2026-01-01T00:00:00Z"),
		review(2, "teammate", "2026-01-02T00:00:00Z", "COMMENTED", "@reviewer please look again"),
	],
});
assert.equal(mentionInReviewBody.decision.action, "review");
assert.deepEqual(mentionInReviewBody.decision.reasons, ["mention_after_last_activity"]);

const draftPr = decide({ pr: { ...basePr, isDraft: true } });
assert.equal(draftPr.decision.action, "blocked");
assert.deepEqual(draftPr.decision.hardSkips, ["draft"]);

const behindPr = decide({
	pr: { ...basePr, mergeStateStatus: "BEHIND" },
	conversationComments: [
		comment(30, "author", "2026-01-02T00:00:00Z", "@psglobalgroup/coworker review again"),
	],
	reviews: [review(1, ghLogin, "2026-01-01T00:00:00Z")],
});
assert.equal(behindPr.decision.action, "review");
assert.deepEqual(behindPr.decision.hardSkips, []);
assert.deepEqual(behindPr.decision.warnings, ["behind_base"]);

const botLoginMatchesActivity = decideReviewActivity({
	repo: "owner/repo",
	prNumber: 1,
	ghLogin: "ez-coworker",
	pr: basePr,
	reviewComments: [],
	conversationComments: [
		comment(40, "author", "2026-01-02T00:00:00Z", "@psglobalgroup/coworker please re-check"),
	],
	reviews: [review(1, "ez-coworker[bot]", "2026-01-01T00:00:00Z")],
	commits: [],
});
assert.equal(botLoginMatchesActivity.decision.action, "review");
assert.equal(botLoginMatchesActivity.decision.lastActivityAt, "2026-01-01T00:00:00Z");
assert.ok(botLoginMatchesActivity.decision.reasons.includes("mention_after_last_activity"));

const teamMentionOnly = decide({
	reviews: [review(1, ghLogin, "2026-01-01T00:00:00Z")],
	conversationComments: [
		comment(50, "author", "2026-01-02T00:00:00Z", "@psglobalgroup/coworker review again"),
	],
});
assert.equal(teamMentionOnly.decision.action, "review");
assert.ok(teamMentionOnly.decision.reasons.includes("mention_after_last_activity"));

console.log("review-activity fixture tests passed");
