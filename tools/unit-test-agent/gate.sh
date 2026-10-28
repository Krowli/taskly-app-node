#!/usr/bin/env bash
# Verification gate, run by the detection job from the BASE commit's copy of this folder.
# Order matters: nothing from the agent runs before its patch is validated, and `npm ci`
# never runs on agent-changed files. Every exit goes through judge.sh, so the report is always written.
# Containers never see GATE_DIR: the runner runs git there later (checkout post-step), so each container
# gets a throwaway copy, and the host never runs git or node in a copy after a container used it.
# Env: BASE_SHA, HEAD_SHA, HEAD_REF (the PR branch), GATE_DIR (clean checkout of HEAD_SHA, full history),
#      IN (work dir), NODE_IMAGE (digest-pinned), AGENT_RESULT, RUN_URL, PR_NUMBER;
#      optional AGENT_ARTIFACTS_DIR, MODE (pr, the default, or coverage: a sweep that opens a new PR, so no HEAD_REF), WORK_A and WORK_B (the throwaway copies).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)  # physical path, so validate-patch's entry check cannot silently skip
unset VERDICT_HINT REASON
# The gate runs untrusted PR code on the host (npm ci), so it must hold no secrets: drop the OTLP ones gh-aw exports.
unset OTEL_EXPORTER_OTLP_HEADERS OTEL_EXPORTER_OTLP_ENDPOINT GH_AW_OTLP_ENDPOINTS
: "${BASE_SHA:?}" "${HEAD_SHA:?}" "${GATE_DIR:?}" "${IN:?}" "${NODE_IMAGE:?}" "${AGENT_RESULT:?}"
MODE="${MODE:-pr}"
artifacts="${AGENT_ARTIFACTS_DIR:-/tmp/gh-aw}"
work_a="${WORK_A:-${RUNNER_TEMP:-/tmp}/gate-baseline}"
work_b="${WORK_B:-${RUNNER_TEMP:-/tmp}/gate-measure}"
mkdir -p "$IN/agent" "$IN/analysis/.unit-test-agent" "$IN/measurements"
trap 'rm -rf "$work_a" "$work_b"' EXIT  # rm does not follow links the tests may have left
[ "$MODE" = pr ] && : "${HEAD_REF:?}"
decide() { GENERATE_RESULT="$AGENT_RESULT" MEASURE_RESULT="$1" bash "$here/judge.sh"; exit $?; }
# Before a patch exists judge.sh cannot see a failure, so say it explicitly or the gate would read as no-changes.
fail() { VERDICT_HINT=failed REASON="$1" decide failure; }
reject() { VERDICT_HINT=rejected REASON="$1" decide skipped; }
# Agent-run facts for the report (session log, AI credits). Optional and untrusted: only a regular,
# non-link file under a size cap is copied, and a missing one never fails the gate.
copy_fact() {  # <source name> <destination> <max bytes>
  local src="$artifacts/$1" why=copied
  if [ -L "$src" ]; then why=link
  elif [ ! -f "$src" ]; then why=missing
  elif [ "$(wc -c < "$src")" -gt "$3" ]; then why="too large"
  else cp "$src" "$IN/agent/$2" || why="copy failed"
  fi
  facts+=("$1: $why")
}
facts=()
copy_fact agent-session.jsonl execution.jsonl 5242880
copy_fact agent_usage.json usage.json 65536
echo "gate: agent facts — $(IFS=';'; echo "${facts[*]}" | sed 's/;/; /g')"
cd "$GATE_DIR" || fail "cannot enter the gate checkout"

# Validation needs a manifest of the clean PR head; never reuse a file the agent job wrote.
# A sweep has no PR diff: the trusted minimal manifest only makes validate-patch forbid edits of existing tests.
manifest="$IN/analysis/.unit-test-agent/manifest.json"
case "$MODE" in
  pr) node "$here/change-manifest.mjs" --mode pr --base "$BASE_SHA" --head "$HEAD_SHA" --out "$manifest" || fail "change manifest failed" ;;
  coverage) node -e 'process.stdout.write(JSON.stringify({ version: 1, mode: "coverage", base: null, head: null, headIsAgentCommit: false, gate: { runAgent: true, reason: "coverage sweep" }, files: [], literalHits: [], contractFilesChanged: [], failingTests: [], coverageBefore: {} }))' > "$manifest" || fail "coverage manifest failed" ;;
  *) fail "unknown MODE $MODE" ;;
esac

# The agent's commit, from the one bundle gh-aw publishes (its default transport); its one ref must be the PR branch (coverage: any branch, gh-aw adds a random suffix).
patch="$IN/agent/agent.patch"
mapfile -t bundles < <(find "$artifacts" -maxdepth 1 -name 'aw-*.bundle' 2>/dev/null)
# The gate only runs when gh-aw reports a patch, so finding none is a failure, not "no changes".
[ "${#bundles[@]}" -gt 0 ] || fail "no agent bundle found although the agent produced a patch"
[ "${#bundles[@]}" -eq 1 ] || reject "more than one agent bundle"
git bundle verify "${bundles[0]}" >/dev/null 2>&1 || fail "agent bundle failed verification"
mapfile -t refs < <(git bundle list-heads "${bundles[0]}" | cut -d' ' -f2)
[ "${#refs[@]}" -eq 1 ] || reject "agent bundle must carry exactly one ref"
if [ "$MODE" = coverage ]; then
  [[ "${refs[0]}" == refs/heads/* ]] || reject "agent bundle ref is not a branch"
else
  [ "${refs[0]}" = "refs/heads/$HEAD_REF" ] || reject "agent bundle ref does not match the PR branch"
fi
git fetch --quiet "${bundles[0]}" "+${refs[0]}:refs/agent/head" || fail "fetching the agent bundle failed"
agent_head=$(git rev-parse refs/agent/head)
git merge-base --is-ancestor "$HEAD_SHA" "$agent_head" || reject "agent commits do not build on the PR head"
[ "$(git rev-list --count "$HEAD_SHA..$agent_head")" -eq 1 ] || reject "the agent must make exactly one commit"
git diff --binary "$HEAD_SHA" "$agent_head" > "$patch" || fail "git diff of the agent commit failed"
[ -s "$patch" ] || { rm -f "$patch"; decide skipped; }  # no patch: judge reports no-changes

# Validate before anything runs. Without claims, any edit to an existing test is unjustified (fails closed).
# Existing files are read from HEAD_SHA, so the check sees what the agent's lines were added into.
claims=(); [ -f "$IN/agent/agent-output.json" ] && claims=(--agent-output "$IN/agent/agent-output.json")
node "$here/validate-patch.mjs" "$patch" --manifest "$manifest" --original-rev "$HEAD_SHA" \
  "${claims[@]}" --out "$IN/patch-validation.json" || decide skipped
# Enforce the result file too, not only the exit code.
node -e 'process.exit(require(process.argv[1]).valid ? 0 : 1)' "$IN/patch-validation.json" || decide skipped

# Install needs the network, so it runs outside the container; lifecycle scripts off.
# At this point the tree is still the clean PR head.
npm ci --ignore-scripts --prefix backend && npm ci --ignore-scripts --prefix frontend \
  && npm run db:generate --prefix backend || decide failure

# The sandbox: no network, the runner's user, a throwaway copy of the tree, read-only tooling and
# analysis, and pid, memory and time limits (--init so the timeout's signal ends the container).
# 4 minutes per run: baseline + measure must fit well inside gh-aw's 10-minute detection job, so judge.sh still writes a report.
run_offline() {  # <work copy> [baseline]
  local work=$1; shift
  rm -rf "$work" && cp -a "$GATE_DIR" "$work" || fail "copying the checkout for the container failed"
  echo "gate: docker run --network=none $NODE_IMAGE bash /t/measure.sh $*"
  timeout 4m docker run --rm --init --network=none --pids-limit 512 --memory 6g --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$work:/w" -v "$here:/t:ro" -v "$IN/analysis:/in/analysis:ro" -v "$IN/measurements:/in/measurements" -w /w \
    -e IN=/in -e OUT=/in/measurements -e MODE="$MODE" -e BASE="$BASE_SHA" -e HEAD_SHA="$HEAD_SHA" \
    "$NODE_IMAGE" bash /t/measure.sh "$@"
  local status=$?
  # The host reads measurements/ next (judge.sh), so it may hold only plain files and directories,
  # 200 MB at most; anything else is discarded unread.
  # The container may have made it unreadable or unremovable (chmod 555); restore the owner's rights first.
  chmod -R u+rwX "$IN/measurements" 2>/dev/null || true
  local odd
  odd=$(find "$IN/measurements" ! -type f ! -type d) && [ -z "$odd" ] \
    || { rm -rf "$IN/measurements"; fail "measurements contain links or special files"; }
  [ "$(du -sk --apparent-size "$IN/measurements" | cut -f1)" -le 204800 ] \
    || { rm -rf "$IN/measurements"; fail "measurements are larger than 200 MB"; }
  return "$status"
}

# Copies one file change-manifest reads from copy A into GATE_DIR (the cwd), only if it is a regular
# file reached through no link (its real path is its plain path) and 20 MB at most.
copy_back() {
  local src="$work_a/$1"
  [ -f "$src" ] && [ "$(realpath "$src")" = "$(realpath "$work_a")/$1" ] && [ "$(wc -c < "$src")" -le 20971520 ] \
    && mkdir -p "$(dirname "$1")" && [[ "$(realpath "$(dirname "$1")")/" == "$(realpath "$GATE_DIR")/"* ]] \
    && rm -f "$1" && cp "$src" "$1"  # rm first: a destination link committed in the PR head must not be written through
}

# Baseline on the clean head makes "coverage before -> after" real. The manifest is recomputed
# with results and coverage (same files as the validation one) over the validation one.
run_offline "$work_a" baseline || decide failure
for app in backend frontend; do
  copy_back ".unit-test-agent/results-$app.json" || fail "baseline results for $app are missing, a link or over 20 MB"
  for f in coverage-final coverage-summary; do
    copy_back "$app/coverage/$f.json" || echo "gate: no usable $app/coverage/$f.json from the baseline; its coverage stays unknown"
  done
done
rm -rf "$work_a"
if [ "$MODE" = pr ]; then
  node "$here/change-manifest.mjs" --mode pr --base "$BASE_SHA" --head "$HEAD_SHA" --require-results --out "$manifest" || decide failure
else  # sweep: same baseline facts, but the manifest stays mode coverage
  node "$here/change-manifest.mjs" --baseline-into --out "$manifest" || decide failure
fi

git apply --index "$patch" || decide failure
run_offline "$work_b" && decide success || decide failure
