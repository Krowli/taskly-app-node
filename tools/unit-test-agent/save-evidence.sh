#!/usr/bin/env bash
# Saves one agent run's facts under docs/agent-runs/<date>-<slug>/ so the write-up can link to evidence
# that outlives the 14-day artifact retention (report, claims, AI-credit usage). Usage: save-evidence.sh <run-id> <slug>
# Run from the repository root with an authenticated gh.
set -euo pipefail
run_id=${1:?usage: save-evidence.sh <run-id> <slug>}
slug=${2:?usage: save-evidence.sh <run-id> <slug>}
[[ "$run_id" =~ ^[0-9]+$ ]] || { echo "run id must be a number" >&2; exit 1; }
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "slug must be lowercase letters, digits and dashes" >&2; exit 1; }
repo=Krowli/taskly-app-node
dest="docs/agent-runs/$(date +%Y-%m-%d)-$slug"
[ ! -e "$dest" ] || { echo "$dest already exists; not overwriting" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gh run download "$run_id" -R "$repo" -n unit-test-agent-report -D "$tmp/report"
# No-change runs upload no claims.
gh run download "$run_id" -R "$repo" -n unit-test-agent-claims -D "$tmp/claims" 2>/dev/null || true
# gh-aw's usage artifact (AI credits); optional.
gh run download "$run_id" -R "$repo" -n usage -D "$tmp/usage" 2>/dev/null || true
[ -f "$tmp/report/report.json" ] || { echo "the artifact has no report.json" >&2; exit 1; }

# Built in the temp dir and moved into place last, so a failed run leaves nothing and a retry works.
out="$tmp/out"
mkdir -p "$out"
cp "$tmp/report/report.json" "$out/report.json"
[ -f "$tmp/claims/agent-output.json" ] && cp "$tmp/claims/agent-output.json" "$out/agent-output.json"
[ -f "$tmp/usage/agent_usage.json" ] && cp "$tmp/usage/agent_usage.json" "$out/usage.json"

url=$(gh run view "$run_id" -R "$repo" --json url --jq .url)
pr=$(gh api "repos/$repo/actions/runs/$run_id" --jq '.pull_requests[0].number // empty')
if [ -n "$pr" ]; then pr_url="https://github.com/$repo/pull/$pr"; else pr_url='n/a (sweep)'; fi
verdict=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).verdict' "$out/report.json")
duration=$(gh run view "$run_id" -R "$repo" --json createdAt,updatedAt \
  --jq '((.updatedAt | fromdate) - (.createdAt | fromdate)) as $s | "\($s / 60 | floor) min \($s % 60) s"')

cat > "$out/run.md" <<MD
# Agent run $run_id

- Run: $url
- PR: $pr_url
- Verdict: $verdict
- Duration: $duration
MD
mkdir -p "$(dirname "$dest")"
mv "$out" "$dest"
echo "Saved $dest"
