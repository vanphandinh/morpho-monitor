# GitNexus Engineering Plan

> Task: Close the remaining merge-readiness defects in the multi-market monitor branch without weakening nonce, receipt, WSS, notification, or market isolation invariants.
> Evidence verified at commit 24111bc0a235c670abb38674008d42aed52b8525; GitNexus 1.6.12 graph queried, but `status --json` returned only its header on this Windows host, so index freshness/analyzer provenance cannot be certified; current source is authoritative.
> Evidence provenance schema 2; global dirty digest 5dba215b65bf266f3ff92db9ab2db81e02d707054f52e96eea2fa797cd096fa1; cited-path manifest 16 sorted entries; exact generated plan path excluded.
> Scope: implementation plan only. The current dirty worktree belongs to the user. No production/test/config edits, commit, push, rebase, or PR in this planning run.
>
> **STATUS 2026-09-23: IMPLEMENTED.** All six change groups landed in the working tree (uncommitted). Verification evidence: `npm test` = 16 files, 280 tests, all passing; `node --check` passed for every changed/new `.mjs`; cross-process exclusivity proven by real child processes (`__tests__/presigned-cross-process.test.mjs`, `__tests__/two-process-race.test.mjs`, at most one raw broadcast asserted via a shared append-only send log). Two structural deviations from this plan, both additive: (1) the HTTP handler was extracted to `webapp-handler.mjs` so tests exercise the real handler without startup side effects; (2) user-origin registry mutations are guarded by an active-claim signature comparison (id/status/nonce/txHash/tier digest) rather than by vetoing specific opcodes — strictly stronger than the planned field check. Deployment smoke remains a separate release blocker.

## 1. Objective

Make `feat/multi-market-monitor` safe to merge by closing confirmed state-lifecycle, WSS-recovery, HTTP-validation, and regression-coverage gaps. Keep deployment-only checks separately blocked until production-owned RPC/WSS/config/credentials and real signed bundles are available. Every regression test for these fixes must import the production module or exercise its real HTTP process.

## 2. Current Behaviour

- [verified] `updateRegistry` holds a cross-process `wx` lock around read → mutate → atomic write (`presigned-store.mjs:30-37`, `shared.mjs:326-345`), but the mutator can overwrite or remove a claimed bundle.
- [verified] `broadcastEligible` stores `broadcasting` and a tx hash before RPC I/O, but recovery selects a raw transaction by non-unique tier label (`presigned-broadcast.mjs:28-34`); pending-nonce advancement expires lower-nonce `broadcasting` without receipt proof (`:17-22`). The terminal transition checks only truthiness of a receipt object (`:38-50`).
- [verified] Webapp DELETE can remove a whole active bundle or one of its tiers (`webapp-server.mjs:287-305`); POST can replace an active bundle with a fresh object (`:345-425`). Missing/unknown market on GET/DELETE becomes HTTP 500 (`:216-223`, `:287-317`).
- [verified] WSS setup uses `eventNames.map`; a later watch failure leaves earlier subscriptions/connection unclosed, and `reconnect()` restarts at the first URL (`monitor-triggers.mjs:43-56`). After all URLs fail there is no timed retry. `startWss` probes `getChainId` before handing the connection to watcher cleanup (`monitor.mjs:73-79`).
- [verified] Current lifecycle concurrency test uses an in-memory promise queue, not two processes (`__tests__/presigned-lifecycle.test.mjs:6-24`). In-scope older tests still copy broadcaster/expiration/WSS logic (`__tests__/presign-broadcast.test.mjs:18-81`, `__tests__/expire-bundle.test.mjs:24-81`, `__tests__/wss-watcher.test.mjs:40-179`).

## 3. Relevant Architecture

- [verified] One lender has market-keyed registry bundles, while nonce ownership is lender-wide. The webapp and monitor are distinct processes sharing the same registry file and lock (`presigned-store.mjs`, `webapp-server.mjs`, `monitor.mjs`).
- [verified] WSS only triggers `scheduler.request(ids)`; HTTP polling/read remains the decision path (`monitor.mjs:73-87`, `monitor-triggers.mjs:2-35`). Scheduler coalesces market IDs and queues a trailing run; changes must preserve both behaviours.
- [verified] `requireConfiguredMarket` normalizes only explicit configured 32-byte market IDs (`market-config.mjs:50-59`). Market key isolation is part of the API contract.

## 4. GitNexus Findings

- [graph] `context updateRegistry -f presigned-store.mjs`: direct callers are production `presigned-broadcast.mjs:broadcastEligible` and `webapp-server.mjs:server`; monitor also references it as a callable value. Its dependencies are `readRegistry`, `writeRegistry`, and `withFileLock`. The result warns that callback dispatch makes the impact a lower bound.
- [graph] `impact updateRegistry -f presigned-store.mjs -d upstream --depth 3 --include-tests`: CRITICAL, three depth-1 dependents (monitor wrapper, production broadcaster, webapp server), then `checkMarkets` and scheduler/main. Plan covers all three direct consumers; keep the shared API contract compatible.
- [graph] `context createWssWatcher -f monitor-triggers.mjs` and upstream `impact --depth 3`: sole direct caller `monitor.mjs:startWss`; next `main`. This isolates the WSS change but requires a monitor integration check.
- [inferred] Source-confirmed overwrites/deletes bypass the intended durable claim even though the file lock serializes each mutation. Locking alone cannot enforce lifecycle validity.

## 5. Statement-Level PDG Findings

- [graph] `impact broadcastEligible -f presigned-broadcast.mjs --mode pdg --line 33 -d upstream --depth 2` reaches nonce-read/claim statements at lines 16-17; its reported monitor relations are explicitly callgraph bridges, not statement-level proof. [verified] The source ordering is nonce read → locked claim → RPC → locked finalization (`presigned-broadcast.mjs:16-51`). Keep network I/O outside the file lock, but never release/replace a claim on ambiguous RPC results.
- [graph] PDG slice from `createWssWatcher` line 48 reaches `start`, `reconnect`, and `closeActive`; it is truncated and has ambiguous same-line projections. [verified] Source shows `active` is assigned only after `map` completes, so partially installed subscriptions have no cleanup owner (`monitor-triggers.mjs:43-56`). Implement cleanup with a local per-attempt resource owner and a serialized reconnect generation.
- [graph] PDG probe at `updateRegistry` line 33 returned `pdg-no-block-at-line`; no statement edge is claimed. [verified] `mutate(registry)` still executes inside `withFileLock`, before `writeRegistry` (`presigned-store.mjs:30-36`). Use source-level control-flow and tests for this invariant.

## 6. Proposed Changes

1. **Registry lifecycle guard** (`presigned-store.mjs:updateRegistry`, `webapp-server.mjs:server`): Under the same file lock, reject user-origin mutations that delete or modify any `broadcasting`/`submitted` bundle or change a nonce-wide active claim. Prefer a narrow store API or invariant validator comparing pre/post active claims; do not prevent the monitor's verified terminal transition. Reject submitted history deletion until an explicit retention policy exists. Ensure POST accepts only verified pending bundle data and does not import client-controlled lifecycle fields. Return explicit conflict (HTTP 409) for active-claim edits; keep market-keyed delete and tier removal for safe pending bundles.
2. **Receipt-grounded nonce lifecycle** (`presigned-broadcast.mjs:broadcastEligible`): Reconcile every existing `broadcasting` reservation by its persisted hash before any nonce-based expiration/claim choice. Pending nonce greater than the bundle nonce is not receipt evidence. Never reset an ambiguous claim to pending, never expire it solely by age/nonce, and never mark `submitted`/`failed` without a mined receipt for that exact transaction (hash + mined block identity). Keep future nonce pending. If receipt unavailable/mismatched, leave `broadcasting` and surface a diagnostic; only a verified mined outcome may expire same-nonce sibling candidates.
3. **Exact recovery identity** (`presigned-broadcast.mjs:broadcastEligible`, registry shape): Persist the exact selected signed transaction or a stable tier identifier plus immutable hash binding at claim time; verify `keccak256(rawTx) === persisted txHash` before any rebroadcast. Duplicate labels, reordered tiers, missing/edited raw data, or an HTTP replacement must never choose a different transaction. A malformed legacy `broadcasting` record stays reserved and reports manual reconciliation; do not guess a raw transaction or silently unlock it.
4. **WSS resource ownership and failover** (`monitor-triggers.mjs:createWssWatcher`, `monitor.mjs:startWss`): Close every successful partial subscription and connection on setup failure; clean up failed `getChainId` probes. Serialize concurrent error callbacks, ignore stale callbacks using connection generation, close the old endpoint before opening the next, rotate to a different URL on runtime failure, retry all-failed sets with bounded backoff, and cancel retry timers on shutdown. Keep exactly one active endpoint with five event subscriptions and preserve market-ID filtering. Polling remains operational throughout outages.
5. **API input errors** (`webapp-server.mjs:server`): Validate missing/unknown market and tier index before mutation/response side effects; return 400 for malformed selection, 404 or 400 consistently for unknown configured market, 409 for active claim. Server/storage errors remain 500. No branch may delete another market's key.
6. **Test and evidence cleanup** (listed tests, `CLAUDE.md`, `docs/plans/2026-09-22-multi-market-monitor.md`): Replace in-scope copied logic with production imports or black-box HTTP. Preserve unrelated historical tests unless they make an in-scope claim. Correct stale architecture/test guidance and append only checks actually executed. Do not convert deployment-only smoke work into a claimed pass.

## 7. Implementation Sequence

1. Re-anchor the dirty worktree and read `AGENTS.md`/`CLAUDE.md` plus the original audit plan. Before editing each symbol, run the `gitnexus-work` impact check; preserve all user changes. Add failing lifecycle tests against production broadcaster/store for pending nonce increase, RPC timeout, receipt mismatch/unmined shape, duplicate tier labels, and future nonce.
2. Add a real two-process file-lock/claim test using a temporary registry and child Node processes that import `presigned-store.mjs` and `presigned-broadcast.mjs`. Use deterministic fake RPC and a startup barrier; assert one nonce claimant/serialized raw broadcast, durable reservation after ambiguity, and no cross-market deletion. Run targeted tests; ensure no test uses production credentials or writes live registry.
3. Implement exact claim identity and receipt-first reconciliation. Make old/partial `broadcasting` records fail closed. Run lifecycle and broadcaster tests after this group; preserve the lock boundary around all shared-state decisions.
4. Add production-backed HTTP tests for pending edit/delete, active whole-bundle/tier edit/delete, same-nonce different-market claims, and missing/unknown market. Implement the store/API guard and 400/409 mapping. Re-run targeted HTTP, market-config, and lifecycle tests. Use a testable handler or isolated spawned server with temporary config/registry; never touch `data/presigned.json`.
5. Add WSS tests importing `createWssWatcher`: second subscription throws; probe fails; simultaneous/stale `onError`; primary failure rotates to secondary; all endpoints fail then reconnect; shutdown during in-flight connect; at most one active URL and five subscriptions. Implement watcher/monitor cleanup; verify scheduler still coalesces and retains trailing work. Run WSS/scheduler tests.
6. Replace or retire in-scope copied lifecycle/WSS tests, update docs and acceptance evidence, then run the complete verification gate. Review the full local diff with `gitnexus-review`, fix valid findings, and repeat affected tests plus full gate. Do not commit/push/rebase/create PR.

## 8. Test Strategy

- [verified] Existing `npm test` invokes `vitest run` (`package.json:6-13`). Add regression cases before or alongside each fix, importing production modules.
- `__tests__/presigned-lifecycle.test.mjs`: real registry in temporary directory; separate processes racing same nonce; timeout or receipt lookup error followed by pending nonce advancement retains `broadcasting`; only matching mined receipt finalizes; reverted mined receipt becomes `failed`; future nonce stays pending; duplicate label/reordered/edited tiers never redirect rebroadcast.
- `__tests__/presign-broadcast.test.mjs`, `__tests__/expire-bundle.test.mjs`: retire/replace copied implementation of in-scope lifecycle rules with direct production calls; remove assertions for obsolete v1 or age-based reset semantics rather than making production conform to copied test code.
- `__tests__/wss-watcher.test.mjs`: production watcher and scheduler, fake connections/timers, assert partial cleanup, runtime failover, retry, stale-error isolation, shutdown cancellation, one endpoint, market-specific IDs, and a trailing scheduler run while busy.
- New `__tests__/presigned-api.test.mjs` (or equivalent production-handler test): authenticated real route with temporary registry/config; pending market-scoped delete works, active edit/delete returns 409 without changing bytes, unknown/missing market returns client error, another market remains unchanged.
- After each group run relevant `npx vitest run <files>`; final gate: `npm test`, `node --check` for every new/modified `.mjs`, `git diff --check`, `docker compose config --quiet`, safe local API/WSS/lock smoke tests. Record exact commands/results and environment. No live broadcast in tests.

## 9. Risk and Impact Analysis

- [graph] The `updateRegistry` impact is CRITICAL and lower-bound because a caller passes it as a value. Direct dependents are monitor wrapper, broadcaster, and webapp; test them together after store contract changes.
- [verified] The registry is a shared file; a process crash can leave `.lock` behind (`shared.mjs:326-345`). Do not implement age-based lock theft without a separate ownership/liveness design: it could violate cross-process exclusivity. Document manual recovery as operational work if observed.
- [inferred] Claim persistence/receipt checks need backwards-compatible handling of existing `broadcasting` records; fail closed and flag manual reconciliation, never auto-clear uncertain state.
- [inferred] WSS reconnect races can create duplicate subscriptions; use a single in-flight transition and generation fence, plus leak counters in tests. Bounded retry prevents a permanent WSS outage from removing polling fallback.
- [verified] `CLAUDE.md:53-55,100-108,130-157` contains stale descriptions of current monitor and duplicated tests; update only touched guidance. The acceptance record in `docs/plans/2026-09-22-multi-market-monitor.md:89-99` must separate past measured results from newly verified checks.

## 10. Files Expected to Change

| File | Symbols | Reason |
| --- | --- | --- |
| `presigned-broadcast.mjs` | `broadcastEligible` | Receipt-first reconciliation, immutable raw transaction identity, safe terminal states |
| `presigned-store.mjs` | `updateRegistry`, narrow lifecycle guard/API | Cross-process invariant enforcement inside lock |
| `webapp-server.mjs` | `server` request handler | Reject active mutations, market validation/status codes |
| `monitor-triggers.mjs` | `createWssWatcher` | Owned subscriptions, serialized failover/retry |
| `monitor.mjs` | `startWss` | Probe-failure cleanup and watcher integration |
| `__tests__/presigned-lifecycle.test.mjs` | broadcaster/store scenarios | Cross-process and receipt/nonce regression |
| `__tests__/presign-broadcast.test.mjs`, `__tests__/expire-bundle.test.mjs` | copied lifecycle tests | Production-backed replacement/removal |
| `__tests__/wss-watcher.test.mjs` | watcher/scheduler tests | Production-backed failure-path coverage |
| `__tests__/presigned-api.test.mjs` (new) | HTTP cases | Real route market-scope and conflict checks |
| `CLAUDE.md`, `docs/plans/2026-09-22-multi-market-monitor.md` | guidance/evidence | Accurate architecture and observed acceptance results |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Close the remaining multi-market merge-readiness defects without weakening durable nonce/WSS/market invariants."
  acceptance_criteria:
    - "No user API mutation can erase or alter an active claim, even across processes."
    - "Broadcasting persists across RPC ambiguity and pending nonce advancement; only exact mined receipt finalizes."
    - "WSS owns one endpoint, cleans partial setup, rotates and retries; polling/scheduler lose no events."
    - "In-scope regression tests import production modules or exercise the production HTTP server."
  evidence_provenance: {"schema_version":2,"head_commit":"24111bc0a235c670abb38674008d42aed52b8525","generated_plan_path":"docs/plans/2026-09-23-gitnexus-plan-merge-readiness-audit-fixes.md","global_dirty_digest":{"algorithm":"sha256","canonicalization":"gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records","value":"5dba215b65bf266f3ff92db9ab2db81e02d707054f52e96eea2fa797cd096fa1"},"cited_path_manifest":[{"path":"CLAUDE.md","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"unstaged","rename_from":null,"rename_to":null,"head_digest":"sha256:fd38752b9c0d4433928b7236a288536db214e71ddd723777d36f93678f760d34","index_digest":"sha256:fd38752b9c0d4433928b7236a288536db214e71ddd723777d36f93678f760d34","worktree_digest":"sha256:37588cae0d4dfad424562ceb5ca491bd5bb67297b3854fcc3d425a89b9b49f20","untracked_digest":"absent"},{"path":"__tests__/expire-bundle.test.mjs","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"clean","rename_from":null,"rename_to":null,"head_digest":"sha256:d969b95a465bc34b3742436d88b0ddde15d90abc483719111a838595aee6f660","index_digest":"sha256:d969b95a465bc34b3742436d88b0ddde15d90abc483719111a838595aee6f660","worktree_digest":"sha256:d969b95a465bc34b3742436d88b0ddde15d90abc483719111a838595aee6f660","untracked_digest":"absent"},{"path":"__tests__/presign-broadcast.test.mjs","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"clean","rename_from":null,"rename_to":null,"head_digest":"sha256:ea60277797d217f2077dadda0a26eb18be91f0f76fdc0e12b992a19c9772bd10","index_digest":"sha256:ea60277797d217f2077dadda0a26eb18be91f0f76fdc0e12b992a19c9772bd10","worktree_digest":"sha256:ea60277797d217f2077dadda0a26eb18be91f0f76fdc0e12b992a19c9772bd10","untracked_digest":"absent"},{"path":"__tests__/presigned-api.test.mjs","object_kind":{"head":"absent","index":"absent","worktree":"absent","untracked":"absent"},"state":"absent","rename_from":null,"rename_to":null,"head_digest":"absent","index_digest":"absent","worktree_digest":"absent","untracked_digest":"absent"},{"path":"__tests__/presigned-lifecycle.test.mjs","object_kind":{"head":"absent","index":"absent","worktree":"absent","untracked":"regular"},"state":"untracked","rename_from":null,"rename_to":null,"head_digest":"absent","index_digest":"absent","worktree_digest":"absent","untracked_digest":"sha256:a884b16bbcaa5a71f3738fbfd8ebd3b4413019215f89a2be824331f0b078eaa7"},{"path":"__tests__/webapp.test.mjs","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"clean","rename_from":null,"rename_to":null,"head_digest":"sha256:60ab53d255ae10669246b8eb4f53efebb183447e29360ed0fa3bd3248f324c35","index_digest":"sha256:60ab53d255ae10669246b8eb4f53efebb183447e29360ed0fa3bd3248f324c35","worktree_digest":"sha256:60ab53d255ae10669246b8eb4f53efebb183447e29360ed0fa3bd3248f324c35","untracked_digest":"absent"},{"path":"__tests__/wss-watcher.test.mjs","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"unstaged","rename_from":null,"rename_to":null,"head_digest":"sha256:47a83510977d4e22327757975c67d051fd2355288237c05e61aa5f7872b2b999","index_digest":"sha256:47a83510977d4e22327757975c67d051fd2355288237c05e61aa5f7872b2b999","worktree_digest":"sha256:d892d44785545c35b01cebd77ace56455e3011895d07d645de0f0c0f1c50e366","untracked_digest":"absent"},{"path":"docs/plans/2026-09-22-multi-market-monitor.md","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"unstaged","rename_from":null,"rename_to":null,"head_digest":"sha256:e9b1bfc43b0fdd17b78132a740ff20e8cd1a8791693678c190bea6678a5a41d1","index_digest":"sha256:e9b1bfc43b0fdd17b78132a740ff20e8cd1a8791693678c190bea6678a5a41d1","worktree_digest":"sha256:d90d480b5d9b5516b7a2b63ba945dd13c44d287d2121aade13aa8b71c93b115c","untracked_digest":"absent"},{"path":"market-config.mjs","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"unstaged","rename_from":null,"rename_to":null,"head_digest":"sha256:8a74d0a09a4459c680ea6c7c51b5ddf04adead1ff48e9d31fb3643f89d9398f3","index_digest":"sha256:8a74d0a09a4459c680ea6c7c51b5ddf04adead1ff48e9d31fb3643f89d9398f3","worktree_digest":"sha256:d76f92482b58c0f65925977df562234e53131f73165149ffb6bc96300d745f38","untracked_digest":"absent"},{"path":"monitor-triggers.mjs","object_kind":{"head":"absent","index":"absent","worktree":"absent","untracked":"regular"},"state":"untracked","rename_from":null,"rename_to":null,"head_digest":"absent","index_digest":"absent","worktree_digest":"absent","untracked_digest":"sha256:3f50fd62a6e604c0ff33a2ab6949351077ac63a68ff244b515d02619e96e513c"},{"path":"monitor.mjs","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"unstaged","rename_from":null,"rename_to":null,"head_digest":"sha256:3383ee8bd5fcd7d9be58322740d9490235154bb72f57789b08b4a8588e9409c9","index_digest":"sha256:3383ee8bd5fcd7d9be58322740d9490235154bb72f57789b08b4a8588e9409c9","worktree_digest":"sha256:a9186992ea594a6fac773a6377ae161124e710a01393a0509ec78c281a7053ff","untracked_digest":"absent"},{"path":"package.json","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"clean","rename_from":null,"rename_to":null,"head_digest":"sha256:80a44824577f58f1a065a1e3367e99f839c0b4fdd9dcc9ed966f60978a5cf52b","index_digest":"sha256:80a44824577f58f1a065a1e3367e99f839c0b4fdd9dcc9ed966f60978a5cf52b","worktree_digest":"sha256:80a44824577f58f1a065a1e3367e99f839c0b4fdd9dcc9ed966f60978a5cf52b","untracked_digest":"absent"},{"path":"presigned-broadcast.mjs","object_kind":{"head":"absent","index":"absent","worktree":"absent","untracked":"regular"},"state":"untracked","rename_from":null,"rename_to":null,"head_digest":"absent","index_digest":"absent","worktree_digest":"absent","untracked_digest":"sha256:199742dd4d602a29ba4dbeabc220f245f503ff5544812efcbdb4e2a4c6d02914"},{"path":"presigned-store.mjs","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"clean","rename_from":null,"rename_to":null,"head_digest":"sha256:8b6d686e213888d5fab4196accf278decdfeb03606e8038b5c0927f7de15f4e1","index_digest":"sha256:8b6d686e213888d5fab4196accf278decdfeb03606e8038b5c0927f7de15f4e1","worktree_digest":"sha256:8b6d686e213888d5fab4196accf278decdfeb03606e8038b5c0927f7de15f4e1","untracked_digest":"absent"},{"path":"shared.mjs","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"unstaged","rename_from":null,"rename_to":null,"head_digest":"sha256:1e30e85182d2bf81afc8d9cf08cd12a81ad12da6ed320ecccea8f63efe62f690","index_digest":"sha256:1e30e85182d2bf81afc8d9cf08cd12a81ad12da6ed320ecccea8f63efe62f690","worktree_digest":"sha256:dc2248b9b44ce9075c4f15ca6cdc2b93b6f42cebad81485da6ace4850524108a","untracked_digest":"absent"},{"path":"webapp-server.mjs","object_kind":{"head":"regular","index":"regular","worktree":"regular","untracked":"absent"},"state":"unstaged","rename_from":null,"rename_to":null,"head_digest":"sha256:47cf36fa1a51431659d5762ce9118a62f1a7db622886eef65b56eec8da80ce25","index_digest":"sha256:47cf36fa1a51431659d5762ce9118a62f1a7db622886eef65b56eec8da80ce25","worktree_digest":"sha256:273cc284aac0451b37e540d20bf736df5cb75c1059e96024072777049e958310","untracked_digest":"absent"}]}
  primary_symbols:
    - { symbol: "updateRegistry", file: "presigned-store.mjs", lines: "30-37", role: "cross-process mutation boundary" }
    - { symbol: "broadcastEligible", file: "presigned-broadcast.mjs", lines: "16-53", role: "nonce claim and receipt lifecycle" }
    - { symbol: "server", file: "webapp-server.mjs", lines: "110-456", role: "bundle mutation API" }
    - { symbol: "createWssWatcher", file: "monitor-triggers.mjs", lines: "40-58", role: "WSS endpoint lifecycle" }
  related_symbols:
    - { symbol: "withFileLock", relationship: "CALLED_BY updateRegistry", relevance: "exclusive cross-process write lock" }
    - { symbol: "startWss", relationship: "CALLS createWssWatcher", relevance: "connection probe and scheduler bridge" }
    - { symbol: "checkMarkets", relationship: "CALLS broadcastEligible", relevance: "monitor downstream consumer" }
  execution_path:
    - "webapp or monitor calls updateRegistry; lock serializes registry mutation"
    - "monitor reconciles active claims, chooses same-nonce pending candidate, persists exact claim, then performs RPC I/O"
    - "only matching mined receipt permits terminal transition and same-nonce sibling expiration"
    - "WSS event requests market-specific or all-market scheduler run; HTTP reads make decisions"
  pdg_constraints:
    - { description: "Claim transition precedes RPC I/O", affected_statements: ["presigned-broadcast.mjs:17", "presigned-broadcast.mjs:28", "presigned-broadcast.mjs:42"], implementation_consequence: "do not put RPC under lock or release claim on timeout" }
    - { description: "Subscription map can throw before active assignment", affected_statements: ["monitor-triggers.mjs:48", "monitor-triggers.mjs:49", "monitor-triggers.mjs:51"], implementation_consequence: "hold local connection/unwatchers and clean them on every failure" }
  architectural_patterns:
    - { pattern: "exclusive file lock plus atomic rename", example_location: "presigned-store.mjs:updateRegistry", usage_guidance: "guard lifecycle in the same lock" }
    - { pattern: "WSS trigger, HTTP source of truth", example_location: "monitor.mjs:startWss", usage_guidance: "retain polling during WSS outages" }
  files_to_modify:
    - { file: "presigned-broadcast.mjs", symbols: ["broadcastEligible"], intended_change: "receipt-first nonce lifecycle and exact signed transaction recovery" }
    - { file: "presigned-store.mjs", symbols: ["updateRegistry"], intended_change: "locked lifecycle guard" }
    - { file: "webapp-server.mjs", symbols: ["server"], intended_change: "reject active edits and bad market input" }
    - { file: "monitor-triggers.mjs", symbols: ["createWssWatcher"], intended_change: "owned setup, failover, retry" }
    - { file: "monitor.mjs", symbols: ["startWss"], intended_change: "cleanup failed connection probe" }
    - { file: "__tests__/presigned-lifecycle.test.mjs", symbols: [], intended_change: "cross-process and receipt tests" }
    - { file: "__tests__/wss-watcher.test.mjs", symbols: [], intended_change: "production watcher tests" }
    - { file: "__tests__/presigned-api.test.mjs", symbols: [], intended_change: "production HTTP route tests" }
    - { file: "CLAUDE.md", symbols: [], intended_change: "correct touched guidance" }
    - { file: "docs/plans/2026-09-22-multi-market-monitor.md", symbols: [], intended_change: "update only executed acceptance evidence" }
  tests:
    - { file: "__tests__/presigned-lifecycle.test.mjs", scenarios: ["two processes race same nonce -> one claim", "RPC timeout + pending nonce increase -> broadcasting remains", "matching mined receipt -> terminal; no receipt -> broadcasting", "duplicate tier labels or mutated raw -> never rebroadcast different tx"] }
    - { file: "__tests__/wss-watcher.test.mjs", scenarios: ["partial watch throw -> cleanup", "primary runtime error -> secondary active", "all fail -> bounded retry", "stale callback or close -> no duplicate endpoint"] }
    - { file: "__tests__/presigned-api.test.mjs", scenarios: ["pending market-scoped DELETE works", "active POST/DELETE -> 409 and unchanged registry", "missing/unknown market -> client error"] }
  verification_commands:
    - "npm test"
    - "node --check <each new or modified .mjs>"
    - "git diff --check"
    - "docker compose config --quiet"
  risks:
    - "Legacy broadcasting records may not have immutable raw identity; fail closed and require manual reconciliation."
    - "Do not steal stale file locks by age without ownership proof."
    - "WSS error callbacks race during failover; generation fence required."
  assumptions:
    - "Check before implementation that viem receipt fields include blockHash, blockNumber, and transactionHash for the installed version; use production fixture shape in tests."
    - "Check whether production registry contains broadcasting records lacking immutable tx identity before deploying schema extension."
    - "Check current GitNexus index freshness on a supported host before relying on graph-only blast-radius claims."
  open_questions:
    - "What operator-approved reconciliation process handles a permanently ambiguous or replaced transaction? Until decided, preserve broadcasting and block conflicting user edits."
    - "Are production-owned RPC/WSS, config, credentials, and real signed bundles available for deployment smoke? If not, deploy remains blocked, independently of merge readiness."
  avoid:
    - "Do not repeat full repository discovery; re-verify only drifted cited evidence."
    - "Do not change unrelated user work, commit, push, rebase, or create a PR."
    - "Do not expire a future nonce, clear broadcasting on timeout/pending nonce, or finalize without matching mined receipt."
    - "Do not replace production-backed tests with copied implementation logic."
```

## 12. Assumptions and Open Questions

- [assumed] A `viem` mined receipt provides transaction hash and block identity; verify against installed runtime/docs before selecting exact validation fields. Do not equate an arbitrary truthy test object with mined proof.
- [assumed] Existing production registry may contain old `broadcasting` records without immutable raw identity. Inspect it with production owner before deploy; retain reservation and require manual reconciliation rather than guessing.
- [assumed] GitNexus CLI graph is useful but `status --json` did not certify freshness/analyzer provenance on Windows; recheck on a supported host. Source-backed findings remain valid at the pinned working-tree digest.
- Open: Decide an operator-approved path for permanently ambiguous/replaced transactions and stale lock recovery. No automatic expiry/lock theft in this fix.
- Open: Production-owned markets config, RPC/WSS access, credentials, and a real signed bundle are needed for deployment smoke; absence blocks deploy, not necessarily merge after local regression and review gates pass.
- Deferred: General browser `__tests__/webapp.test.mjs` duplicate pure helpers are outside this lifecycle/WSS/API fix unless an in-scope UI change needs them.

## 13. Definition of Done

- Every planned symbol edit has a preceding `gitnexus-work` impact check; each group passes relevant production-backed regression tests. Existing user changes remain intact.
- Two actual Node processes cannot both claim/broadcast different transactions for the same lender nonce; active claims cannot be overwritten, tier-edited, or deleted via webapp. DELETE is always market-scoped.
- RPC timeout, receipt lookup failure, no receipt, hash mismatch, or pending nonce advancement retain `broadcasting`; no future nonce expires; only a matching mined success/revert receipt finalizes and then handles same-nonce siblings.
- WSS has at most one active endpoint, cleans partial connection/subscription resources, rotates on runtime failure, retries after all endpoints fail, and shuts down without retry leaks. Scheduler still runs trailing/all-market work, ntfy and VoIP remain independent.
- `npm test`, `node --check` for all new/modified `.mjs`, `git diff --check`, `docker compose config --quiet`, and safe local smoke tests pass; evidence records real commands/results only. Run `gitnexus-review` on the full change set, fix valid findings, and rerun verification.
- Merge verdict is separate from deploy verdict. Deployment-only RPC/WSS/config/credential/real-bundle smoke remains an explicit release blocker until genuinely performed; no live broadcast is claimed from local mocks.
