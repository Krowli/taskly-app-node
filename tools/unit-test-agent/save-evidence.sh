#!/usr/bin/env bash
# Saves one agent run's facts under docs/agent-runs/<date>-<slug>/ so the write-up can link to evidence
# that outlives the 14-day artifact retention. Usage: save-evidence.sh <run-id> <slug>
# A run with a patch: report.json (the gate's report), agent-output.json (claims), usage.json (AI credits), run.md.
# A run without one has no gate report: safe-outputs.json (gh-aw's agent_output.json), usage.json,
# manifest-excerpt.json (the analysis' injection signals and gate), run.md (outcome and the PR comments).
# Run from the repository root with an authenticated gh. The repository is GH_REPO, else the checkout's.
set -euo pipefail
run_id=${1:?usage: save-evidence.sh <run-id> <slug>}
slug=${2:?usage: save-evidence.sh <run-id> <slug>}
[[ "$run_id" =~ ^[0-9]+$ ]] || { echo "run id must be a number" >&2; exit 1; }
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "slug must be lowercase letters, digits and dashes" >&2; exit 1; }
repo=${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "repository must be owner/name" >&2; exit 1; }
dest="docs/agent-runs/$(date +%Y-%m-%d)-$slug"
[ ! -e "$dest" ] || { echo "$dest already exists; not overwriting" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Only artifacts the run still has are downloaded, so a failed download stops the script.
gh api "repos/$repo/actions/runs/$run_id/artifacts" --paginate --jq '.artifacts[] | select(.expired | not) | .name' > "$tmp/artifacts"
fetch() { if grep -qFx "$1" "$tmp/artifacts"; then gh run download "$run_id" -R "$repo" -n "$1" -D "$tmp/$1"; fi; }

# The run's link, PR number (empty for a sweep), head commit and duration, one per line.
gh api "repos/$repo/actions/runs/$run_id" > "$tmp/run.json"
{ read -r url; read -r pr; read -r head; read -r duration; } < <(node -e '
  const run = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  const s = (Date.parse(run.updated_at) - Date.parse(run.created_at)) / 1000
  console.log([run.html_url, run.pull_requests?.[0]?.number ?? "", run.head_sha, `${Math.floor(s / 60)} min ${s % 60} s`].join("\n"))
' "$tmp/run.json")
[[ "$pr" =~ ^[0-9]*$ && "$head" =~ ^[0-9a-f]{40}$ ]] || { echo "unexpected PR number or head SHA from the API" >&2; exit 1; }
if [ -n "$pr" ]; then pr_url="https://github.com/$repo/pull/$pr"; else pr_url='n/a (sweep)'; fi

# Built in the temp dir and moved into place last, so a failed run leaves nothing and a retry works.
out="$tmp/out"
mkdir -p "$out"
# gh-aw's usage artifact (AI credits); optional.
fetch usage
[ -f "$tmp/usage/agent_usage.json" ] && cp "$tmp/usage/agent_usage.json" "$out/usage.json"

fetch unit-test-agent-report
if [ -d "$tmp/unit-test-agent-report" ]; then
  [ -f "$tmp/unit-test-agent-report/report.json" ] || { echo "the artifact has no report.json" >&2; exit 1; }
  cp "$tmp/unit-test-agent-report/report.json" "$out/report.json"
  # No-change runs upload no claims.
  fetch unit-test-agent-claims
  [ -f "$tmp/unit-test-agent-claims/agent-output.json" ] && cp "$tmp/unit-test-agent-claims/agent-output.json" "$out/agent-output.json"
  verdict=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).verdict' "$out/report.json")
  cat > "$out/run.md" <<MD
# Agent run $run_id

- Run: $url
- PR: $pr_url
- Verdict: $verdict
- Duration: $duration
MD
else
  # No patch: what the agent asked to publish, what the analysis saw, and the comments the run left on the PR.
  fetch agent
  [ -f "$tmp/agent/agent_output.json" ] || { echo "no unit-test-agent-report and no agent_output.json in the agent artifact; nothing to save" >&2; exit 1; }
  cp "$tmp/agent/agent_output.json" "$out/safe-outputs.json"
  fetch unit-test-agent-analysis
  if [ -f "$tmp/unit-test-agent-analysis/manifest.json" ]; then
    node -e '
      const { injectionSignals, gate } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      process.stdout.write(`${JSON.stringify({ injectionSignals, gate }, null, 2)}\n`)
    ' "$tmp/unit-test-agent-analysis/manifest.json" > "$out/manifest-excerpt.json"
  fi
  echo '[]' > "$tmp/comments.json"
  [ -z "$pr" ] || gh api "repos/$repo/issues/$pr/comments" --paginate --slurp > "$tmp/comments.json"
  # Outcome (the safe-output types), the agent's comment (gh-aw's marker with this run's id), the workflow's
  # sticky report (its marker; it shows the latest run) and the AI credits, one per line.
  { read -r outcome; read -r agent_comment; read -r report_comment; read -r credits; } < <(node -e '
    const fs = require("fs")
    const [runId, out, commentsFile] = process.argv.slice(1)
    const read = (path) => (fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : undefined)
    const types = [...new Set((read(`${out}/safe-outputs.json`).items ?? []).map((item) => String(item.type)))]
    const bot = read(commentsFile).flat().filter((c) => c.user?.login === "github-actions[bot]" && typeof c.body === "string")
    const agent = bot.filter((c) => new RegExp(`^<!-- gh-aw-agentic-workflow: .*\\bid: ${runId},`, "m").test(c.body)).map((c) => c.html_url)
    const report = bot.find((c) => c.body.startsWith("<!-- unit-test-agent -->"))
    console.log([
      ["no patch", ...types.filter((type) => /^[a-z_-]+$/.test(type))].join("; "),
      agent.join(", ") || "none",
      report ? `${report.html_url}${report.body.includes(`/actions/runs/${runId})`) ? "" : " (now shows a later run)"}` : "none",
      read(`${out}/usage.json`)?.ai_credits ?? "none recorded",
    ].join("\n"))
  ' "$run_id" "$out" "$tmp/comments.json")
  cat > "$out/run.md" <<MD
# Agent run $run_id

- Run: $url
- PR: $pr_url (head \`${head:0:7}\`)
- Outcome: $outcome
- Agent comment: $agent_comment
- Workflow report: $report_comment
- AI credits: $credits
- Duration: $duration

\`safe-outputs.json\` is gh-aw's record of what the agent asked to publish (comment, no-op message). No-patch runs have no gate report.
MD
fi
mkdir -p "$(dirname "$dest")"
mv "$out" "$dest"
echo "Saved $dest"
