# Deep implementation plan: multi-market audit fixes

> Branch: `feat/multi-market-monitor`  
> Base: `main`  
> Evidence commit: `24111bc0a235c670abb38674008d42aed52b8525`  
> Plan depth: Deep  
> Generated: 2026-09-22

## 1. Objective

Đưa nhánh multi-market về trạng thái có thể merge/deploy bằng cách sửa toàn bộ lỗi đã xác nhận trong audit, tập trung vào bốn invariant quan trọng:

1. Một shared nonce chỉ được một market/process giữ quyền broadcast tại một thời điểm.
2. Không mất event giữa WSS, debounce, polling và một lần check đang chạy.
3. Notification, threshold và market routing thực sự độc lập theo market.
4. Test phải chạy trên production code thay vì bản sao logic trong test.

Ngoài phạm vi: thay đổi schema registry lớn, hỗ trợ nhiều lender/account, thay lock file hiện tại bằng distributed lock, hoặc tự tạo dữ liệu production.

## 2. Current behavior and confirmed defects

- `monitor.mjs:broadcastEligible` đọc/sửa từng market bundle nhưng không giữ một reservation bao trùm mọi market có cùng nonce. Hai process có thể cùng chọn hai bundle khác market rồi broadcast cùng nonce.
- Logic hết hạn đang coi nonce khác current nonce là stale, nên xóa cả bundle ở tương lai. Một số nhánh đánh dấu `submitted` ngay sau send thay vì xác nhận receipt.
- Tier `all-shares` có thể được chọn khi giá trị assets ước tính không an toàn; nhánh hiện tại không luôn fallback về fixed tiers.
- `notifyCheck` dùng một timer/closure ghi đè danh sách market; guard `checking` bỏ luôn event đến trong lúc đang chạy.
- WSS implementation mới không còn đặc tính sequential endpoint failover/reconnect/cleanup của implementation trên `main`.
- VoIP không còn được gọi trong notification path; failure của ntfy và quota state chưa được tách bạch.
- `SUDDEN_DRAIN_MULTIPLIER` vẫn có fallback global dù spec yêu cầu per-market; loader chưa enforce giới hạn “ít hơn 10 market”.
- Validator market bị lặp ở `market-config.mjs`, `webapp-server.mjs` và `proxy-rpc.mjs`.
- UI xóa toàn bộ presigned bundles không gửi `market`, trong khi server đã cần market để định tuyến.
- Một số test tự chép logic scheduler/selector thay vì import implementation, vì vậy 287 test xanh chưa chứng minh production path đúng.
- Comment/log tiếng Anh mới và tên `runtimes`/`notifyCheck` không phù hợp convention/ý nghĩa domain của repo.

## 3. Target architecture

```text
WSS endpoints (one active) ─┐
polling interval ──────────┼─> createCheckScheduler ─> checkMarkets(marketIds | all)
startup/manual trigger ────┘               │
                                           ├─> per-market snapshot + threshold
                                           ├─> dispatchNotifications (ntfy || VoIP isolated)
                                           └─> broadcastEligible
                                                  │
                                                  v
                                      presigned-broadcast lifecycle
                                      lock registry → reconcile/claim
                                      → send exact raw tx → receipt
                                      → lock registry → finalize
```

Module boundaries:

- `monitor.mjs`: orchestration only; construct market contexts and wire scheduler, watcher, notification and broadcaster.
- New `presigned-broadcast.mjs`: the complete claim/reconcile/broadcast/finalize state machine; importable by tests.
- New `monitor-triggers.mjs`: lossless scheduler and WSS endpoint manager; importable by tests.
- New `notification-dispatch.mjs`: independent ntfy/VoIP dispatch and delivery result.
- `presigned-store.mjs`: atomic registry mutation/storage only.
- `market-config.mjs`: single source of truth for load/default/normalize/validate configured market IDs.

No registry version bump is required: lifecycle fields added by this fix are optional metadata within registry v2.

## 4. GitNexus findings

Index was refreshed at `24111bc0a235c670abb38674008d42aed52b8525`: 1,758 nodes, 4,970 edges, 19 clusters and 36 flows.

- `query broadcastEligible` connects the broadcaster to registry writes, `withFileLock`, market-ID computation and empty-registry creation. This confirms that transaction selection and persistence belong behind one explicit lifecycle seam.
- `context broadcastEligible` locates the production implementation at `monitor.mjs:33-59`; depth-3 impact is HIGH with direct dependent `checkMarkets`.
- `context checkMarkets` locates `monitor.mjs:61-79`; depth-3 impact is HIGH with direct dependents `main`, the polling callback and `notifyCheck`.
- `context startWss` locates `monitor.mjs:81+`; impact identifies `main` as the direct integration point.
- `query/context updateRegistry` locates `presigned-store.mjs:30-37`; depth-3 impact is CRITICAL because both `broadcastEligible` and the web server mutate the same registry.
- `query requireConfiguredMarket` exposes the parallel validation seam in the web server; source verification found equivalent normalization/rejection in `proxy-rpc.mjs:30-53`.
- The HTTP `server` callback has no useful graph caller because it is framework/runtime-driven, so routes were verified directly in `webapp-server.mjs:114-460`.

Graph MCP resources were unavailable in this workspace; the repository-pinned `.gitnexus/run.cjs` CLI was used. All symbols named below were then source-verified.

## 5. PDG and data/control constraints

Statement-level upstream PDG was queried for `broadcastEligible` (lines 36, 45, 52), `checkMarkets` (62, 66, 77) and `notifyCheck` (22).

- The claim mutation must dominate every network send: write `broadcasting`, selected tier, timestamp and deterministic tx hash while the registry lock is held; release the lock only after the reservation is durable.
- Receipt/reconciliation must dominate terminal status. A send return value or timeout alone cannot set `submitted` or free another market to use the nonce.
- Snapshot/threshold evaluation currently controls both alerting and broadcast; the refactor must preserve this ordering per requested market set.
- The `checking` guard currently controls an early return that drops events; replace it with pending state and a trailing run.
- `notifyCheck` closes over a replaceable market-ID list; replace that flow with set union plus an `allRequested` flag.

GitNexus coalesced several one-line callbacks/lambdas, so portions of the PDG output were unresolved/degraded. For those statements, the verified source ranges above are authoritative.

## 6. Proposed changes

### 6.1 Centralize market configuration and validation

Files: `market-config.mjs`, `.env.example`, `config/markets.example.json`, `proxy-rpc.mjs`, `webapp-server.mjs`.

- Extend `loadMarkets` to require an array of 1–9 enabled/configured markets, reject a tenth market, normalize IDs once, reject duplicates, and materialize `suddenDrainMultiplier: 2` when omitted.
- Require a finite numeric multiplier `>= 1` for every market after defaults.
- Export a small configured-market lookup/validation helper from `market-config.mjs`; use it from proxy and web server instead of maintaining `assertConfiguredMarket` and `requireConfiguredMarket` variants.
- Remove the global `SUDDEN_DRAIN_MULTIPLIER` export/use and its entry from `.env.example`. Keep `config/markets.example.json` as the documented source.
- Preserve normalized market order; it becomes the deterministic tie-break order for nonce arbitration.

### 6.2 Make presigned broadcasting nonce-safe

Files: new `presigned-broadcast.mjs`, `presigned-store.mjs`, `presign-verify.mjs`, `monitor.mjs`, `shared.mjs`.

Create an importable broadcaster with explicit phases:

1. Read current chain nonce.
2. Under `updateRegistry`/the existing `withFileLock`, expire only bundles where `bundle.nonce < currentNonce`; retain `==` and `>`.
3. Scan all markets before selecting. Any current-nonce bundle in `broadcasting` or `submitted` is a nonce-wide reservation. If multiple active reservations already exist, fail closed and emit a diagnostic.
4. Reconcile an existing `broadcasting` reservation first:
   - receipt success → `submitted`;
   - receipt revert → `failed`;
   - no receipt and within recovery rules → rebroadcast the exact serialized transaction, never a different market/tier;
   - ambiguous/timeout → remain `broadcasting`.
5. If no reservation exists, choose the first eligible market in configured order and verify its bundle/tier through `verifyPresignedBundle`.
6. Tier selection:
   - consider `all-shares` only when estimated current assets `shares * totalSupplyAssets / totalSupplyShares` is positive and no greater than available liquidity;
   - otherwise exclude `all-shares`, filter positive fixed tiers no greater than liquidity, and choose the largest valid tier.
7. Compute the deterministic transaction hash from serialized bytes. Persist status `broadcasting`, tier, claim timestamp and hash under the lock before any RPC send.
8. Send outside the lock, wait for a receipt, then reacquire the lock and finalize. A mined success becomes `submitted`; a mined revert becomes `failed`. Either mined outcome consumes the nonce, so expire other pending/broadcasting bundles with that nonce.
9. A send timeout or ambiguous RPC error stays `broadcasting`; it must never be reported as submitted or release the nonce.

Keep registry schema version 2 and add only optional lifecycle metadata needed for recovery. Centralize the current 120-second receipt timeout and 180-second recovery threshold as named, testable constants.

### 6.3 Replace lossy debounce and restore resilient WSS

Files: new `monitor-triggers.mjs`, `monitor.mjs`.

- Implement `createCheckScheduler(checkMarkets, ...)` with:
  - a pending set that unions targeted IDs within the debounce window;
  - an `allRequested` flag that dominates subsets;
  - exactly one active execution;
  - a trailing execution whenever work arrives while active;
  - explicit `flush`/`close` hooks for tests and shutdown.
- Implement a WSS manager with one active endpoint at a time. Probe chain ID, then install five log subscriptions on that connection using an OR filter `args: { id: marketIds }`.
- Reuse the proven behavior from `main`: sequential endpoint failover, reconnect after disconnect/error, subscription teardown, connection cleanup, deduplication and graceful shutdown.
- WSS log events schedule only affected market IDs; polling schedules `all`. Both enter the same scheduler.
- Rename `notifyCheck` to domain-specific scheduler operations; keep `checkMarkets` free of debounce state.

### 6.4 Restore independent notification delivery

Files: new `notification-dispatch.mjs`, `monitor.mjs`, `voip.mjs`.

- Encapsulate ntfy and existing `sendVoipNotification` behind `dispatchNotifications`.
- Attempt enabled channels independently (isolated catches or `Promise.allSettled`); ntfy failure must not suppress VoIP, and VoIP failure must not rewrite ntfy success.
- Return a structured result including `ntfyDelivered`.
- Update per-market alert timestamp/quota/state only when ntfy succeeds. VoIP remains an additional urgent channel and does not consume ntfy quota.
- Keep disabled VoIP as an explicit no-op and preserve existing VoIP configuration semantics.

### 6.5 Fix market-qualified web deletion

Files: `webapp.html`, `webapp-server.mjs`.

- Change `deleteBundle` and “delete all” calls to include the selected normalized market query parameter for every DELETE request.
- Server routes must reject missing/unknown market with HTTP 400 before touching the registry.
- Make deletion response text count “bundles”, not filesystem “files”.
- Preserve full-delete scope: delete all bundles for the selected market only, never every configured market.

### 6.6 Remove test doubles of production logic

Files: `__tests__/presign-broadcast.test.mjs`, `__tests__/expire-bundle.test.mjs`, `__tests__/presign-verify.test.mjs`, `__tests__/wss-watcher.test.mjs`, `__tests__/market-config.test.mjs`, `__tests__/webapp.test.mjs`, new `__tests__/notification-dispatch.test.mjs`.

- Rewrite broadcaster, expiration and WSS tests to import the new production modules.
- Remove the duplicated selector implementation from `presign-verify.test.mjs`; test the exported production selector/state machine instead.
- Use deterministic fake RPC, fake receipts, fake websocket endpoints and temporary registries. Avoid time-based sleeps by injecting clock/timers where needed.
- Keep route/UI assertions close to the production HTTP handler and generated request URL.

### 6.7 Standards and documentation cleanup

Files: `monitor.mjs`, `market-reader.mjs`, `index.mjs`, `CLAUDE.md`, `docs/plans/2026-09-22-multi-market-monitor.md`.

- Rename `runtimes` to `marketContexts`; replace vague one-letter/new English operational wording in touched code with established Vietnamese comments/logs.
- Document new module boundaries, registry lifecycle, scheduler invariant, one-active WSS endpoint and OR-list subscriptions in `CLAUDE.md`.
- Update the original implementation/audit plan with final acceptance evidence only after commands actually pass. Mark deployment-only checks pending unless exercised with real deployment inputs.

## 7. Implementation sequence

1. **Configuration seam:** centralize normalization/defaults/1–9 constraint and migrate server/proxy callers. Run config and route tests.
2. **Transaction state machine:** add `presigned-broadcast.mjs`, lifecycle metadata and deterministic selection/reconciliation. Integrate it into `monitor.mjs`.
3. **Transaction regression suite:** replace duplicated tests and prove cross-process exclusivity, future nonce retention, receipt semantics and recovery before continuing.
4. **Trigger seam:** add scheduler/WSS manager, integrate polling/startup/shutdown, then replace watcher tests with production imports.
5. **Notification seam:** add dispatcher, restore VoIP, change quota mutation rule and add channel-isolation tests.
6. **Web deletion:** send/validate market on DELETE and add UI/route regressions.
7. **Cleanup/docs:** naming, Vietnamese logs/comments, architecture documentation and original-plan evidence.
8. **Final gate:** run all automated/static checks, then deployment-like smoke checks with explicit evidence.

Each step leaves the service runnable and has a focused test gate; do not combine the registry state-machine edit and scheduler edit in one unverified change.

## 8. Test strategy

### Presigned lifecycle

- Two broadcaster instances concurrently claim different markets with the same current nonce: exactly one raw transaction is sent.
- An existing `broadcasting` or `submitted` reservation blocks another market.
- Nonce lower than current is expired; equal is processed; future is retained unchanged.
- Multiple active reservations fail closed and send nothing.
- Safe `all-shares` is selected only when estimated assets fit liquidity; otherwise the largest valid fixed tier is selected.
- No eligible tier sends nothing and preserves valid pending state.
- Receipt success finalizes `submitted`; receipt revert finalizes `failed` and both consume the nonce.
- Timeout/ambiguous send remains `broadcasting`; a later cycle reconciles or rebroadcasts the exact same raw tx/hash.
- Simulated process interruption after durable claim cannot result in another market taking the nonce.

### Scheduler and WSS

- Events for A then B within debounce produce one check with `{A,B}`.
- An all-market poll plus targeted event produces one all-market check.
- Event arriving during an active check causes one trailing check and is not dropped.
- Repeated events deduplicate IDs without creating concurrent checks.
- Only one WSS endpoint is active; connection/probe/subscription failure advances sequentially to the next.
- Five subscriptions use the market-ID OR list, reconnect restores them, and close tears all of them down.
- Polling still checks all markets when WSS is unavailable.

### Notifications, config and web

- VoIP is attempted even when ntfy rejects; ntfy remains successful when VoIP rejects.
- Alert quota/timestamp advances only on successful ntfy.
- Disabled VoIP is a no-op.
- Missing multiplier becomes 2; invalid/<1 multiplier fails.
- 9 markets load; 10 markets fail; duplicate/unknown/non-normalized IDs are handled by the shared validator.
- Single and full DELETE include market; missing/unknown market returns 400; full delete affects only selected market.

### Final verification commands

- `npm test`
- `node --check` for every changed/new `.mjs` file
- `git diff --check`
- `docker compose config --quiet`
- Start against `config/markets.example.json` with stub/safe endpoints and verify startup plus a polling cycle.
- With deployment-provided inputs: fail primary WSS to prove fallback; exercise two real configured markets; verify a signed-bundle receipt/recovery path; confirm ntfy and VoIP independently.

## 9. Risk and impact analysis

| Area | Risk | Direct dependents / mitigation |
|---|---|---|
| `updateRegistry` / registry lifecycle | **Critical** | Used by `broadcastEligible` and web server. Keep mutations short and synchronous under lock; perform no network I/O while locked; add concurrent integration tests. |
| `broadcastEligible` extraction | **High** | Directly called by `checkMarkets`. Preserve snapshot-to-broadcast ordering and return structured no-op/error outcomes. |
| `checkMarkets` scheduling | **High** | Reached by `main`, polling callback and current `notifyCheck`. Route all three through one scheduler and test trailing execution. |
| `startWss` replacement | Medium | Directly initialized by `main`. Startup must remain non-fatal because polling is the fallback. |
| Shared market validator | Medium | Affects proxy and web API request acceptance. Normalize once and add route-level rejection tests. |
| Notification state | High | Incorrect success accounting can suppress future alerts. Return per-channel results and mutate quota only from `ntfyDelivered`. |
| Browser deletion | High | Missing/wrong market can delete the wrong registry slice. Require market at both client and server boundaries. |
| Registry compatibility | Medium | Existing v2 files lack new metadata. Treat fields as optional and migrate lazily during mutation. |
| External RPC/WSS behavior | Medium | Unit fakes cannot prove provider-specific errors. Keep real-endpoint smoke checks as an explicit deployment gate. |

Rollback boundary: new modules can be reverted as a unit only before any bundle enters the new `broadcasting` lifecycle. After that, rollback must first reconcile active registry entries; never downgrade by deleting reservations.

## 10. Expected file changes

| File | Action |
|---|---|
| `presigned-broadcast.mjs` | Add production transaction state machine and selector. |
| `monitor-triggers.mjs` | Add lossless scheduler and WSS failover manager. |
| `notification-dispatch.mjs` | Add isolated ntfy/VoIP dispatch. |
| `monitor.mjs` | Reduce to orchestration and integrate the three modules. |
| `presigned-store.mjs` | Support atomic nonce-wide lifecycle metadata/mutations. |
| `presign-verify.mjs` | Expose/reuse verification needed by the broadcaster without duplicate selector logic. |
| `market-config.mjs` | Defaults, 1–9 constraint and shared configured-market helper. |
| `proxy-rpc.mjs`, `webapp-server.mjs` | Consume shared validator; enforce market-scoped DELETE. |
| `webapp.html` | Include selected market in delete requests. |
| `voip.mjs` | Minimal integration-friendly adjustments, preserving provider logic. |
| `market-reader.mjs`, `index.mjs`, `.env.example`, `config/markets.example.json` | Naming/config/log cleanup. |
| Seven existing test files + `__tests__/notification-dispatch.test.mjs` | Replace copied logic and add concurrency/recovery/routing coverage. |
| `CLAUDE.md`, original multi-market plan | Record architecture and verified acceptance evidence. |

## 11. Implementation context pack

```json
{
  "schema_version": 1,
  "task": {
    "title": "Sửa toàn bộ lỗi audit của multi-market monitor",
    "planning_depth": "deep",
    "source_branch": "feat/multi-market-monitor",
    "base_branch": "main",
    "evidence_commit": "24111bc0a235c670abb38674008d42aed52b8525"
  },
  "implementation_intent": [
    "Khôi phục tính đúng đắn cross-process cho shared nonce và lifecycle giao dịch presigned.",
    "Không làm mất trigger khi debounce hoặc khi một lần check đang chạy.",
    "Khôi phục WSS failover và VoIP mà vẫn cô lập lỗi theo từng kênh.",
    "Đưa threshold về cấu hình từng market, giới hạn 1-9 market và dùng một validator chung.",
    "Bắt test import production code để ngăn test xanh giả."
  ],
  "primary_symbols": [
    {
      "symbol": "broadcastEligible",
      "path": "monitor.mjs",
      "lines": "33-59",
      "impact": "HIGH",
      "direct_dependents": [
        "checkMarkets"
      ]
    },
    {
      "symbol": "checkMarkets",
      "path": "monitor.mjs",
      "lines": "61-79",
      "impact": "HIGH",
      "direct_dependents": [
        "main",
        "setInterval callback",
        "notifyCheck"
      ]
    },
    {
      "symbol": "startWss",
      "path": "monitor.mjs",
      "lines": "81+",
      "impact": "LOW",
      "direct_dependents": [
        "main"
      ]
    },
    {
      "symbol": "updateRegistry",
      "path": "presigned-store.mjs",
      "lines": "30-37",
      "impact": "CRITICAL",
      "direct_dependents": [
        "broadcastEligible",
        "webapp-server server"
      ]
    },
    {
      "symbol": "server",
      "path": "webapp-server.mjs",
      "lines": "114-460",
      "impact": "source-verified callback entry point",
      "direct_dependents": []
    }
  ],
  "planned_modules": [
    {
      "path": "presigned-broadcast.mjs",
      "responsibility": "claim/reconcile/send/receipt lifecycle under a nonce-wide reservation"
    },
    {
      "path": "monitor-triggers.mjs",
      "responsibility": "lossless coalescing scheduler and single-active-endpoint WSS watcher"
    },
    {
      "path": "notification-dispatch.mjs",
      "responsibility": "independent ntfy/VoIP delivery with ntfy success reported separately"
    }
  ],
  "invariants": [
    "At most one bundle with the current nonce may be reserved across all markets/processes.",
    "Only nonce < currentNonce is stale; future nonces are retained.",
    "A timeout or ambiguous RPC error never releases the nonce or marks the bundle submitted.",
    "A mined receipt is required before terminal submitted/failed state.",
    "Queued market IDs are unioned; an all-market request dominates a subset; work arriving in-flight causes a trailing run.",
    "Only successful ntfy delivery advances alert quota/state."
  ],
  "implementation_sequence": [
    "Centralize market validation/defaults and enforce 1-9 markets.",
    "Extract the presigned transaction lifecycle and cover cross-process/recovery cases.",
    "Extract scheduler/WSS watcher and cover debounce/failover/cleanup cases.",
    "Extract notification dispatch and restore VoIP independently.",
    "Fix market-qualified deletion and API validation.",
    "Remove duplicated test logic, clean naming/language, and update architecture docs.",
    "Run unit, syntax, compose, diff and deployment-like smoke verification."
  ],
  "evidence_provenance": {
    "schema_version": 2,
    "head_commit": "24111bc0a235c670abb38674008d42aed52b8525",
    "generated_plan_path": "docs/plans/2026-09-22-gitnexus-plan-multi-market-audit-fixes.md",
    "global_dirty_digest": {
      "algorithm": "sha256",
      "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
      "value": "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
    },
    "cited_path_manifest": [
      {
        "path": ".env.example",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:a983ae3890d46eb096c12f4ec126413cb6ca1e11bb3be4aa7cb4edc1033b8d79",
        "index_digest": "sha256:a983ae3890d46eb096c12f4ec126413cb6ca1e11bb3be4aa7cb4edc1033b8d79",
        "worktree_digest": "sha256:31171f80619ba797be222d8c70e21f42922222dd77138aebbd10429579d07204",
        "untracked_digest": "absent"
      },
      {
        "path": "CLAUDE.md",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:fd38752b9c0d4433928b7236a288536db214e71ddd723777d36f93678f760d34",
        "index_digest": "sha256:fd38752b9c0d4433928b7236a288536db214e71ddd723777d36f93678f760d34",
        "worktree_digest": "sha256:fd38752b9c0d4433928b7236a288536db214e71ddd723777d36f93678f760d34",
        "untracked_digest": "absent"
      },
      {
        "path": "__tests__/expire-bundle.test.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:d969b95a465bc34b3742436d88b0ddde15d90abc483719111a838595aee6f660",
        "index_digest": "sha256:d969b95a465bc34b3742436d88b0ddde15d90abc483719111a838595aee6f660",
        "worktree_digest": "sha256:d969b95a465bc34b3742436d88b0ddde15d90abc483719111a838595aee6f660",
        "untracked_digest": "absent"
      },
      {
        "path": "__tests__/market-config.test.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:27d62818a5f12d7922c9d9ce979dc108f3c9345bdfdae464f30a4e50400a777e",
        "index_digest": "sha256:27d62818a5f12d7922c9d9ce979dc108f3c9345bdfdae464f30a4e50400a777e",
        "worktree_digest": "sha256:27d62818a5f12d7922c9d9ce979dc108f3c9345bdfdae464f30a4e50400a777e",
        "untracked_digest": "absent"
      },
      {
        "path": "__tests__/notification-dispatch.test.mjs",
        "object_kind": {
          "head": "absent",
          "index": "absent",
          "worktree": "absent",
          "untracked": "absent"
        },
        "state": "absent",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "absent",
        "index_digest": "absent",
        "worktree_digest": "absent",
        "untracked_digest": "absent"
      },
      {
        "path": "__tests__/presign-broadcast.test.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:ea60277797d217f2077dadda0a26eb18be91f0f76fdc0e12b992a19c9772bd10",
        "index_digest": "sha256:ea60277797d217f2077dadda0a26eb18be91f0f76fdc0e12b992a19c9772bd10",
        "worktree_digest": "sha256:ea60277797d217f2077dadda0a26eb18be91f0f76fdc0e12b992a19c9772bd10",
        "untracked_digest": "absent"
      },
      {
        "path": "__tests__/presign-verify.test.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:8f58cbfa25a43323862078bf4e0373a8e56c60baa61b4d9cb48e74877d8bede0",
        "index_digest": "sha256:8f58cbfa25a43323862078bf4e0373a8e56c60baa61b4d9cb48e74877d8bede0",
        "worktree_digest": "sha256:8f58cbfa25a43323862078bf4e0373a8e56c60baa61b4d9cb48e74877d8bede0",
        "untracked_digest": "absent"
      },
      {
        "path": "__tests__/webapp.test.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:60ab53d255ae10669246b8eb4f53efebb183447e29360ed0fa3bd3248f324c35",
        "index_digest": "sha256:60ab53d255ae10669246b8eb4f53efebb183447e29360ed0fa3bd3248f324c35",
        "worktree_digest": "sha256:60ab53d255ae10669246b8eb4f53efebb183447e29360ed0fa3bd3248f324c35",
        "untracked_digest": "absent"
      },
      {
        "path": "__tests__/wss-watcher.test.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:47a83510977d4e22327757975c67d051fd2355288237c05e61aa5f7872b2b999",
        "index_digest": "sha256:47a83510977d4e22327757975c67d051fd2355288237c05e61aa5f7872b2b999",
        "worktree_digest": "sha256:47a83510977d4e22327757975c67d051fd2355288237c05e61aa5f7872b2b999",
        "untracked_digest": "absent"
      },
      {
        "path": "config/markets.example.json",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:b33c00d64c7db363677e52d89f186f08772bab8c33c8af88a45e85602f90374d",
        "index_digest": "sha256:b33c00d64c7db363677e52d89f186f08772bab8c33c8af88a45e85602f90374d",
        "worktree_digest": "sha256:b33c00d64c7db363677e52d89f186f08772bab8c33c8af88a45e85602f90374d",
        "untracked_digest": "absent"
      },
      {
        "path": "docs/plans/2026-09-22-multi-market-monitor.md",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:e9b1bfc43b0fdd17b78132a740ff20e8cd1a8791693678c190bea6678a5a41d1",
        "index_digest": "sha256:e9b1bfc43b0fdd17b78132a740ff20e8cd1a8791693678c190bea6678a5a41d1",
        "worktree_digest": "sha256:e9b1bfc43b0fdd17b78132a740ff20e8cd1a8791693678c190bea6678a5a41d1",
        "untracked_digest": "absent"
      },
      {
        "path": "index.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:0c93c3e62704a00837993e8f1e86f2016a1c94e00d60a2217576e363c76f50f1",
        "index_digest": "sha256:0c93c3e62704a00837993e8f1e86f2016a1c94e00d60a2217576e363c76f50f1",
        "worktree_digest": "sha256:0c93c3e62704a00837993e8f1e86f2016a1c94e00d60a2217576e363c76f50f1",
        "untracked_digest": "absent"
      },
      {
        "path": "market-config.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:8a74d0a09a4459c680ea6c7c51b5ddf04adead1ff48e9d31fb3643f89d9398f3",
        "index_digest": "sha256:8a74d0a09a4459c680ea6c7c51b5ddf04adead1ff48e9d31fb3643f89d9398f3",
        "worktree_digest": "sha256:8a74d0a09a4459c680ea6c7c51b5ddf04adead1ff48e9d31fb3643f89d9398f3",
        "untracked_digest": "absent"
      },
      {
        "path": "market-reader.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:275d284f31241156e576c0411b58aa2bdb677f6d713b4375f10763e492c04e50",
        "index_digest": "sha256:275d284f31241156e576c0411b58aa2bdb677f6d713b4375f10763e492c04e50",
        "worktree_digest": "sha256:275d284f31241156e576c0411b58aa2bdb677f6d713b4375f10763e492c04e50",
        "untracked_digest": "absent"
      },
      {
        "path": "monitor-triggers.mjs",
        "object_kind": {
          "head": "absent",
          "index": "absent",
          "worktree": "absent",
          "untracked": "absent"
        },
        "state": "absent",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "absent",
        "index_digest": "absent",
        "worktree_digest": "absent",
        "untracked_digest": "absent"
      },
      {
        "path": "monitor.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:3383ee8bd5fcd7d9be58322740d9490235154bb72f57789b08b4a8588e9409c9",
        "index_digest": "sha256:3383ee8bd5fcd7d9be58322740d9490235154bb72f57789b08b4a8588e9409c9",
        "worktree_digest": "sha256:3383ee8bd5fcd7d9be58322740d9490235154bb72f57789b08b4a8588e9409c9",
        "untracked_digest": "absent"
      },
      {
        "path": "notification-dispatch.mjs",
        "object_kind": {
          "head": "absent",
          "index": "absent",
          "worktree": "absent",
          "untracked": "absent"
        },
        "state": "absent",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "absent",
        "index_digest": "absent",
        "worktree_digest": "absent",
        "untracked_digest": "absent"
      },
      {
        "path": "package.json",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:80a44824577f58f1a065a1e3367e99f839c0b4fdd9dcc9ed966f60978a5cf52b",
        "index_digest": "sha256:80a44824577f58f1a065a1e3367e99f839c0b4fdd9dcc9ed966f60978a5cf52b",
        "worktree_digest": "sha256:80a44824577f58f1a065a1e3367e99f839c0b4fdd9dcc9ed966f60978a5cf52b",
        "untracked_digest": "absent"
      },
      {
        "path": "presign-verify.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:3dda5fb11efe63b04cb434349d6aadb91eaa88fbab79f8a851c5893b08dc02ce",
        "index_digest": "sha256:3dda5fb11efe63b04cb434349d6aadb91eaa88fbab79f8a851c5893b08dc02ce",
        "worktree_digest": "sha256:3dda5fb11efe63b04cb434349d6aadb91eaa88fbab79f8a851c5893b08dc02ce",
        "untracked_digest": "absent"
      },
      {
        "path": "presigned-broadcast.mjs",
        "object_kind": {
          "head": "absent",
          "index": "absent",
          "worktree": "absent",
          "untracked": "absent"
        },
        "state": "absent",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "absent",
        "index_digest": "absent",
        "worktree_digest": "absent",
        "untracked_digest": "absent"
      },
      {
        "path": "presigned-store.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:8b6d686e213888d5fab4196accf278decdfeb03606e8038b5c0927f7de15f4e1",
        "index_digest": "sha256:8b6d686e213888d5fab4196accf278decdfeb03606e8038b5c0927f7de15f4e1",
        "worktree_digest": "sha256:8b6d686e213888d5fab4196accf278decdfeb03606e8038b5c0927f7de15f4e1",
        "untracked_digest": "absent"
      },
      {
        "path": "proxy-rpc.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:d557cf6f5f2c4ae3e59622eae0948e5cd5d4869b03f02dda5d580991ecedbc53",
        "index_digest": "sha256:d557cf6f5f2c4ae3e59622eae0948e5cd5d4869b03f02dda5d580991ecedbc53",
        "worktree_digest": "sha256:27eb05229d75359c2623e6a5f280d978082751af1bba3ba69a6a1b071575ed26",
        "untracked_digest": "absent"
      },
      {
        "path": "shared.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:1e30e85182d2bf81afc8d9cf08cd12a81ad12da6ed320ecccea8f63efe62f690",
        "index_digest": "sha256:1e30e85182d2bf81afc8d9cf08cd12a81ad12da6ed320ecccea8f63efe62f690",
        "worktree_digest": "sha256:24a896bf630ba4e1752871316d49a0812c77ea2dc880191ee16e5937e2adc36a",
        "untracked_digest": "absent"
      },
      {
        "path": "voip.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:1eb8a99809cdffb0418e7dbf68d9a8e19d74ee967b3911ddd7d24868c72cc726",
        "index_digest": "sha256:1eb8a99809cdffb0418e7dbf68d9a8e19d74ee967b3911ddd7d24868c72cc726",
        "worktree_digest": "sha256:1eb8a99809cdffb0418e7dbf68d9a8e19d74ee967b3911ddd7d24868c72cc726",
        "untracked_digest": "absent"
      },
      {
        "path": "webapp-server.mjs",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:47cf36fa1a51431659d5762ce9118a62f1a7db622886eef65b56eec8da80ce25",
        "index_digest": "sha256:47cf36fa1a51431659d5762ce9118a62f1a7db622886eef65b56eec8da80ce25",
        "worktree_digest": "sha256:ea477977d6b3a91b5b6455c55006f7327c1b510814396101299dc3a23dee3374",
        "untracked_digest": "absent"
      },
      {
        "path": "webapp.html",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:c3177b90a83417620ea906b76c85c70a7353819c0b181567206ef8d53e63f688",
        "index_digest": "sha256:c3177b90a83417620ea906b76c85c70a7353819c0b181567206ef8d53e63f688",
        "worktree_digest": "sha256:6734c32c4838617dabfe487389d7cd0f7969d113ee454a3d0a064031f0b3f08c",
        "untracked_digest": "absent"
      }
    ]
  },
  "open_questions": [
    "Production verification still needs the deployment-provided config/markets.json, real RPC/WSS endpoints and signed bundles.",
    "Recovery of an orphaned filesystem .lock after an OS hard-kill is deferred; this plan preserves the existing withFileLock primitive."
  ]
}
```

## 12. Assumptions, open questions and deferred work

Assumptions:

- Registry v2 readers tolerate optional lifecycle metadata; no persisted schema-version migration is needed.
- Configured market order is stable and acceptable as deterministic arbitration order.
- Existing receipt timeout (120 seconds) and recovery threshold (180 seconds) remain product defaults, but become named/injectable.
- A mined reverted transaction consumes the nonce, so sibling bundles of that nonce must not remain eligible.
- `withFileLock` remains the cross-process serialization primitive for this repository.

Open/deployment-dependent:

- Production proof requires the deployment-owned `config/markets.json`, real RPC/WSS endpoints and valid signed bundles.
- Confirm operational preference for alerting when ntfy fails but VoIP succeeds; this plan intentionally preserves ntfy quota so the next cycle can retry ntfy.

Deferred:

- Automatic reclamation of an orphaned `.lock` after an OS hard-kill.
- Distributed locking across hosts that do not share the registry filesystem.
- Registry v3 or historical migration tooling.
- More than nine configured markets.

## 13. Definition of done

- All confirmed audit findings have a production-code regression test.
- Concurrent processes cannot broadcast two markets with the same nonce in tests.
- Future bundles survive, ambiguous sends remain reserved, and final status requires a mined receipt.
- Scheduler tests prove union, all-dominance and trailing-run semantics.
- WSS tests prove single-active endpoint, failover, reconnect, five OR-filter subscriptions and cleanup.
- ntfy/VoIP tests prove independent attempts and ntfy-only quota accounting.
- Config accepts 1–9 markets, rejects 0/10+, defaults multiplier to 2 and has one validation implementation.
- UI and API deletion are explicitly market-scoped.
- Tests import production modules; duplicated selectors/watchers are removed.
- `npm test`, syntax checks, `git diff --check` and `docker compose config --quiet` pass.
- Deployment-only smoke checks are recorded with actual evidence or explicitly left as a release blocker.
- Documentation matches the final module boundaries and operational behavior.

