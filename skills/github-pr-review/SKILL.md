---
name: github-pr-review
description: Use when reviewing, sweeping, commenting on, or merging GitHub pull requests with gh CLI.
---

# GitHub Pull Request Review

Use `gh` for review, open-PR sweeps, comments, approval, change requests, status checks, and merges. The caller supplies the repository: never assume owner, repository, default branch, clone path, reviewer identity, or policy.

This skill owns GitHub mechanics only. It does not run deep/specialist code analysis. When the caller provides analysis findings, post them; otherwise post only what a quick local read supports under caller policy.

## Script-first discovery

Resolve `scripts/...` relative to this `SKILL.md`, not the current directory. Run the bundled scripts before manual discovery; they emit JSON decisions, reasons, raw metadata, and fallback `gh` commands:

```bash
node scripts/review-candidates.js --repo <owner/name> [--limit <n>]
node scripts/review-activity.js --repo <owner/name> --pr <number>
node scripts/pre-review-check.js --repo <owner/name> --pr <number> [--clone <path>] [--raw]
```

`--repo` is required for all; `--pr` for the latter two. Use `--clone` only to enrich fallback checkout commands. Default output is compact; use `--raw` only for a specific debugging need.

## Sweep policy

Every non-draft open PR is a candidate, regardless of requested reviewers, author, or mentions. Hard-stop draft, closed, merged, stale, and conflicted PRs. A branch behind its base is a warning, not a blocker: review its actual head/base diff and note that later base changes may require re-review. For stale/conflicted PRs, ask the author to update and stop.

For re-review, GitHub activity is authoritative. The marker is the latest PR conversation comment, inline review comment, or review verdict by the active `gh` user (treat `name` and `name[bot]` as the same actor). Review again only when commits, non-self replies/comments, or non-self mentions of the reviewer/`@*/coworker` team occur after that marker. With no prior marker, review. A branch behind its base is a warning, not a re-review hard-skip.

## Single-PR preflight

Fetch metadata first. Before any local diff, use a local clone, fetch the actual base named by `baseRefName`, and never assume `main`:

```bash
gh pr view <number> --repo <owner>/<repo> \
  --json number,title,headRefName,headRefOid,baseRefName,mergeStateStatus,isDraft,state,url,author
BASE=$(gh pr view <number> --repo <owner>/<repo> --json baseRefName --jq '.baseRefName')
git fetch origin "$BASE"
gh pr checkout <number> --branch pr/<number>
git diff "origin/$BASE...HEAD"
```

Use `decision.hardSkips` from `pre-review-check.js` first. Its fallback is: if `mergeStateStatus` is `DIRTY`, comment asking `AUTHOR` to merge/rebase onto `BASE`, then stop—do not review or post findings. If it is `BEHIND`, continue against the displayed head/base and disclose that limitation.

```bash
STATE=$(gh pr view <number> --repo <owner>/<repo> --json mergeStateStatus --jq '.mergeStateStatus')
if [[ "$STATE" == DIRTY ]]; then
  BASE=$(gh pr view <number> --repo <owner>/<repo> --json baseRefName --jq '.baseRefName')
  AUTHOR=$(gh pr view <number> --repo <owner>/<repo> --json author --jq '.author.login')
  gh pr comment <number> --repo <owner>/<repo> --body-file - <<EOF
@$AUTHOR this pull request needs to be updated against $BASE before I can review it.
Please merge or rebase onto the latest $BASE, then request review again.
EOF
  # Stop here.
fi
```

After a successful preflight, surface for the caller: owner/repo, PR number, base ref, head SHA, checkout path, diff/patch, and a short summary of existing review feedback (for dedupe). Do not assume the caller’s analysis skill.

## Review depth

Run `pre-review-check.js` and report `decision.suggestedDepth` to the caller:

- `quick`: very small, obvious, low-risk changes only
- `deep`: sensitive, larger, or non-obvious changes

Never classify from size alone. If uncertain, report `deep`. Depth is a **signal**; the caller decides whether to run an analysis skill. This skill never invokes or names an analysis skill.

## Noise minimization

Before new feedback, clean only stale noise authored by `GH_LOGIN=$(gh api user --jq .login)`. Never touch another reviewer’s comments, reviews, or still-applicable findings. Prefer minimizing superseded own review summaries as `OUTDATED`; delete obsolete own inline comments; dismiss superseded own `CHANGES_REQUESTED` reviews. Keep one current outcome signal. If GitHub rejects deletion of a submitted non-pending review, minimize it via GraphQL.

Read [`references/noise-cleanup.md`](references/noise-cleanup.md) before cleanup; it contains the safe queries and mutations.

## Posting feedback

Post when the caller asks to publish. Prefer caller-supplied analysis handoff findings. Expected handoff fields per finding:

```text
title | path:line | rationale | resolution or suggestion | severity?
```

Map handoff → inline/summary comments. Do not invent deep findings during posting. Dedupe against existing PR feedback from preflight.

Post actionable findings inline when possible. Use a PR-level review summary only for an outcome (approve/request-changes/comment-only), cross-cutting non-inlineable findings, verification, or residual risk. Use the individual PR comment API with `line` and `side` (not diff `position`); for ranges set exact `start_line`, `start_side`, `line`, and `side`.

Every finding needs a rationale and file/line proof. Prefer a GitHub `suggestion` for a concrete line-local fix; use **Resolution** only for cross-file, architectural, or author-choice fixes. Before suggesting, reread the exact current lines on the checked-out PR branch. The replacement must match the commented range line-for-line, be valid code, and never span non-contiguous lines; use a longer outer fence (or tildes) when replacement text contains backticks.

Read [`references/posting-feedback.md`](references/posting-feedback.md) before posting; it contains API examples and exact suggestion/fence checks.

## Verdict and write gates

Follow the caller’s policy. Under comment-only, never approve or request changes—leave comments only. Without that restriction, use normal GitHub verdicts when appropriate. Analysis severity from a handoff is not a GitHub verdict; only caller policy chooses `approve` / `request-changes` / `comment`. Never merge unless the caller explicitly requests merge behavior. A comment-only sweep with no findings must still leave a concise PR-level marker from the active `gh` user so future sweeps have activity.

## Verification

After inline comments, verify placement with:

```bash
gh api repos/<owner>/<repo>/pulls/<number>/comments
```

If a comment is on the wrong line, delete and repost it. Use `gh pr review ... --approve`, `--request-changes`, or `--comment` for verdicts/summaries; use `gh pr comment` for operational notes such as a rebase request. Merge only after explicit authorization.
