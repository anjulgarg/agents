# Git-first review scope

Use Git for repository state, fetching, pinning, diffing, and worktrees. Provider APIs are metadata fallbacks, not the review engine.

## Resolve

1. Confirm the repository and preserve user state:

```bash
git rev-parse --show-toplevel
git status --porcelain=v1
git remote -v
```

2. Resolve explicit base and head refs without assuming a default branch. For a local change, use the user-supplied commits or branch. For a provider PR, read only the matching provider reference when Git cannot identify both refs safely.
3. Fetch without pulling or changing the current branch:

```bash
git fetch --no-tags <remote> <base-ref> <head-ref>
BASE="$(git rev-parse <base-ref-or-sha>^{commit})"
HEAD="$(git rev-parse <head-ref-or-sha>^{commit})"
MERGE_BASE="$(git merge-base "$BASE" "$HEAD")"
```

4. Record all three SHAs. Review only the merge-base change:

```bash
git diff --name-status "$BASE...$HEAD"
git diff --check "$BASE...$HEAD"
git diff "$BASE...$HEAD" -- <targeted-paths>
```

Never use `BASE..HEAD` for PR scope.

## Checkout

Use an existing clean checkout only when it is already at `HEAD`. Otherwise create a persistent detached worktree at the pinned head. Never switch, pull, reset, clean, or modify the user's branch.

## Revalidate

Before synthesis, query the source ref again with `git ls-remote` when the exact remote ref is known. If provider metadata was needed initially, re-read that metadata. Stop when the remote source SHA differs from pinned `HEAD`. Confirm the review worktree remains clean.

GitHub and Azure DevOps metadata procedures live under `providers/`. Other Git providers work without a dedicated adapter when the user supplies resolvable base and head refs or SHAs.
