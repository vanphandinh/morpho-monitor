/**
 * Chẩn đoán 2026-09-26 — flake `two-process-race.test.mjs` trên `windows-latest` (từng làm CI #19 đỏ:
 * `expected +0 to be 1` ở `submittedCount`, tức một tiến trình ĐÃ gửi raw tx mà không bundle nào ở
 * trạng thái terminal).
 *
 * Cơ chế, đo bằng probe một-biến trên Windows (`writeRegistry` = ghi `.tmp` rồi `renameSync`):
 *
 *   có tiến trình khác đang MỞ file đích để đọc  →  writeRegistry NÉM `EPERM: operation not permitted,
 *                                                    rename '…presigned.json.tmp' -> '…presigned.json'`
 *   không có reader                              →  OK
 *
 * Share mode của `fs.readFileSync` trên Windows KHÔNG cho phép rename/delete, còn POSIX thì không quan
 * tâm ai đang mở file ⇒ lỗi này CHỈ có trên Windows. Hệ quả trong production: `readRegistry()` của
 * tiến trình anh em (hoặc của chính monitor ở chu kỳ khác) mở file vài ms đúng lúc bước chốt terminal
 * đang rename ⇒ `updateRegistry` ném ⇒ `broadcastEligible` giữ nguyên claim `broadcasting` (thiết kế
 * "ambiguity keeps the claim" — tự lành ở chu kỳ sau), nên trạng thái cuối là `broadcasting` + `pending`
 * chứ không phải `submitted` + `expired`.
 *
 * Fix: `writeRegistry` thử lại rename với lỗi TẠM THỜI của Windows (EPERM/EBUSY/EACCES), ngân sách nhỏ
 * (≤100ms) vì nó chạy bên trong lock file (lock chỉ kiên nhẫn ~1s). Cửa sổ thật cần che chỉ vài ms.
 *
 * Test này TẤT ĐỊNH và chạy được mọi hệ: thay vì phụ thuộc share mode của Windows (không tồn tại trên
 * Linux) và vào thời điểm một reader đóng file (dễ flake dưới tải), nó tiêm đúng MỘT biến — `renameSync`
 * ném `EPERM` N lần đầu rồi chuyển tiếp cho bản thật.
 *
 * Đỏ-trước (Windows, cây trước fix): ca 1 ném `EPERM` ngay lần rename đầu.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REGISTRY_VERSION, emptyRegistry, readRegistry, updateRegistry, writeRegistry } from "../presigned-store.mjs";

const MARKET = "0x" + "a".repeat(64);

const tmpDirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshRegistryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-write-race-"));
  tmpDirs.push(dir);
  return path.join(dir, "presigned.json");
}

const bundle = () => ({ marketId: MARKET, nonce: 7, status: "pending", withdrawals: [{ label: "small", amountWei: "50" }] });

/** Tiêm `EPERM` cho `failures` lần rename đầu, sau đó chuyển tiếp cho `fs.renameSync` thật. */
function injectTransientRenameFailures(failures, code = "EPERM") {
  const real = fs.renameSync;
  let attempts = 0;
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    attempts += 1;
    if (attempts <= failures) throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`), { code });
    return real(from, to);
  });
  return { spy, attempts: () => attempts };
}

describe("writeRegistry — rename bị chặn TẠM THỜI không được làm lần ghi thất bại", () => {
  it("đường THẬT (updateRegistry): EPERM 2 lần đầu rồi rename thành công ⇒ ghi xong, không ném", async () => {
    const file = freshRegistryPath();
    writeRegistry(file, emptyRegistry());
    const { attempts } = injectTransientRenameFailures(2);

    await updateRegistry(file, (registry) => {
      registry.bundles[`${MARKET}@7`] = bundle();
    });

    expect(attempts(), "phải thử lại ít nhất 3 lần (2 lần lỗi + 1 lần thành công)").toBeGreaterThanOrEqual(3);
    const stored = readRegistry(file);
    expect(stored.bundles[`${MARKET}@7`]?.status).toBe("pending");
    expect(fs.existsSync(`${file}.tmp`), "không được để lại rác .tmp").toBe(false);
  });

  it("lỗi KHÔNG tạm thời (EISDIR) phải ném NGAY, không thử lại và không che lỗi", () => {
    const file = freshRegistryPath();
    writeRegistry(file, emptyRegistry());
    const { attempts } = injectTransientRenameFailures(99, "EISDIR");

    expect(() => writeRegistry(file, emptyRegistry())).toThrow(/EISDIR/);
    expect(attempts(), "lỗi thật không được thử lại (tránh kéo dài thời gian giữ lock)").toBe(1);
  });

  it("hết ngân sách thử lại thì NÉM (fail closed) và dọn .tmp", () => {
    const file = freshRegistryPath();
    writeRegistry(file, emptyRegistry());
    const { attempts } = injectTransientRenameFailures(99);

    expect(() => writeRegistry(file, emptyRegistry())).toThrow(/EPERM/);
    expect(attempts(), "phải thử lại nhiều lần trước khi bỏ cuộc").toBeGreaterThan(1);
    expect(fs.existsSync(`${file}.tmp`), "không được để lại rác .tmp").toBe(false);
  });

  it("vẫn fail closed với registry sai version (không bị retry che)", () => {
    const file = freshRegistryPath();
    expect(() => writeRegistry(file, { version: REGISTRY_VERSION - 1, bundles: {} })).toThrow(/Refusing to write/);
  });
});
