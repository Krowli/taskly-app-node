#!/usr/bin/env bash
# report workflow: renders the sticky PR comment from the gate's report artifact. Runs from the default
# branch and reads GitHub only through the API; it never touches PR code.
# Env: IN (downloaded artifact, holds report.json), RUN_URL, RUN_ID, PR_NUMBER, GH_TOKEN, GITHUB_REPOSITORY.
# Optional: DETECTION (downloaded threat-scan artifact, holds detection_result.json);
#   ANALYSIS and AGENT_ARTIFACTS (a run without a patch: the downloaded analysis artifact, holds manifest.json, and agent artifacts, hold agent_output.json);
#   FIRST_RUN and FIRST_REPORT (a second pass on the same PR: the first run's id and its downloaded report artifact).
# Outputs: post (true when comment.md was written), gaps (coverage still below 100% after the agent, empty if none).
set -euo pipefail
# The link in the comment must come from the event, never fall back to the artifact's.
: "${RUN_URL:?RUN_URL is required}"
here=$(cd "$(dirname "$0")" && pwd)

# Runs without a patch have no report. If the model ran, the comment shows the analysis' injection signals and the
# agent's no-op message; render-comment.mjs writes nothing when the model never started or an input is missing or malformed.
if [ ! -f "$IN/report.json" ]; then
  mkdir -p "$IN"
  if [ -n "${ANALYSIS:-}" ] && [ -n "${AGENT_ARTIFACTS:-}" ] && node "$here/render-comment.mjs" --manifest "$ANALYSIS/manifest.json" \
    --agent-output "$AGENT_ARTIFACTS/agent_output.json" --run-url "$RUN_URL" --out "$IN/comment.md"; then
    cat "$IN/comment.md" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    echo "post=true" >> "${GITHUB_OUTPUT:-/dev/null}"
  else
    echo "post=false" >> "${GITHUB_OUTPUT:-/dev/null}"
    echo "No report.json and no comment for a run without a patch; nothing to post." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  fi
  exit 0
fi

[[ "$PR_NUMBER" =~ ^[0-9]+$ && "$RUN_ID" =~ ^[0-9]+$ ]] || { echo "PR_NUMBER and RUN_ID must be integers" >&2; exit 1; }
[[ "${FIRST_RUN:-}" =~ ^[0-9]*$ ]] || { echo "FIRST_RUN must be an integer" >&2; exit 1; }

# What gh-aw's safe_outputs job did decides whether "ready" means "pushed".
publish=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/jobs" --paginate \
  --jq '.jobs[] | select(.name == "safe_outputs") | .conclusion' | head -n1 || true)

# The PR head counts as the agent's commit only if its message carries this run's trailer.
# A head that cannot be read is "unknown", not "superseded": that would be a claim we cannot back.
sha=""; superseded=false; status=known
head_sha=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq .head.sha) || head_sha=""
message=""
if [ -n "$head_sha" ]; then message=$(gh api "repos/$GITHUB_REPOSITORY/commits/$head_sha" --jq .commit.message) || message=""; fi
if [ -z "$message" ]; then
  status=unknown
elif grep -qFx "Unit-Test-Agent-Run: $RUN_ID" <<< "$message"; then
  sha=${head_sha:0:7}
elif [ "$publish" = success ]; then
  # Published, but the PR head is no longer the agent's commit: a newer push came in, its run reports.
  superseded=true
fi

# Flags the AI threat scan set (known names only); empty when the artifact is missing or unreadable.
threat=""
if [ -n "${DETECTION:-}" ] && [ -f "$DETECTION/detection_result.json" ]; then
  threat=$(node --input-type=module -e "import { readFileSync } from 'node:fs'; import { threatFlagsFrom } from '$here/render-comment.mjs'; process.stdout.write(threatFlagsFrom(readFileSync(process.argv[1], 'utf8')).join(','))" "$DETECTION/detection_result.json" || true)
fi

# A second pass: coverage before comes from the first pass's report, so the comment shows the result from the original code.
first=()
if [ -n "${FIRST_RUN:-}" ]; then
  if [ -f "${FIRST_REPORT:-}/report.json" ]; then first=(--first-report "$FIRST_REPORT/report.json" --first-run-url "${RUN_URL%/*}/$FIRST_RUN")
  else echo "No report from the first run $FIRST_RUN; the comment shows this pass alone."
  fi
fi

node "$here/render-comment.mjs" "$IN/report.json" --publish-result "$publish" --commit-sha "$sha" --superseded "$superseded" --publish-status "$status" --threat-flags "$threat" --run-url "$RUN_URL" ${first[@]+"${first[@]}"} --out "$IN/comment.md"
gaps=$(node --input-type=module -e "import { readFileSync } from 'node:fs'; import { coverageGaps } from '$here/render-comment.mjs'; process.stdout.write(coverageGaps(JSON.parse(readFileSync(process.argv[1], 'utf8'))).join('; '))" "$IN/report.json")
echo "Coverage gaps after the agent: ${gaps:-none}"
cat "$IN/comment.md" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
printf 'post=true\ngaps=%s\n' "$gaps" >> "${GITHUB_OUTPUT:-/dev/null}"
