# Project instructions

## Product boundary

Shion is a single-owner, self-hosted A-share research advisor. It may analyze,
track, backtest, and review simulated portfolios. It must not place or imply
that it placed a real broker order.

## Preflight Commands

Run these commands sequentially and stop on the first failure:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:py
pnpm test:coverage
```

Changes to the Web dashboard also require a local browser render and screenshot
check. Production deployments must expose the committed revision through
`/api/status`.
