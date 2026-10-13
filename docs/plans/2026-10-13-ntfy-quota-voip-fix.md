# Fix: independent VoIP alerts when ntfy quota is exhausted

## Scope and invariants

- Fix the confirmed risk in `monitor.mjs`: a quota check for ntfy currently gates both ntfy and VoIP.
- Test the production VoIP generation key instead of recreating its string in a test double.
- Keep presigned broadcast as the first I/O after market snapshots; no notification is awaited by the broadcast loop.
- Preserve ntfy's per-day quota, cross-day reservations, settlement accounting, cooldown and retry semantics.
- Preserve one monitor process and the existing registry format.

## Implementation sequence

1. **Reproduce:** Add a monitor-cycle test in which market A has unresolved ntfy from the previous quota day while market B enters the danger zone. Require B's VoIP alert immediately, no new ntfy request, and no repeated VoIP on B's next check. Verify broadcast still runs each time. Add a zero-quota case.
2. **Separate decisions:** Check trigger, cooldown and zone generation independently of ntfy's daily quota. Reserve quota only for real ntfy sends. Track VoIP attempts separately per market entry generation; never allow delayed ntfy completion to change the VoIP generation.
3. **Channel-aware dispatch:** Support a VoIP-only attempt without invoking ntfy or firing its settlement callback. Keep both channels concurrent when both are enabled; keep reporting ntfy settlement as soon as it finishes, even if VoIP remains pending.
4. **Production seam:** Extract the production sender and its in-flight VoIP key into an exported factory used by `main()` and unit/integration tests. Validate old-entry/re-entry and retry cases against this actual sender.
5. **Verify:** Run targeted Vitest first (including red-before-green evidence), then `npm run check`. Review changes for quotas, retries, re-entry deduplication, broadcast priority and memory cleanup. Refresh GitNexus and run `detect-changes --scope all` before commit.

## Acceptance criteria

- Quota `0` or fully reserved: eligible VoIP still starts, while ntfy never starts or reserves capacity.
- Pending ntfy from yesterday does not block VoIP for today's new entry; successful delivery is charged to the day it completes.
- Each market entry triggers at most one VoIP attempt, even across ntfy retries. Exit and re-entry allows another attempt, including while the earlier call is ringing.
- When ntfy quota becomes available during the same market entry, the pending ntfy alert can retry without redialing VoIP.
- All notification work stays backgrounded; broadcast is invoked before notification dispatch, and failures are observed.
