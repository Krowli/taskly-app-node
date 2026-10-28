#!/usr/bin/env bash
# Verification gate, decision step: runs in gh-aw's threat-detection job and executes no PR or
# agent code. Re-validates the exact patch bytes the agent produced, builds the verdict from the
# measurements of the separate measure job, and exits non-zero unless the agent's work may be
# published (threat detection runs with continue-on-error: false, so that blocks every safe output).
# Env: IN (analysis/, agent/, measurements/), GENERATE_RESULT, MEASURE_RESULT, HEAD_SHA, RUN_URL, PR_NUMBER; optional VERDICT_HINT, REASON.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
m="$IN/measurements"
mkdir -p "$IN/out"

manifest="$IN/analysis/.unit-test-agent/manifest.json"
# The claims and session log are optional: a missing file must not crash validation or the report.
claims=(); [ -f "$IN/agent/agent-output.json" ] && claims=(--agent-output "$IN/agent/agent-output.json")
exec_log=(); [ -f "$IN/agent/execution.jsonl" ] && exec_log=(--execution-file "$IN/agent/execution.jsonl")
usage=(); [ -f "$IN/agent/usage.json" ] && usage=(--usage "$IN/agent/usage.json")

if [ -f "$IN/agent/agent.patch" ]; then
  node "$here/validate-patch.mjs" "$IN/agent/agent.patch" --manifest "$manifest" --original-rev "$HEAD_SHA" \
    "${claims[@]}" --out "$IN/patch-validation.json" || true
  cp "$IN/agent/agent.patch" "$IN/out/agent.patch"
else
  # No patch: the agent changed no tests (it only commented or reported no-op).
  echo '{"valid":true,"files":[],"addedLines":0,"violations":[],"assertionAudit":{"changedExisting":0,"justified":0,"unjustified":[]}}' \
    > "$IN/patch-validation.json"
fi

# An explicit verdict from the caller wins. "Measurement did not finish" only counts for a patch
# that passed validation; a rejected patch was correctly never measured and must show as rejected.
hint=()
if [ "${VERDICT_HINT:-}" = rejected ] || [ "${VERDICT_HINT:-}" = failed ]; then
  hint=(--verdict-hint "$VERDICT_HINT" --reason "${REASON:-$VERDICT_HINT}")
elif [ "$GENERATE_RESULT" != "success" ]; then
  hint=(--verdict-hint failed --reason "The agent job did not finish successfully ($GENERATE_RESULT); see the workflow run.")
elif [ -f "$IN/agent/agent.patch" ] && [ "${MEASURE_RESULT:-}" != "success" ] \
  && node -e 'process.exit(require(process.argv[1]).valid ? 0 : 1)' "$IN/patch-validation.json"; then
  hint=(--verdict-hint failed --reason "Measuring the agent's tests did not finish ($MEASURE_RESULT); see the measure job.")
fi
args=(--manifest "$manifest" "${claims[@]}" "${exec_log[@]}" "${usage[@]}" --run-url "$RUN_URL" --pr "${PR_NUMBER:-}"
      --head-sha "$HEAD_SHA" --out "$IN/out/report.json" --patch-validation "$IN/patch-validation.json")

# A failed or rejected verdict is already decided: read no measurement files at all (they came from a container).
if [ "${#hint[@]}" -eq 0 ] && [ -f "$m/typecheck-backend" ]; then
  stability=(); for f in "$m"/stability/*.json; do [ -f "$f" ] && stability+=(--stability "$f"); done
  args+=(--typecheck-backend "$(cat "$m/typecheck-backend")" --typecheck-frontend "$(cat "$m/typecheck-frontend")"
         --results-backend "$m/results-backend.json" --results-frontend "$m/results-frontend.json"
         "${stability[@]}" --require-assertions "$(cat "$m/require-assertions")" --fails-without-change "$m/fails-without-change.json"
         --coverage-after-root "$m/coverage" --manifest-after "$m/manifest-after.json")
fi

node "$here/build-report.mjs" "${args[@]}" "${hint[@]}" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
verdict=$(node -e 'console.log(require(process.argv[1]).verdict)' "$IN/out/report.json")
echo "verdict=$verdict" >> "${GITHUB_OUTPUT:-/dev/null}"
case "$verdict" in
  ready|no-changes|skipped) echo "Verification gate: $verdict" ;;
  *) echo "::error::Verification gate: $verdict. Nothing from the agent is published; see the step summary."; exit 1 ;;
esac
