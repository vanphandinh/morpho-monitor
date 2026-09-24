/**
 * Kênh cảnh báo vòng đời presign (audit R1).
 * Import production module (không copy logic): quyết định/cooldown/nội dung là
 * hàm thuần, hàm gửi là injectable nên không cần monitor.mjs (không import được).
 */
import { describe, it, expect, vi } from "vitest";
import {
  shouldSendLifecycleAlert,
  buildLifecycleAlert,
  createLifecycleAlerter,
  postNtfy,
  LIFECYCLE_ALERT_COOLDOWN_MS,
} from "../lifecycle-alert.mjs";

describe("shouldSendLifecycleAlert (thuần)", () => {
  it("gửi lần đầu, chặn trong cooldown, gửi lại sau cooldown", () => {
    const now = 1_700_000_000_000;
    expect(shouldSendLifecycleAlert("superseded", "m1@7", { lastSentAt: null, now })).toEqual({ send: true, reason: "ok" });
    expect(shouldSendLifecycleAlert("superseded", "m1@7", { lastSentAt: now - 1000, now })).toEqual({ send: false, reason: "cooldown" });
    expect(shouldSendLifecycleAlert("superseded", "m1@7", { lastSentAt: now - LIFECYCLE_ALERT_COOLDOWN_MS, now })).toEqual({ send: true, reason: "ok" });
  });

  it("kind lạ hoặc thiếu id ⇒ không gửi (không bịa cảnh báo)", () => {
    expect(shouldSendLifecycleAlert("khong-ton-tai", "x", {}).send).toBe(false);
    expect(shouldSendLifecycleAlert("stuck", "", {})).toEqual({ send: false, reason: "missing_id" });
    expect(shouldSendLifecycleAlert("stuck", null, {}).send).toBe(false);
  });

  it("object prototype không bị coi là kind hợp lệ", () => {
    expect(shouldSendLifecycleAlert("toString", "x", {}).send).toBe(false);
    expect(shouldSendLifecycleAlert("constructor", "x", {}).send).toBe(false);
  });
});

describe("buildLifecycleAlert (thuần)", () => {
  const info = { id: "0xmarket@7", marketId: "0x" + "a".repeat(64), nonce: 7, detail: "receipt=null, latest=8" };

  it("superseded nêu hậu quả + hành động (lấy nonce mới, ký lại)", () => {
    const alert = buildLifecycleAlert("superseded", info);
    expect(alert.title).toContain("bị thay thế");
    expect(alert.tags).toContain("warning");
    expect(alert.message).toContain("Nonce: 7");
    expect(alert.message).toContain("receipt=null, latest=8");
    expect(alert.message).toContain("ký lại");
  });

  it("stuck/conflict ở priority cao nhất và có hướng dẫn đối soát", () => {
    const stuck = buildLifecycleAlert("stuck", { ...info, detail: "lacks rawTx" });
    expect(stuck.priority).toBe("5");
    expect(stuck.message).toContain("xử lý tay");
    expect(stuck.message).toContain("lacks rawTx");
    const conflict = buildLifecycleAlert("conflict", info);
    expect(conflict.priority).toBe("5");
    expect(conflict.message).toContain("fail closed");
  });

  it("kind lạ ⇒ null (caller không gửi gì)", () => {
    expect(buildLifecycleAlert("khong-ton-tai", info)).toBe(null);
  });
});

describe("createLifecycleAlerter — chống spam theo (kind, id)", () => {
  it("chỉ gửi một lần cho cùng kind+id trong cooldown, hết cooldown mới gửi lại", async () => {
    let clock = 1_700_000_000_000;
    const send = vi.fn(async () => {});
    const alerter = createLifecycleAlerter({ send, now: () => clock });

    expect(await alerter.notify("stuck", { id: "a@7", nonce: 7 })).toEqual({ sent: true, reason: "ok" });
    expect(await alerter.notify("stuck", { id: "a@7", nonce: 7 })).toEqual({ sent: false, reason: "cooldown" });
    expect(send).toHaveBeenCalledTimes(1);

    clock += LIFECYCLE_ALERT_COOLDOWN_MS + 1;
    expect((await alerter.notify("stuck", { id: "a@7", nonce: 7 })).sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);

    // kind khác, cùng id ⇒ độc lập
    expect((await alerter.notify("superseded", { id: "a@7", nonce: 7 })).sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("lỗi gửi không throw ra ngoài và KHÔNG biến thành spam mỗi chu kỳ", async () => {
    const send = vi.fn(async () => { throw new Error("ntfy down"); });
    const logger = { error: vi.fn() };
    const alerter = createLifecycleAlerter({ send, logger, now: () => 1_700_000_000_000 });

    const first = await alerter.notify("superseded", { id: "a@7", nonce: 7 });
    expect(first).toEqual({ sent: false, reason: "send_failed" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    // Chu kỳ sau: vẫn trong cooldown ⇒ không gọi lại (không spam khi ntfy chết).
    expect((await alerter.notify("superseded", { id: "a@7", nonce: 7 })).reason).toBe("cooldown");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("conflict không có id ⇒ tự suy ra từ nonce", async () => {
    const send = vi.fn(async () => {});
    const alerter = createLifecycleAlerter({ send, now: () => 1_700_000_000_000 });
    expect((await alerter.notify("conflict", { nonce: 9 })).sent).toBe(true);
    expect((await alerter.notify("conflict", { nonce: 9 })).reason).toBe("cooldown");
    expect((await alerter.notify("conflict", { nonce: 10 })).sent).toBe(true);
  });
});

describe("postNtfy — payload gửi tới ntfy", () => {
  it("POST đúng URL/header/body với Markdown", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
    const alert = buildLifecycleAlert("superseded", { id: "a@7", marketId: "0xmarket", nonce: 7, detail: "d" });
    await postNtfy({ fetchImpl, server: "https://ntfy.sh", topic: "topic-x", alert });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ntfy.sh/topic-x");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Title).toBe(alert.title);
    expect(calls[0].init.headers.Markdown).toBe("yes");
    expect(calls[0].init.body).toBe(alert.message);
  });

  it("đính timeout signal (ntfy treo không được chặn chu kỳ monitor)", async () => {
    const seen = [];
    const fetchImpl = async (_url, init) => { seen.push(init.signal); return { ok: true, status: 200 }; };
    await postNtfy({ fetchImpl, server: "https://ntfy.sh", topic: "t", alert: { title: "x", tags: "y", priority: "4", message: "z" }, timeoutMs: 1234 });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0].aborted).toBe(false);
  });

  it("ntfy trả lỗi ⇒ throw để alerter log (không nuốt im lặng)", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500 });
    await expect(postNtfy({ fetchImpl, server: "https://ntfy.sh", topic: "t", alert: { title: "x", tags: "y", priority: "4", message: "z" } }))
      .rejects.toThrow(/500/);
  });
});
