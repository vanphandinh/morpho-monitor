/**
 * H4 (B3): cross-process lock của shared.mjs.
 *
 * Lock kẹt vĩnh viễn khi process bị SIGKILL/OOM/`docker restart` giữa mutation
 * (finally không chạy). Hướng xử lý đã chốt: ghi metadata holder vào lock, hết
 * retry thì ném LOCK_STALE kèm holder + tuổi lock + lệnh khôi phục — KHÔNG tự
 * phá lock (không steal).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock, LOCK_STALE } from "../file-lock.mjs";

function tempLockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-lock-"));
  return { dir, lockPath: path.join(dir, "presigned.json.lock") };
}

describe("withFileLock", () => {
  it("ghi metadata holder khi đang giữ lock và luôn giải phóng sau mutation", async () => {
    const { lockPath } = tempLockPath();
    let observed = null;
    await withFileLock(lockPath, async () => {
      observed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      return "done";
    }, { retries: 3, delayMs: 5 });
    expect(observed.pid).toBe(process.pid);
    expect(typeof observed.host).toBe("string");
    expect(Number.isFinite(Date.parse(observed.createdAt))).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false); // không để lại lock
  });

  it("giải phóng lock khi mutation throw (finally)", async () => {
    const { lockPath } = tempLockPath();
    await expect(withFileLock(lockPath, async () => { throw new Error("mutate boom"); }, { retries: 3, delayMs: 5 }))
      .rejects.toThrow("mutate boom");
    expect(fs.existsSync(lockPath)).toBe(false);
    // Lock đã được nhả thật: lần acquire kế tiếp chạy ngay.
    await expect(withFileLock(lockPath, async () => "ok", { retries: 3, delayMs: 5 })).resolves.toBe("ok");
  });

  it("lock có sẵn → LOCK_STALE kèm holder info + tuổi lock + lệnh khôi phục, KHÔNG phá lock", async () => {
    const { lockPath } = tempLockPath();
    const holder = { pid: 999999, host: "dead-host", createdAt: new Date(Date.now() - 60_000).toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(holder));

    const err = await withFileLock(lockPath, async () => "never", { retries: 2, delayMs: 5 }).catch((e) => e);
    expect(err.code).toBe(LOCK_STALE);
    expect(err.lockPath).toBe(lockPath);
    expect(err.holder).toMatchObject(holder);
    expect(err.ageMs).toBeGreaterThan(30_000);
    expect(err.message).toMatch(/pid=999999/);
    expect(err.message).toMatch(/host=dead-host/);
    expect(err.message).toMatch(/rm '/); // hướng dẫn khôi phục thủ công
    // Fail closed: lock vẫn còn nguyên cho tới khi người vận hành xử lý.
    expect(fs.readFileSync(lockPath, "utf8")).toBe(JSON.stringify(holder));
  });

  it("lock file rỗng (process chết trước khi ghi metadata) vẫn báo LOCK_STALE với holder unknown", async () => {
    const { lockPath } = tempLockPath();
    fs.writeFileSync(lockPath, "");
    const err = await withFileLock(lockPath, async () => "never", { retries: 2, delayMs: 5 }).catch((e) => e);
    expect(err.code).toBe(LOCK_STALE);
    expect(err.holder).toBeNull();
    expect(err.ageMs).toBeNull();
    expect(err.message).toMatch(/unknown/);
  });

  it("lỗi fs khác EEXIST không bị nuốt", async () => {
    // Thư mục cha không tồn tại ⇒ openSync('wx') ném ENOENT (không phải EEXIST).
    const missing = path.join(os.tmpdir(), "morpho-lock-missing-" + Date.now(), "x.lock");
    const err = await withFileLock(missing, async () => "never", { retries: 2, delayMs: 5 }).catch((e) => e);
    expect(err.code).toBe("ENOENT");
  });

  it("tuần tự hoá: hai acquire đồng thời không chồng lấn", async () => {
    const { lockPath } = tempLockPath();
    const events = [];
    const work = (name, ms) => withFileLock(lockPath, async () => {
      events.push(`${name}:enter`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${name}:exit`);
    }, { retries: 50, delayMs: 5 });
    await Promise.all([work("a", 30), work("b", 5)]);
    // Không có enter xen giữa enter/exit của người khác.
    expect(events).toEqual(events[0] === "a:enter" ? ["a:enter", "a:exit", "b:enter", "b:exit"] : ["b:enter", "b:exit", "a:enter", "a:exit"]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
