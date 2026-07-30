function activityTime(a) {
	return a.created_at || a.submitted_at || "";
}

function commitDate(c) {
	return c.commit?.committer?.date || c.commit?.author?.date || "";
}

function normalizeLogin(login) {
	return String(login || "")
		.toLowerCase()
		.replace(/\[bot\]$/i, "");
}

function isOwnLogin(userLogin, ghLogin) {
	return Boolean(userLogin && ghLogin && normalizeLogin(userLogin) === normalizeLogin(ghLogin));
}

const COWORKER_TEAM_MENTION = /@(?:ez-coworker(?:\[bot\])?|[\w-]+\/coworker)(?![A-Za-z0-9_-])/i;

function bodyMentionsReviewer(body, ghLogin) {
	if (!body) return false;
	const login = String(ghLogin || "");
	if (login && body.includes(`@${login}`)) return true;
	const normalized = normalizeLogin(login);
	if (normalized && body.toLowerCase().includes(`@${normalized}`)) return true;
	return COWORKER_TEAM_MENTION.test(body);
}

function slimOwnActivity(a) {
	if (!a) return null;
	return {
		type: a.submitted_at ? "review" : "comment",
		user: a.user?.login ?? null,
		at: activityTime(a),
		bodyPreview: (a.body || "").slice(0, 240),
	};
}

export function decideReviewActivity({
	repo,
	prNumber,
	ghLogin,
	pr,
	reviewComments = [],
	conversationComments = [],
	reviews = [],
	commits = [],
}) {
	const allComments = [...reviewComments, ...conversationComments];
	const ownComments = allComments.filter(
		(comment) => comment.user && isOwnLogin(comment.user.login, ghLogin),
	);
	const ownReviews = reviews.filter(
		(review) => review.user && isOwnLogin(review.user.login, ghLogin),
	);
	const ownActivity = [...ownComments, ...ownReviews];
	let lastActivityAt = "";
	for (const a of ownActivity) {
		const t = activityTime(a);
		if (t > lastActivityAt) lastActivityAt = t;
	}

	const ownReviewCommentIds = new Set(
		reviewComments
			.filter((comment) => comment.user && isOwnLogin(comment.user.login, ghLogin))
			.map((comment) => comment.id),
	);

	const commitsAfterLastActivity = lastActivityAt
		? commits.filter((c) => commitDate(c) > lastActivityAt)
		: [];

	const repliesToOwnReviewComments = lastActivityAt
		? reviewComments.filter(
				(comment) =>
					comment.user &&
					!isOwnLogin(comment.user.login, ghLogin) &&
					comment.created_at > lastActivityAt &&
					comment.in_reply_to_id &&
					ownReviewCommentIds.has(comment.in_reply_to_id),
			)
		: [];

	const conversationCommentsAfterLastActivity = lastActivityAt
		? conversationComments.filter(
				(comment) =>
					comment.user &&
					!isOwnLogin(comment.user.login, ghLogin) &&
					comment.created_at > lastActivityAt,
			)
		: [];

	const mentionsAfterLastActivity = lastActivityAt
		? [
				...allComments.filter(
					(c) =>
						c.user &&
						!isOwnLogin(c.user.login, ghLogin) &&
						c.created_at > lastActivityAt &&
						bodyMentionsReviewer(c.body, ghLogin),
				),
				...reviews.filter(
					(r) =>
						r.user &&
						!isOwnLogin(r.user.login, ghLogin) &&
						r.submitted_at > lastActivityAt &&
						bodyMentionsReviewer(r.body, ghLogin),
				),
			]
		: [];

	const hardSkips = [];
	if (pr.isDraft) hardSkips.push("draft");
	if (pr.state !== "OPEN") hardSkips.push("not_open");
	if (pr.mergeStateStatus === "DIRTY") hardSkips.push("merge_conflicts");

	const reasons = [];
	if (!lastActivityAt) reasons.push("no_prior_activity_by_gh_login");
	if (commitsAfterLastActivity.length > 0) reasons.push("commits_after_last_activity");
	if (repliesToOwnReviewComments.length > 0) reasons.push("reply_to_own_review_comment");
	if (conversationCommentsAfterLastActivity.length > 0)
		reasons.push("conversation_comment_after_last_activity");
	if (mentionsAfterLastActivity.length > 0) reasons.push("mention_after_last_activity");

	let latestOwnActivity = null;
	for (const a of ownActivity) {
		if (!latestOwnActivity || activityTime(a) > activityTime(latestOwnActivity)) {
			latestOwnActivity = a;
		}
	}

	return {
		repo,
		prNumber: Number(prNumber),
		ghLogin,
		decision: {
			shouldReview: hardSkips.length === 0 && reasons.length > 0,
			action: hardSkips.length ? "blocked" : reasons.length ? "review" : "skip",
			reasons,
			hardSkips,
			lastActivityAt,
			warnings: pr.mergeStateStatus === "BEHIND" ? ["behind_base"] : [],
		},
		metadata: {
			activityByGhLogin: slimOwnActivity(latestOwnActivity),
			newSinceLastLook: {
				commits: commitsAfterLastActivity.length,
				repliesToOwnReviewComments: repliesToOwnReviewComments.length,
				conversationComments: conversationCommentsAfterLastActivity.length,
				mentions: mentionsAfterLastActivity.length,
			},
		},
	};
}
