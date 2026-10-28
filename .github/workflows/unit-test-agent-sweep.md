---
name: Unit test agent (sweep)
description: Started by hand (gh aw run unit-test-agent-sweep), writes unit tests for every existing file with uncovered code in both apps and opens one pull request with them.
on:
  workflow_dispatch:
    # Empty for a new sweep (`gh aw run unit-test-agent-sweep`). The first pass sets all four to run a second pass on the PR it opened.
    inputs:
      pr:
        description: "Second pass: the sweep's pull request number"
        required: false
        type: string
      head_sha:
        description: "Second pass: that pull request's head commit"
        required: false
        type: string
      head_ref:
        description: "Second pass: that pull request's branch"
        required: false
        type: string
      first_run:
        description: "Second pass: the run id of the first pass"
        required: false
        type: string
permissions:
  actions: read # a second pass reads the first pass's artifacts
  contents: read
  pull-requests: read
runs-on: ubuntu-24.04 # pinned: ubuntu-latest is moving to Ubuntu 26
engine:
  id: copilot
  agent: unit-test-agent
  model: claude-sonnet-5.5
  fallback-models: [claude-sonnet-5]
# One run covers every file with uncovered code in both apps, so it needs many more model requests
# than a PR run; spend stays capped by max-ai-credits.
max-turns: 600
max-ai-credits: 300
max-daily-ai-credits: 3000
timeout-minutes: 90
concurrency:
  # A second pass has its own group, so it starts once dispatched and a new sweep's pending run cannot replace it.
  group: unit-test-agent-sweep-${{ github.event.inputs.pr || 'new' }}
  job-discriminator: ${{ github.run_id }} # gh-aw's own conclusion job gets a slot per dispatch
  cancel-in-progress: false # queue instead: never kill a run mid-publish; GitHub keeps only the newest pending run
checkout:
  fetch-depth: 0
network:
  allowed:
    - defaults
    - node
tools:
  edit:
  bash:
    # Copilot names a shell command by its first word, so the script is run as an executable:
    # this allows exactly this file, not node in general. It lives in tools/ because
    # .github/ is restored from the base branch without the executable bit.
    - "./.unit-test-agent/bin/run-tests.mjs:*"
    # Lets the agent discard a test it could not make pass; pushes are still limited to test paths.
    - "rm:*"
jobs:
  # Posts the gate's measured report on the PR that safe_outputs just created, or on the PR a second pass
  # pushed to (nothing else comments here). After the first pass, starts the second if coverage still has gaps.
  sweep_report:
    needs: [safe_outputs]
    if: needs.safe_outputs.outputs.created_pr_number != '' || github.event.inputs.pr != ''
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      actions: write # dispatches the second pass
      contents: read
      pull-requests: write
    steps:
      # The dispatched commit, only the renderer's folder, no stored token.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.sha }}
          sparse-checkout: tools/unit-test-agent
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      # No patch means no artifact; the PR body is then all there is.
      - id: download
        continue-on-error: true
        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: unit-test-agent-report
          path: ${{ runner.temp }}/report
      # A second pass shows coverage from the original code: "before" comes from the first pass's report.
      - name: Download the first pass's report
        if: steps.download.outcome == 'success' && github.event.inputs.first_run != ''
        continue-on-error: true # without it, the comment shows this pass alone
        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: unit-test-agent-report
          path: ${{ runner.temp }}/first-report
          run-id: ${{ github.event.inputs.first_run }}
          github-token: ${{ github.token }}
      - id: render
        if: steps.download.outcome == 'success'
        env:
          IN: ${{ runner.temp }}/report
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          RUN_ID: ${{ github.run_id }}
          PR_NUMBER: ${{ github.event.inputs.pr || needs.safe_outputs.outputs.created_pr_number }}
          FIRST_RUN: ${{ github.event.inputs.first_run }}
          FIRST_REPORT: ${{ runner.temp }}/first-report
          GH_TOKEN: ${{ github.token }}
        run: bash tools/unit-test-agent/render-report.sh
      - if: steps.render.outputs.post == 'true'
        uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
        env:
          BODY_FILE: ${{ runner.temp }}/report/comment.md
          PR_NUMBER: ${{ github.event.inputs.pr || needs.safe_outputs.outputs.created_pr_number }}
        with:
          script: |
            const issue_number = Number(process.env.PR_NUMBER)
            if (!Number.isInteger(issue_number) || issue_number <= 0) throw new Error('PR number is not an integer')
            const body = require('node:fs').readFileSync(process.env.BODY_FILE, 'utf8')
            // Sticky: update our own comment (by the bot, with the marker), else create it.
            const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number, per_page: 100 })
            const mine = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith('<!-- unit-test-agent -->'))
            if (mine) await github.rest.issues.updateComment({ ...context.repo, comment_id: mine.id, body })
            else await github.rest.issues.createComment({ ...context.repo, issue_number, body })
      # First pass only, so there is never a third.
      - name: Start a second pass if coverage still has gaps
        if: github.event.inputs.pr == ''
        env:
          GAPS: ${{ steps.render.outputs.gaps }}
          PR_NUMBER: ${{ needs.safe_outputs.outputs.created_pr_number }}
          GH_TOKEN: ${{ github.token }}
        run: |
          if [ -z "$GAPS" ]; then
            echo "No second pass: the measured coverage after the agent has no line, branch or function gaps, or there is no measured report."
            exit 0
          fi
          [[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { echo "PR number is not an integer" >&2; exit 1; }
          head=$(gh pr view "$PR_NUMBER" -R "$GITHUB_REPOSITORY" --json headRefOid,headRefName --jq '.headRefOid + " " + .headRefName')
          echo "Second pass on PR #$PR_NUMBER at ${head%% *}: coverage after the agent is still below 100% for $GAPS."
          gh workflow run "$GITHUB_WORKFLOW" -R "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" \
            -f pr="$PR_NUMBER" -f head_sha="${head%% *}" -f head_ref="${head#* }" -f first_run="$GITHUB_RUN_ID"
steps:
  - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
    with:
      node-version: 24
      cache: npm
      # One line: gh aw compile folds a multi-line value into a single path with spaces.
      cache-dependency-path: "**/package-lock.json"
  - name: Install dependencies
    run: |
      npm ci --ignore-scripts --prefix backend
      npm ci --ignore-scripts --prefix frontend
      npm run db:generate --prefix backend
  - name: Analyse the uncovered code with the trusted tooling
    env:
      BASE: ${{ github.sha }}
      PR: ${{ github.event.inputs.pr }}
      HEAD_SHA: ${{ github.event.inputs.head_sha }}
      HEAD_REF: ${{ github.event.inputs.head_ref }}
      FIRST_RUN: ${{ github.event.inputs.first_run }}
      GH_TOKEN: ${{ github.token }}
    run: |
      # A second pass needs all four inputs, a new sweep none.
      if [ -n "$PR$HEAD_SHA$HEAD_REF$FIRST_RUN" ]; then
        [[ "$PR" =~ ^[0-9]+$ && "$HEAD_SHA" =~ ^[0-9a-f]{40}$ && "$HEAD_REF" =~ ^[A-Za-z0-9._/-]+$ && "$FIRST_RUN" =~ ^[0-9]+$ ]] \
          || { echo "::error::pr, head_sha, head_ref and first_run must all be set and valid, or all be empty"; exit 1; }
      fi
      mkdir -p .unit-test-agent
      # The tooling comes from the dispatched commit, never from the agent's changes.
      git worktree add --detach "$RUNNER_TEMP/trusted" "$BASE"
      # A second pass works on the PR's branch, so the manifest lists only what is still uncovered there.
      if [ -n "$PR" ]; then
        git fetch --no-tags origin "+refs/pull/$PR/head:refs/remotes/pr/head"
        [ "$(git rev-parse refs/remotes/pr/head)" = "$HEAD_SHA" ] || { echo "::error::PR #$PR is no longer at $HEAD_SHA"; exit 1; }
        git checkout -B "$HEAD_REF" "$HEAD_SHA"
      fi
      # The agent tells a continuation pass by this file (the prompt has no run-time values); only a second pass writes it.
      rm -f .unit-test-agent/continuation.json
      if [ -n "$PR" ]; then
        node -e 'require("fs").writeFileSync(".unit-test-agent/continuation.json", JSON.stringify({ pr: Number(process.env.PR), headRef: process.env.HEAD_REF }) + "\n")'
      fi
      # The agent's only command is the base commit's copy in the git-ignored scratch folder,
      # so a pull request cannot change the tool the agent checks its own tests with.
      mkdir -p .unit-test-agent/bin/lib
      install -m 755 "$RUNNER_TEMP/trusted/tools/unit-test-agent/run-tests.mjs" .unit-test-agent/bin/run-tests.mjs
      cp "$RUNNER_TEMP/trusted/tools/unit-test-agent/lib/test-paths.mjs" "$RUNNER_TEMP/trusted/tools/unit-test-agent/lib/coverage.mjs" "$RUNNER_TEMP/trusted/tools/unit-test-agent/lib/paths.mjs" "$RUNNER_TEMP/trusted/tools/unit-test-agent/lib/without-change.mjs" "$RUNNER_TEMP/trusted/tools/unit-test-agent/lib/check-output.mjs" .unit-test-agent/bin/lib/
      # With the schema its --check-output reads, from the same commit.
      cp "$RUNNER_TEMP/trusted/tools/unit-test-agent/validate-patch.mjs" "$RUNNER_TEMP/trusted/.github/agents/unit-test-agent.schema.json" .unit-test-agent/bin/
      install -m 755 "$RUNNER_TEMP/trusted/tools/unit-test-agent/commit-msg" "$(git rev-parse --git-path hooks)/commit-msg"
      for app in backend frontend; do
        (cd "$app" && npx vitest run --coverage --coverage.reporter=json --coverage.reporter=json-summary \
          --coverage.reportOnFailure --reporter=json --outputFile="../.unit-test-agent/results-$app.json") || true
      done
      node "$RUNNER_TEMP/trusted/tools/unit-test-agent/change-manifest.mjs" --mode coverage --apps both --max-files 1000 # every file with uncovered code
      # Nothing uncovered: end the run before any model call.
      if [ "$(node -p 'require("./.unit-test-agent/manifest.json").gate.runAgent')" != "true" ]; then
        out="${GH_AW_SAFE_OUTPUTS:-$RUNNER_TEMP/gh-aw/safeoutputs/outputs.jsonl}"
        mkdir -p "$(dirname "$out")"
        node -e 'const m = require("./.unit-test-agent/manifest.json"); process.stdout.write(JSON.stringify({ type: "noop", message: `No unit tests needed: ${m.gate.reason}` }) + "\n")' >> "$out"
      fi
      # The first pass's reasons for what is still uncovered (its untrusted claims, cleaned to plain text), if available.
      if [ -n "$PR" ]; then
        if gh run download "$FIRST_RUN" -R "$GITHUB_REPOSITORY" -n unit-test-agent-claims -D "$RUNNER_TEMP/first-pass"; then
          node "$RUNNER_TEMP/trusted/tools/unit-test-agent/previous-pass.mjs" "$RUNNER_TEMP/first-pass/agent-output.json" \
            --manifest .unit-test-agent/manifest.json --out .unit-test-agent/previous-pass.md
        else
          echo "No notes from the first pass: its claims artifact is unavailable"
        fi
      fi
post-steps:
  - name: Stage the agent's claims (untrusted)
    if: always()
    run: |
      # The agent controls this path, so the upload must not follow a link it planted:
      # only a small, regular, parsable JSON file is copied; otherwise nothing is uploaded.
      src=.unit-test-agent/agent-output.json
      mkdir -p "$RUNNER_TEMP/claims"
      if [ -L .unit-test-agent ] || [ -L "$src" ] || [ ! -f "$src" ]; then
        echo "No claims uploaded: $src is missing, a link or not a regular file"
      elif [ "$(wc -c < "$src")" -gt 262144 ]; then
        echo "No claims uploaded: $src is larger than 256 KB"
      elif ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$src"; then
        echo "No claims uploaded: $src is not valid JSON"
      else
        cp "$src" "$RUNNER_TEMP/claims/agent-output.json"
      fi
  - name: Upload the agent's claims (untrusted)
    if: always()
    uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
    with:
      name: unit-test-agent-claims
      path: ${{ runner.temp }}/claims/agent-output.json
      if-no-files-found: ignore
      retention-days: 7
safe-outputs:
  threat-detection:
    runs-on: ubuntu-24.04 # not inherited from runs-on in gh-aw v0.93.5
    continue-on-error: false # a detected threat or a failed check blocks every safe output
    report-as-issue: false
    steps:
      # The commit the agent built on: the dispatched one, or the PR head in a second pass.
      - name: Check out the agent's starting commit for the verification gate
        if: needs.agent.outputs.has_patch == 'true'
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.inputs.head_sha || github.sha }}
          path: gate
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        if: needs.agent.outputs.has_patch == 'true'
        with:
          node-version: 24
      - name: Download the agent's claims
        if: needs.agent.outputs.has_patch == 'true'
        continue-on-error: true
        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: unit-test-agent-claims
          path: ${{ runner.temp }}/gate-in/agent
      # The gate reads the agent's artifact from its own download: by the time custom detection steps run,
      # gh-aw's shared /tmp/gh-aw copy no longer holds agent_usage.json, so the AI credits went missing.
      - name: Download the agent's artifact for the gate
        if: needs.agent.outputs.has_patch == 'true'
        continue-on-error: true # a missing download leaves no bundle, and the gate fails closed
        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          pattern: "{agent,agent-output-fallback}"
          merge-multiple: true
          path: ${{ runner.temp }}/gate-agent
      - name: Verification gate (base-branch tooling, tests without network)
        if: needs.agent.outputs.has_patch == 'true'
        env:
          MODE: coverage
          BASE_SHA: ${{ github.sha }}
          HEAD_SHA: ${{ github.event.inputs.head_sha || github.sha }}
          AGENT_RESULT: ${{ needs.agent.result }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          NODE_IMAGE: "node:24-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a"
          AGENT_ARTIFACTS_DIR: ${{ runner.temp }}/gate-agent
        run: |
          trusted="$RUNNER_TEMP/trusted"
          mkdir -p "$trusted"
          # The rules that judge the agent's commit come from the dispatched commit, never from the agent.
          git -C gate archive "$BASE_SHA" tools/unit-test-agent .github/agents/unit-test-agent.schema.json | tar -x -C "$trusted"
          GATE_DIR="$GITHUB_WORKSPACE/gate" IN="$RUNNER_TEMP/gate-in" bash "$trusted/tools/unit-test-agent/gate.sh"
      - name: Upload the verification report
        if: always() && needs.agent.outputs.has_patch == 'true'
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: unit-test-agent-report
          path: ${{ runner.temp }}/gate-in/out/
          if-no-files-found: ignore
          retention-days: 14
    max-ai-credits: 100
    engine:
      id: copilot
      model: claude-haiku-5.5
  create-pull-request:
    allowed-files:
      - "backend/tests/**"
      - "frontend/src/**/*.test.ts"
      - "frontend/src/**/*.test.tsx"
      - "frontend/src/test/**"
    protected-files: blocked
    title-prefix: "test: "
    labels: [unit-test-agent]
    draft: false
    if-no-changes: ignore
    # Creates the PR with the repository owner's token, so CI starts on it by itself;
    # PRs created with GITHUB_TOKEN do not trigger workflows.
    github-token: ${{ secrets.UNIT_TEST_AGENT_PUSH_TOKEN }}
    github-token-for-extra-empty-commit: none # no extra empty commit: the owner's token already starts CI
  # A second pass adds its commit to the first pass's PR. The target is the dispatched PR number, never the
  # agent's choice; it is empty in a first pass, where this output has no pull request to push to.
  push-to-pull-request-branch:
    target: ${{ github.event.inputs.pr }}
    allowed-files:
      - "backend/tests/**"
      - "frontend/src/**/*.test.ts"
      - "frontend/src/**/*.test.tsx"
      - "frontend/src/test/**"
    protected-files: blocked
    if-no-changes: ignore
    # The pre-flight check needs administration:read, which GITHUB_TOKEN cannot have; it only
    # warned on every run. A protected branch still rejects the push itself.
    check-branch-protection: false
    github-token: ${{ secrets.UNIT_TEST_AGENT_PUSH_TOKEN }}
    github-token-for-extra-empty-commit: none
  noop:
    report-as-issue: false
---

# Unit test agent (sweep)

`MODE=coverage`. The manifest lists every file with uncovered lines, branches or functions, and where they are, at `.unit-test-agent/manifest.json`.

Follow the workflow in your instructions step by step and load each skill at its step; the `reviewing-test-quality` review comes before you report, not after. Then write `.unit-test-agent/agent-output.json` and commit the tests. If nothing needs to change, report no-op.

If `.unit-test-agent/continuation.json` exists, this is a continuation pass on the pull request it names (`pr`): that pull request's branch (`headRef`) is checked out, and the manifest lists only what is still uncovered there. Commit on the checked-out branch and publish the commit with `push_to_pull_request_branch` (`branch`: the file's `headRef`). Never create a new pull request.

If that file does not exist, open one new pull request for the commit with `create_pull_request` on a branch named `unit-test-agent/sweep`, covering both apps.

The gate rejects the whole run if you break these:

- Only add tests: you may add new `it`/`test`/`describe` blocks to an existing test file, but never change a line inside an existing test or hook, never add a hook outside your new blocks or any `vi.mock` (Vitest hoists it to the top of the file), and never edit an existing helper or setup file under the test paths (a new helper file is fine).
- Add new tests to the existing test file of the source. Create a separate file only when the new tests need a file-scope mock or `beforeEach` that would change how the existing tests in that file run; name it after the behaviour it covers (e.g. `router.errors.test.ts`).
- Commit everything in exactly one commit.
- There is no pull request comment in this mode: put the per-file decisions, skipped files with reasons and any "Is it intended that ...?" questions in the pull request body, or in a continuation pass only in `agent-output.json`; the workflow's comment shows them.
