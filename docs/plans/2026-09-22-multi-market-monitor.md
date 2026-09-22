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
| Pre-sign storage | One v2 registry with one bundle per market. No v1 reader/migration path exists. |
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
- `monitor.mjs`: executes targeted/all-market checks, maintains per-market
  state, sends alerts, and atomically broadcasts one eligible signed tx.
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
8. Inspect `data/presigned.json`: it must have `{ "version": 2, "bundles":
   { ... } }`, restrictive permissions where supported, and never contain a
   v1 root bundle.
9. Confirm ntfy cooldown is independent per market while the daily cap is
   shared across all markets.

## Acceptance evidence recorded during implementation

- `npm test` passed: 11 files, 287 tests.
- A live smoke read using `config/markets.example.json` successfully returned
  the configured market's liquidity and lender position at a fixed block.
- Syntax checks passed for monitor, webapp server, proxy, configuration,
  reader, and registry modules.

## Non-goals

- Migration or compatibility with `MARKET_ID`,
  `MIN_LIQUIDITY_THRESHOLD_USDC`, or v1 presigned files.
- Dashboard aggregation beyond the existing market-specific web page.
- Multi-lender operation; all configured markets share `LENDER_ADDRESS`.
