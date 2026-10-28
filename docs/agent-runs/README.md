# Agent runs

One folder per saved run, `<date>-<slug>/`, written by
`tools/unit-test-agent/save-evidence.sh <run-id> <slug>`: `report.json` (what the gate measured),
`agent-output.json` (what the agent claimed, if any) and `run.md` (links, verdict, duration). `usage.json` is gh-aw's `agent_usage.json` from the run's `usage` artifact (AI credits), where saved.
Workflow artifacts expire after 14 days; this folder is the durable record.

| Date | Scenario | PR | Run | Verdict | Agent decisions | Tests added | Fails without the change | Cost (AIC) |
|---|---|---|---|---|---|---|---|---|
