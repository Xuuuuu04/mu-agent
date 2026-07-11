# CLAUDE.md

This file is repository guidance for coding agents. Product requirements live in
`REQUIREMENTS.md`; the runtime design lives in `docs/ARCHITECTURE.md`.

## Product

Shion is a single-owner, self-hosted A-share research advisor. It combines
market/fundamental/event data with persistent Investment Cases, evidence,
decision journals, portfolio risk, historical backtests, and normalized
simulation review.

The hard boundary is research and decision support. Do not add a real broker
login, order API, automatic trading, or language that treats a backtest as a
profit promise.

Legacy names such as `mu`, `mu.db`, and `/home/jump/mu` remain for deployment
compatibility. User-facing identity is Shion.

## Commands

```bash
pnpm start
pnpm dev
pnpm mu status

pnpm typecheck
pnpm lint
pnpm test
pnpm test:py
pnpm test:coverage

scripts/run-backtest.sh --symbol 000001 --start 20250101 --end 20251231 --strategy ma_cross
scripts/run-simulation-analysis.sh --snapshot snapshot.json --backtest data/backtest/latest-report.json
```

Runtime executes TypeScript from `src/` through `tsx`; production does not use
`dist/`. Node.js 22+ and pnpm are required. Imports use ESM/NodeNext `.js`
suffixes.

Before a production deploy, run every command in `AGENTS.md` under
`Preflight Commands`. Web changes also require a local browser screenshot.

## Runtime

| Process | Responsibility |
|---|---|
| `mu` | Agent loop, memory, tools, webhook, admin API, and static dashboard on loopback `:3210` |
| `mu-qq` | Optional QQ bridge; supports passive and proactive delivery |
| `mu-wechat` | Optional WeChat iLink bridge; passive response only |

Platform bridges enforce owner allowlists and only translate platform protocols.
Reasoning and state changes happen in `mu`. A synchronous webhook waits up to
110 seconds; late replies move to proactive delivery and persistent outbox.

## Core invariants

- `MessageQueue` serializes cycles and merges burst messages from one sender.
- Tool use/result blocks must remain paired across trim, restore, and provider
  conversion. Never reintroduce orphan blocks.
- Scheduler keeps independent `reminder`, `task`, and interruptible `rest`
  wakes. A normal message must not delete user reminders or Task wakes.
- Task progression is bounded by active count, wake count, no-progress count,
  retry backoff, and review rounds.
- Critical JSON uses atomic same-directory write + fsync + rename. A corrupt
  research file fails closed and must not be overwritten with an empty default.
- Built-in tool names are reserved. MCP suffix fallback is allowed only when it
  has exactly one match; ambiguity must be returned as an error.
- Shell side effects require a one-time approval id sent by the human through a
  zero-token command. The model cannot approve itself.
- `web_fetch` validates the initial URL, DNS resolution, and every redirect for
  SSRF.

## Financial reasoning invariants

- Financial cycles use `fallbackPolicy=deny`. A general fallback model must not
  silently replace the primary financial model.
- Only finance-related and essential core tool schemas are sent in a financial
  cycle. Avoid expanding this set without a real use case and provider smoke
  test.
- JSON Schema property-level `required: true/false` is an internal authoring
  convenience only. Emitted schemas use the standard object-level `required`
  array.
- Every market conclusion distinguishes source and `as_of`. Missing, stale, or
  invalid prices are not converted into precise risk figures.
- Investment evidence and decisions are append-only. Updating a thesis must not
  erase what was known when the earlier decision was made.
- `RelationsLayer` injects only a bounded number of active Investment Cases to
  keep the prompt stable.
- A case should contain thesis, confidence, invalidation conditions, and a review
  date. A material recommendation should have an associated decision record.

## Financial state

Runtime files are intentionally ignored by Git:

```text
data/memory/portfolio.json
data/memory/investment-cases.json
data/memory/decision-journal.json
data/memory/watchdog-health.json
data/memory/watchdog-state.json
data/memory/portfolio-risk-latest.json
data/memory/trade-calendar.json
data/backtest/latest-report.json
data/backtest/latest-simulation-analysis.json
```

Public tool and procedural-skill definitions under `data/tools/` and
`data/skills/` are selectively tracked through `.gitignore`. Do not broaden the
unignore rules to runtime data.

## A-share backtesting

The Python engine is single-symbol and long-only. A signal formed at close is
executed no earlier than the next bar open. It models T+1 sells, 100-share lots,
commission/minimum commission, sell stamp duty, slippage, suspension, and limit
blocking. Board defaults are 10% for main-board, 20% for ChiNext/STAR, and 30%
for Beijing listings. ST and new-listing phases require explicit overrides or
authoritative per-bar flags. Data cache metadata includes source, requested
range, adjustment mode, and adjustment date; mismatched adjusted data is rejected.

AkShare is optional and should live in the isolated Python environment used by
the wrappers. Offline fixture tests must not be described as strategy alpha.

## Web/API

- The HTTP server binds loopback. Remote use goes through an SSH tunnel or a
  trusted bridge, never a public bind.
- Browser requests are same-origin checked and body size is bounded.
- `/api/status` includes `version`, committed `revision`, `build_time`, and model
  router health.
- `/api/finance` independently loads positions, cases, decisions, alerts,
  watchdog health, portfolio risk, and latest analysis reports. One corrupt file
  must not break the whole response.
- `web/index.html` is a read-only, responsive research dashboard. Preserve empty,
  loading, error, and narrow-screen states.

## Deployment

`scripts/deploy.sh` is the supported path. It:

1. refuses tracked working-tree changes and untracked deploy content;
2. builds a tracked-only `git ls-files` manifest and rsyncs it without `--delete`;
3. preserves private config, memory, databases, and backtest state;
4. installs dependencies and typechecks on the server;
5. initializes the official trade calendar only when runtime state has none;
6. restarts `mu` with revision/build metadata;
7. verifies `/api/status` before reporting success.

Set `INSTALL_BACKTEST_DEPS=1` when the isolated remote Python environment also
needs AkShare. Never print or copy API keys, bridge credentials, or private
memory during diagnostics.

## Test layers

- L1: co-located TypeScript `node:test` suites and Python `unittest` suites.
- L2: real provider, MCP, market data, and channel smoke tests after deployment.
- L3: production behavior regression only when identity/memory behavior changes;
  back up and restore personal state around any synthetic message.

Use TDD for behavior changes. A deploy is not complete until local preflight,
independent review, remote revision verification, and relevant L2 smoke tests
all pass.
