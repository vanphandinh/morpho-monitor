# Multi-market Morpho monitor — implementation and audit plan

Status: implemented on `feat/multi-market-monitor` in commit `578a377`.

## Objective

Monitor fewer than ten Morpho Blue markets for one lender with accurate
same-block state, bounded RPC use, per-market alert behaviour, and safe
pre-signed withdrawal handling. This is a full migration: the legacy
single-market configuration and bundle format are deliberately unsupported.

## Design decisions

| Concern | Decision |
| --- | --- |
| Market configuration | Required, versioned `MARKETS_FILE` JSON allow-list. |
| Thresholds | `minLiquidity` and optional `suddenDrainMultiplier` belong to each market. |
| Dynamic reads | One `multicall` for `market` and lender `position` per requested market, pinned to a single block number. |
| Immutable reads | Market params and token metadata are cached during startup. |
| Real-time trigger | Five Morpho event subscriptions use an OR list of configured market IDs; events are debounced into a targeted check. |
| Fallback | Periodic HTTP polling reads every configured market. |
| Alert controls | Alert state and cooldown are per market; the daily notification cap is global. |
| Pre-sign storage | Registry v3 multi-nonce ladder (one bundle per `marketId@nonce`; reads legacy v2 in-memory). No v1 reader/migration path exists. |
| Shared nonce | A cross-process registry lock selects at most one eligible bundle across all markets. All pending/broadcasting bundles with an outdated lender nonce are expired. |

## Configuration contract

Deployments must set `MARKETS_FILE`, normally to `./config/markets.json`.
The file is intentionally gitignored; copy `config/markets.example.json` and
use this shape:

```json
{
  "version": 1,
  "markets": [
    {
      "id": "0x...64 hex characters...",
      "minLiquidity": "100",
      "suddenDrainMultiplier": 2
    }
  ]
}
```

Every ID is validated, normalized to lowercase, and must be unique. The
proxy and webapp reject any market not present in this allow-list.

## Implementation map

- `market-config.mjs`: validates and loads the market allow-list.
- `market-reader.mjs`: caches immutable metadata and executes same-block
  multicalls.
- `monitor.mjs`: wires targeted/all-market checks, notification delivery and
  the broadcaster without retaining debounce or lifecycle state.
- `monitor-triggers.mjs`: lossless scheduler plus single-active-endpoint WSS
  watcher; polling and WSS share the same queue.
- `presigned-broadcast.mjs`: nonce-wide claim, receipt reconciliation and
  terminal lifecycle for signed transactions.
- `notification-dispatch.mjs`: independent ntfy and VoIP delivery; only ntfy
  success advances alert quota.
- `presigned-store.mjs`: validates, locks, and atomically writes registry v2.
- `proxy-rpc.mjs` and `webapp-server.mjs`: enforce the market allow-list and
  persist/retrieve bundles by market.
- `webapp.html`: accepts only a server-allow-listed `?market=` selection.

## Required audit checks after deployment

1. Confirm `config/markets.json` exists in the runtime container/host and its
   IDs exactly match the intended markets.
2. Run `npm test` and verify all tests pass before deploying the image.
3. Run `node index.mjs` with production configuration; verify all configured
   markets are printed and the reported block number is shared.
4. Check monitor logs on startup: number of loaded markets, RPC endpoint
   count, and no multicall failures.
5. Trigger or observe one event for a configured market and confirm only its
   targeted, debounced read runs; verify polling remains operational if WSS
   disconnects.
6. Verify URLs for an unconfigured `?market=` resolve to the first configured
   market, and proxy/server reject an unconfigured market ID.
7. Create bundles for two markets at the same lender nonce. When both become
   eligible, confirm exactly one reaches `submitted`; the other becomes
   `expired` after nonce advancement.
8. Inspect `data/presigned.json`: it must have `{ "version": 3, "bundles":
   { "<marketId>@<nonce>": ... }, "consumedNonce": n }`, restrictive
   permissions where supported, and never contain a v1 root bundle.
9. Confirm ntfy cooldown is independent per market while the daily cap is
   shared across all markets.

## Acceptance evidence recorded during implementation

> **ĐÍNH CHÍNH 2026-09-23 (audit):** record dưới đây ghi nhận `npm test` xanh
> trong khi **3 lỗi P0** vẫn đang sống và không có test nào phủ: capture
> `eth_sendRawTransaction` ném `ReferenceError` (không test nào import
> `proxy-rpc.mjs`), một bundle terminal khoá cứng broadcaster, và
> `PROXY_RPC_URL` không bao giờ tới browser. Suite xanh vì các module đó không
> được chạy. Bằng chứng dưới đây giữ nguyên để đối chiếu lịch sử nhưng **không**
> còn là tiêu chí merge — xem
> `docs/plans/2026-09-23-multi-market-audit-findings.md`.
>
> Record thay thế (2026-09-23, sau khi sửa P0/P1/P2): `npm test` = **21 files /
> 339 tests**, `npm run lint` (oxlint `--deny no-undef`) = 0 errors,
> `node --check` = 42/42 file, `docker compose config --quiet` OK, và mỗi lỗi
> P0/P1 có suite hồi quy riêng (`proxy-capture`, `wss-connect`, `file-lock`,
> `verify-presigned-cli`, `webapp-config`).

- `npm test` passed: 16 files, 280 tests (2026-09-23, after merge-readiness
  fixes; see `docs/plans/2026-09-23-gitnexus-plan-merge-readiness-audit-fixes.md`).
  *(superseded — xem đính chính phía trên)*
- `node --check` passed for all changed/new `.mjs` files (2026-09-23).
- Cross-process exclusivity is now proven by real child processes
  (`__tests__/presigned-cross-process.test.mjs`, `__tests__/two-process-race.test.mjs`).
- Deployment-only smoke checks remain pending: they require production-owned
  markets config, RPC/WSS endpoints and valid signed bundles.
- A live smoke read using `config/markets.example.json` successfully returned
  the configured market's liquidity and lender position at a fixed block.
- Syntax checks passed for monitor, webapp server, proxy, configuration,
  reader, and registry modules.

## Non-goals

- Migration or compatibility with `MARKET_ID`,
  `MIN_LIQUIDITY_THRESHOLD_USDC`, or v1 presigned files.
- Dashboard aggregation beyond the existing market-specific web page.
- Multi-lender operation; all configured markets share `LENDER_ADDRESS`.
