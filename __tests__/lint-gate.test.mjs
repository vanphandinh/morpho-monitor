/**
 * Cổng lint phải TỰ CHỨNG MINH nó thật sự quét code (vòng 6, P4).
 *
 * Bối cảnh (D10, vòng 5): lệnh lint cũ dựa vào shell expand `*.mjs`; shell của npm trên Windows
 * (cmd.exe) không expand, nên cổng chỉ quét `__tests__` + `scripts`, bỏ toàn bộ `.mjs` ở gốc
 * (production), mà vẫn in `Found 0 warnings and 0 errors` và exit 0. Một cổng "xanh" không quét gì
 * là cổng tệ hơn không có cổng, vì nó tạo niềm tin sai.
 *
 * Nên `scripts/lint.mjs` không chỉ chạy oxlint: nó đọc số file oxlint BÁO ĐÃ QUÉT rồi đối chiếu với
 * danh sách `.mjs` mà git theo dõi. Suite này kiểm chính cơ chế đó — và kiểm nó bằng cách CHẠY,
 * không bằng cách đọc source.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "scripts", "lint.mjs");

/** Chạy cổng lint với tham số cho trước, trả cả exit code lẫn output (không ném khi đỏ). */
function runGate(extraArgs = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...extraArgs], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: typeof err.status === "number" ? err.status : 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function trackedMjsCount() {
  return execFileSync("git", ["ls-files", "--", "*.mjs"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean).length;
}

describe("cổng lint tự kiểm độ phủ", () => {
  it("chạy mặc định: lint sạch VÀ tự báo đã quét đủ số file git theo dõi", () => {
    const { code, output } = runGate();
    expect(code, output).toBe(0);

    const match = output.match(/\[lint\] ✅ độ phủ: oxlint quét (\d+) file \.mjs \(git theo dõi (\d+) file/);
    expect(match, `không thấy dòng tự kiểm độ phủ trong output:\n${output}`).toBeTruthy();
    const [, scanned, tracked] = match.map(Number);
    // Chốt chống xanh rỗng: hai con số phải khớp git hiện tại và không được nhỏ bất thường.
    expect(tracked).toBe(trackedMjsCount());
    expect(scanned).toBeGreaterThanOrEqual(tracked);
    expect(scanned).toBeGreaterThan(60); // đo được: 80 — nếu tụt xuống nghĩa là phạm vi quét bị thu hẹp
  });

  it("thu hẹp phạm vi quét ⇒ cổng ĐỎ và nêu rõ file chưa được quét (đây chính là lỗi D10)", () => {
    const { code, output } = runGate(["--scope", "__tests__"]);
    expect(code, output).not.toBe(0);
    expect(output).toContain("chỉ quét");
    expect(output).toContain("file .mjs");
    // Danh sách bị cắt ở 10 dòng đầu, nên chỉ ghim rằng nó NÊU TÊN file production ở gốc (đúng thứ
    // D10 bỏ sót) và nói rõ còn bao nhiêu file nữa — không ghim một tên cụ thể có thể nằm ngoài 10 dòng.
    expect(output).toMatch(/chưa được quét: (auth|index|market-reader|monitor|proxy-dispatcher)\.mjs/);
    expect(output).toMatch(/và \d+ file nữa/);
  });

  it("cổng vẫn dùng đủ hai cờ chặn của oxlint (mất một cờ là mất một lớp bắt lỗi)", () => {
    const source = fs.readFileSync(GATE, "utf8");
    expect(source).toContain('"--deny", "no-undef"');
    expect(source).toContain('"--deny-warnings"');
  });
});
