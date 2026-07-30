---
name: poker-planning
description: Audit unestimated Jira Ready for Grooming Story/Task/Bug items with acli for planning-poker readiness. Produce a read-only markdown report; write only when explicitly requested.
---

# Poker Planning Prep

## Gates

- Run `acli jira auth status` first and capture `Site:` as `jiraSite`; if unauthenticated,
  stop and request `acli jira auth login --web`.
- Default scope: unestimated `Story, Task, Bug` in `Ready for Grooming`. Ask only for a
  missing project key. Confirm any different queue/status; list projects only when needed.
- Use Jira data only. Never infer from repositories. Never write or assign points without an
  explicit request naming the exact action and `KEY`.

## Fetch

```bash
acli jira workitem search \
  --jql 'project = "PROJ" AND issuetype in (Story, Task, Bug) AND status = "Ready for Grooming" AND ("Story Points" is EMPTY OR "Story Points" = 0) ORDER BY priority DESC, updated ASC' \
  --fields "key,summary,status,issuetype,priority,assignee,created,updated,labels,components" \
  --paginate --json
```

Zero matches is valid. Only an explicit unknown estimate-field error triggers fallback: search
the same queue without that clause, inspect one issue, confirm the field if unclear, then rerun
(for example, `"Story point estimate" is EMPTY OR "Story point estimate" = 0`).

Review the first 15 sorted matches unless the user requested `all`; report `reviewed R of T`.
For each selected key run `acli jira workitem view KEY --json`. Fetch
`parent,issuelinks,subtasks` only when text suggests dependencies, blocking, hierarchy,
another team/system/item, or epic-scale scope.

Capture search/view JSON in temporary files and inspect only required fields locally; never
paste raw Jira payloads into model context or the report. Delete temporary data afterward.

Preserve ADF paragraphs, lists, tables, and hard breaks. Acceptance-criteria precedence:
dedicated field, named `Acceptance Criteria`/`AC`/`Given When Then` section, then missing.
Present-but-unreadable ADF is `Parse failure`; absent data is `Missing AC`/`Thin description`.

## Classify in order

First match is the primary table; put other gaps in `Flags`. A key appears once.

1. **Needs refinement — defer:** `Defer: dependency` (external/team/API/vendor/environment/
   approval blocker), `Defer: non-poker work` (ops/compliance/admin without engineering
   deliverable), or `Defer: wrong queue`.
2. **Needs refinement:** `Parse failure`; `Missing AC`; `Placeholder AC` (`TBD`, `TODO`, empty,
   or one vague bullet); `Thin description` (empty, under 80 meaningful characters, or generic);
   `Scope mismatch`; `Untestable AC`; `Ambiguous scope` (actor/surface/outcome/boundary/
   dependency unclear); or `Epic-scale` (multiple systems/surfaces/roles, migration, or
   all-platform scope without split guidance).
3. **Needs assignee** when otherwise ready but unassigned.
4. **Ready** only with clear actor/surface/outcome, consistent summary/description/AC, testable
   AC, no blocking dependency, reasonable size, and assignee.

Always flag `Unassigned`; display it as `—`. Gap evidence: at most one quote, 12 words. Notes
only for refinement/defer: at most two bullets and two questions per key.

## Report

Return markdown only. Omit empty tables; keep Summary. Counts must total `R`; unassigned counts
reviewed items only.

```markdown
# Poker Planning Prep — {Project} — {Date}

**Scope:** `Ready for Grooming`, unestimated Story/Task/Bug
**Jira:** https://{jiraSite}

## Summary

- reviewed {R} of {T}; {N} ready; {N} refinement; {N} need assignee; {N} unassigned

## Ready for grooming

| Key | Summary | Assignee | Priority | Flags |
| --- | ------- | -------- | -------- | ----- |

## Needs refinement before grooming

| Key | Summary | Assignee | Gap | Flags |
| --- | ------- | -------- | --- | ----- |

## Needs assignee before grooming

| Key | Summary | Priority | Flags |
| --- | ------- | -------- | ----- |

## Review notes

### {KEY} — {summary}

- **Gap:** {fixed label and optional quote}
- **Questions:** {1–2 questions}

## Suggested meeting order

1. Refine and assign. 2. Defer blocked/wrong-queue/non-poker work.
2. Groom ready items. 4. Re-run after updates.
```

For zero matches, return only the title and: `No matching unestimated Ready for Grooming
Story/Task/Bug items found.`

For an explicitly requested write with incomplete text, draft it and ask confirmation before
calling the relevant `acli jira workitem` write command.
