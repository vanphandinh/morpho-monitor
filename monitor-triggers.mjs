/** Lossless coalescing gate for polling and websocket triggers. */
export function createCheckScheduler(checkMarkets, { debounceMs = 3000, timers = globalThis, logger = console } = {}) {
  let pending = new Set();
  let allRequested = false;
  let running = false;
  let timer = null;
  let closed = false;

  const run = async () => {
    timer = null;
    if (closed || running || (!allRequested && pending.size === 0)) return;
    const ids = allRequested ? undefined : [...pending];
    pending = new Set();
    allRequested = false;
    running = true;
    try {
      await checkMarkets(ids);
    } catch (err) {
      // A failed cycle must never kill the loop (M5) and never surface as an
      // unhandled rejection: log per cycle and keep the trailing run.
      logger?.error?.(`[scheduler] check cycle failed (loop continues): ${err?.message || err}`);
    } finally {
      running = false;
      // Work received while active is deliberately a trailing run.
      if (!closed && (allRequested || pending.size)) schedule(0);
    }
  };
  const schedule = (delay = debounceMs) => {
    if (closed || timer !== null) return;
    timer = timers.setTimeout(() => { void run(); }, delay);
  };
  return {
    request(ids) {
      if (closed) return;
      if (ids == null) { allRequested = true; pending.clear(); }
      else if (!allRequested) for (const id of ids) pending.add(id);
      schedule();
    },
    async flush() { if (timer !== null) { timers.clearTimeout(timer); timer = null; } await run(); },
    close() { closed = true; if (timer !== null) timers.clearTimeout(timer); timer = null; pending.clear(); },
  };
}

/**
 * Connect exactly one WSS endpoint at a time with full resource ownership.
 *
 * Audit invariants (2026-09-23):
 * - A setup failure after some subscriptions succeeded closes every partial
 *   subscription AND the connection before advancing to the next URL.
 * - Error callbacks are fenced by a connection generation: a stale callback
 *   from an old endpoint can never trigger a second reconnect or a duplicate
 *   endpoint while one is active.
 * - A runtime failure rotates to the NEXT url (not always the first).
 * - When every url has failed, retry the whole set with bounded backoff;
 *   retry timers are cancelled on close. Polling remains the fallback.
 */
export function createWssWatcher({ urls, connect, eventNames, marketIds, onMarkets, logger = console, timers = globalThis, retryDelayMs = 30_000 }) {
  let active = null; // { connection, unwatchers, generation }
  let stopped = false;
  let generation = 0;
  let retryTimer = null;

  function closeActive() {
    if (!active) return;
    for (const unwatch of active.unwatchers) try { unwatch(); } catch { /* ignore */ }
    try { active.connection.close?.(); } catch { /* ignore */ }
    active = null;
  }

  function handleConnectionError(generationAtConnect) {
    // Generation fence: stale callbacks from a replaced endpoint are ignored.
    if (stopped || !active || active.generation !== generationAtConnect) return;
    const failedUrl = active.connection.url;
    logger.warn(`[WSS] endpoint ${failedUrl} failed; rotating`);
    closeActive();
    generation = generationAtConnect + 1; // invalidate the dead generation
    // Rotate relative to the FAILED endpoint: thử url KẾ TIẾP trước và bỏ url
    // đã chết khỏi lượt này. (audit 2026-09-24: urls.slice(1) luôn drop urls[0]
    // bất kể url nào fail ⇒ urls[i>0] fail sẽ bị thử lại ngay chính nó.)
    const idx = urls.indexOf(failedUrl);
    const remaining = idx === -1 ? urls.slice() : [...urls.slice(idx + 1), ...urls.slice(0, idx)];
    void start(generation, remaining);
  }

  async function attemptUrl(url, generationAtStart) {
    const connection = await connect(url);
    const unwatchers = [];
    // Generation fence for log callbacks: logs delivered by a replaced or
    // closed endpoint must never wake the scheduler (audit H1).
    const isCurrentGeneration = () => !stopped && generationAtStart === generation;
    try {
      for (const eventName of eventNames) {
        // A later watch throwing must not orphan earlier subscriptions.
        unwatchers.push(connection.watch(eventName, { id: marketIds }, (logs) => {
          if (!isCurrentGeneration()) return;
          onMarkets([...new Set(logs.map((log) => log.args?.id).filter(Boolean))]);
        }, () => handleConnectionError(generationAtStart)));
      }
    } catch (error) {
      for (const unwatch of unwatchers) try { unwatch(); } catch { /* ignore */ }
      try { connection.close?.(); } catch { /* ignore */ }
      throw error;
    }
    return { connection, unwatchers, generation: generationAtStart };
  }

  async function start(generationAtStart, remainingUrls) {
    if (stopped || generationAtStart !== generation) return false;
    const pool = remainingUrls ?? urls;
    for (const url of pool) {
      if (stopped || generationAtStart !== generation) return false;
      try {
        const established = await attemptUrl(url, generationAtStart);
        if (stopped || generationAtStart !== generation) {
          // A newer attempt or close() won the race — discard this connection.
          for (const unwatch of established.unwatchers) try { unwatch(); } catch { /* ignore */ }
          try { established.connection.close?.(); } catch { /* ignore */ }
          return false;
        }
        active = established;
        logger.log?.(`[WSS] connected ${url}`);
        return true;
      } catch (error) {
        logger.warn(`[WSS] ${url}: ${error.message}`);
      }
    }
    scheduleRetry(generationAtStart);
    return false;
  }

  function scheduleRetry(generationAtStart) {
    if (stopped || generationAtStart !== generation || retryTimer !== null) return;
    logger.warn(`[WSS] all endpoints failed; retrying in ${retryDelayMs / 1000}s`);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (!stopped && generationAtStart === generation) void start(generationAtStart, urls);
    }, retryDelayMs);
  }

  return {
    start: () => start(generation, urls),
    reconnect: async () => { if (stopped) return false; closeActive(); return start(generation, urls); },
    close() {
      stopped = true;
      if (retryTimer !== null) { timers.clearTimeout(retryTimer); retryTimer = null; }
      closeActive();
    },
    get activeUrl() { return active?.connection.url ?? null; },
  };
}
