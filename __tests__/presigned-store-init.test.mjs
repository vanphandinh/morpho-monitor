/**
 * Khởi tạo registry (audit P0.1): `updateRegistry` phải tự tạo thư mục chứa
 * registry TRƯỚC khi lấy lock.
 *
 * Trước fix: host chưa có `data/` (local dev; `.env` mặc định
 * PRESIGNED_FILE=./data/presigned.json) ⇒ POST /api/presign đầu tiên trả
 * 500 ENOENT ngay ở `openSync('<...>.lock', 'wx')`, vì `writeRegistry` (có
 * mkdirSync) chỉ chạy SAU khi lock đã được lấy.
 *
 * `withFileLock` vẫn giữ nguyên hợp đồng "thư mục cha thiếu ⇒ ENOENT"
 * (__tests__/file-lock.test.mjs ghim điều đó) — fix nằm ở tầng store.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateRegistry, readRegistry, REGISTRY_VERSION } from "../presigned-store.mjs";

function nonExistentDirPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-init-"));
  // Thư mục con CHƯA tồn tại — đúng hình dạng `./data/` thiếu trên host mới.
  return path.join(dir, "data", "nested", "presigned.json");
}

describe("updateRegistry — tự tạo thư mục registry (P0.1)", () => {
  it("thư mục cha chưa tồn tại ⇒ ghi thành công, không ném ENOENT", async () => {
    const filePath = nonExistentDirPath();
    expect(fs.existsSync(path.dirname(filePath))).toBe(false);

    const result = await updateRegistry(filePath, (registry) => {
      registry.bundles["0x" + "a".repeat(64) + "@7"] = { marketId: "0x" + "a".repeat(64), nonce: 7, status: "pending" };
      return "saved";
    });

    expect(result).toBe("saved");
    expect(fs.existsSync(filePath)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.version).toBe(REGISTRY_VERSION);
    expect(Object.keys(stored.bundles)).toHaveLength(1);
  });

  it("lock được nhả sau khi ghi (không để lại .lock)", async () => {
    const filePath = nonExistentDirPath();
    await updateRegistry(filePath, () => "ok");
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
    expect(readRegistry(filePath).version).toBe(REGISTRY_VERSION);
  });

  it("mutation throw ⇒ lock vẫn được nhả, thư mục vẫn tồn tại", async () => {
    const filePath = nonExistentDirPath();
    await expect(updateRegistry(filePath, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
    expect(fs.existsSync(path.dirname(filePath))).toBe(true);
  });
});
