# Review-noise cleanup (conditional)

Read this only when cleaning stale feedback. Set the active identity first and filter every operation to that login:

```bash
GH_LOGIN=$(gh api user --jq .login)
```

Only minimize superseded own review summaries; classify them `OUTDATED`. Never delete/minimize another reviewer’s material or an applicable finding. Keep one current outcome signal.

## Own review summaries

```bash
gh api graphql -f owner='<owner>' -f repo='<repo>' -F number=<number> -f query='
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) { pullRequest(number:$number) {
    reviews(first:100) { nodes { id author { login } body url submittedAt isMinimized minimizedReason } }
  } }
}'

gh api graphql -f id='PULL_REQUEST_REVIEW_NODE_ID' -f query='
mutation($id:ID!) { minimizeComment(input:{subjectId:$id, classifier:OUTDATED}) {
  minimizedComment { ... on PullRequestReview { id isMinimized minimizedReason url } }
} }'
```

## Obsolete own inline comments

Delete only comments superseded by code or newer feedback:

```bash
gh api repos/<owner>/<repo>/pulls/<number>/comments \
  --jq '.[] | select(.user.login == "'"$GH_LOGIN"'") | {id,path,line,body,html_url}'
gh api --method DELETE repos/<owner>/<repo>/pulls/comments/<comment-id>
```

Dismiss only a superseded/resolved own blocking review:

```bash
gh api --method PUT repos/<owner>/<repo>/pulls/<number>/reviews/<review-id>/dismissals \
  -f message='Superseded by newer review feedback.'
```

If deletion of a submitted non-pending review is rejected, minimize it with the GraphQL mutation above instead.
