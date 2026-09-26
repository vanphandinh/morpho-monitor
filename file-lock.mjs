/**
 * Cross-process file lock — tách khỏi shared.mjs (audit P1.4).
 *
 * Chỉ phụ thuộc node:fs/node:os, không chạm config, nên test được mà không kéo
 * theo env. Dùng cho `data/presigned.json` (webapp ↔ monitor).
 */

/** Error code: the lock was still held after the full retry budget. */
export const LOCK_STALE = "LOCK_STALE";

/** Best-effort holder metadata written inside the lock file. */
function readLockHolder(fs, lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Cross-process file lock for presigned.json (webapp ↔ monitor).
 *
 * Uses exclusive create (`wx`) + retry and writes `{ pid, host, createdAt }`
 * into the lock so a leftover lock (SIGKILL/OOM/`docker restart` in the middle
 * of a mutation, which skips the `finally` unlink) is diagnosable.
 *
 * Never steals a lock it did not create (fail closed): after the retry budget
 * it throws an error with code LOCK_STALE carrying the holder info, the lock
 * age and the manual recovery command. The happy path always releases the
 * lock, and the lock is released even when `fn` throws.
 */
export async function withFileLock(lockPath, fn, { retries = 50, delayMs = 20 } = {}) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  for (let i = 0; i < retries; i++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    try {
      // Holder metadata is best-effort: a failed write must not break the lock.
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString() }));
      } catch { /* ignore */ }
      return await fn();
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
  const holder = readLockHolder(fs, lockPath);
  const parsedAge = holder?.createdAt ? Date.now() - Date.parse(holder.createdAt) : NaN;
  const ageMs = Number.isFinite(parsedAge) ? parsedAge : null;
  const err = new Error(
    `Could not acquire lock after ${retries} attempts (~${retries * delayMs}ms): ${lockPath}\n` +
    `  Holder: ${holder ? `pid=${holder.pid ?? "?"} host=${holder.host ?? "?"} since=${holder.createdAt ?? "?"}` : "unknown (lock file empty/unreadable)"}\n` +
    `  Lock age: ${ageMs === null ? "unknown" : `${Math.round(ageMs / 1000)}s`}\n` +
    `  Nếu chắc chắn không còn process nào giữ lock (SIGKILL/OOM/docker restart giữa mutation): rm '${lockPath}' rồi restart service.`
  );
  err.code = LOCK_STALE;
  err.lockPath = lockPath;
  err.holder = holder;
  err.ageMs = ageMs;
  throw err;
}
