/**
 * Test cho logic thuần của webapp.
 *
 * Audit A.1b: các hàm dưới đây nay nằm trong `webapp-logic.mjs` — CHÍNH module mà
 * browser tải (`webapp-app.mjs` import từ `./webapp-logic.mjs`). Trước đây file
 * này phải NHÂN BẢN chúng ("mirror"), nên test có thể xanh trong khi code chạy
 * thật đã khác — đúng lớp lỗi mà audit A.1 muốn diệt.
 *
 * Phần cuối file ghim hợp đồng giữa HTML ↔ module ↔ route: một `onclick` gọi hàm
 * không tồn tại vẫn parse hợp lệ và chỉ chết lúc người dùng bấm nút.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  CLAIM_RECOVERY_MS_FALLBACK,
  TX_VERIFY_ATTEMPTS,
  TX_VERIFY_DELAY_MS,
  wadToPercent,
  shortenAddr,
  broadcastingAgeMinutes,
  isClaimOverdue,
  txVisibleOnChain,
  computeSupplyAssets,
  computeBorrowAssets,
  computeLiquidity,
  computeUtilization,
  computeMaxWithdraw,
  validateWithdraw,
} from "../webapp-logic.mjs";

const readSource = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

// ============================================================
// Tests: wadToPercent
// ============================================================
describe("webapp: wadToPercent()", () => {
  it("100% WAD = 100.00%", () => {
    expect(wadToPercent(1_000_000_000_000_000_000n)).toBe("100.00%");
  });

  it("50% WAD = 50.00%", () => {
    expect(wadToPercent(500_000_000_000_000_000n)).toBe("50.00%");
  });

  it("0 WAD = 0.00%", () => {
    expect(wadToPercent(0n)).toBe("0.00%");
  });

  it("LLTV 86% = 86.00%", () => {
    expect(wadToPercent(860_000_000_000_000_000n)).toBe("86.00%");
  });
});

// ============================================================
// Tests: shortenAddr
// ============================================================
describe("webapp: shortenAddr()", () => {
  it("shortens Morhpo Blue address", () => {
    const mb = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
    expect(shortenAddr(mb)).toBe("0xBBBB...FFCb");
  });

  it("shortens user address", () => {
    const addr = "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3";
    expect(shortenAddr(addr)).toBe("0x0A5e...66c3");
  });

  it("returns N/A for null", () => {
    expect(shortenAddr(null)).toBe("N/A");
  });

  it("returns N/A for empty string", () => {
    expect(shortenAddr("")).toBe("N/A");
  });
});

// ============================================================
// Tests: computeSupplyAssets
// ============================================================
describe("webapp: computeSupplyAssets()", () => {
  it("computes supply assets from shares", () => {
    // User has 50 shares out of 1000 total, pool has 2000 USDC
    const result = computeSupplyAssets(50n, 2000_000000n, 1000n);
    // (50 * 2000000000) / 1000 = 100000000 = 100 USDC
    expect(result).toBe(100_000000n);
  });

  it("returns 0 when totalSupplyShares is 0", () => {
    const result = computeSupplyAssets(100n, 1000_000000n, 0n);
    expect(result).toBe(0n);
  });

  it("returns 0 when user has no shares", () => {
    const result = computeSupplyAssets(0n, 1000_000000n, 1000n);
    expect(result).toBe(0n);
  });

  it("handles exact integer division (no fractional shares)", () => {
    // 1 share = 1 USDC
    const result = computeSupplyAssets(500n, 1000_000000n, 1000n);
    expect(result).toBe(500_000000n);
  });

  it("truncates in integer division (Solidity behavior)", () => {
    // 1 share out of 3 total, pool has 10 USDC → 10/3 = 3 (truncated)
    const result = computeSupplyAssets(1n, 10_000000n, 3n);
    expect(result).toBe(3_333333n); // floor(10/3) * 1e6
  });
});

// ============================================================
// Tests: computeBorrowAssets
// ============================================================
describe("webapp: computeBorrowAssets()", () => {
  it("computes borrow assets from shares", () => {
    const result = computeBorrowAssets(10n, 5000_000000n, 100n);
    expect(result).toBe(500_000000n);
  });

  it("returns 0 when totalBorrowShares is 0", () => {
    const result = computeBorrowAssets(10n, 5000_000000n, 0n);
    expect(result).toBe(0n);
  });
});

// ============================================================
// Tests: computeLiquidity
// ============================================================
describe("webapp: computeLiquidity()", () => {
  it("supply > borrow → positive liquidity", () => {
    const liq = computeLiquidity(10000_000000n, 7000_000000n);
    expect(liq).toBe(3000_000000n);
  });

  it("supply == borrow → zero liquidity", () => {
    const liq = computeLiquidity(5000_000000n, 5000_000000n);
    expect(liq).toBe(0n);
  });

  it("supply < borrow → clamped to 0 (shouldn't happen, but safe)", () => {
    const liq = computeLiquidity(1000_000000n, 2000_000000n);
    expect(liq).toBe(0n);
  });
});

// ============================================================
// Tests: computeUtilization
// ============================================================
describe("webapp: computeUtilization()", () => {
  it("70% utilization (WAD)", () => {
    const util = computeUtilization(7000_000000n, 10000_000000n);
    expect(util).toBe(700_000_000_000_000_000n); // 0.7 WAD
  });

  it("100% utilization", () => {
    const util = computeUtilization(5000_000000n, 5000_000000n);
    expect(util).toBe(BigInt(1e18));
  });

  it("0% utilization when no supply", () => {
    const util = computeUtilization(0n, 0n);
    expect(util).toBe(0n);
  });
});

// ============================================================
// Tests: computeMaxWithdraw
// ============================================================
describe("webapp: computeMaxWithdraw() (MAX = min(supplyAssets, liquidity))", () => {
  it("liquidity > supply → max = supply (rút toàn bộ vị thế)", () => {
    const max = computeMaxWithdraw(1000_000000n, 5000_000000n);
    expect(max).toBe(1000_000000n);
  });

  it("liquidity < supply → max = liquidity (bị giới hạn bởi thanh khoản)", () => {
    const max = computeMaxWithdraw(1000_000000n, 300_000000n);
    expect(max).toBe(300_000000n);
  });

  it("liquidity == supply → max = supply", () => {
    const max = computeMaxWithdraw(500_000000n, 500_000000n);
    expect(max).toBe(500_000000n);
  });

  it("liquidity == 0 → max = 0 (không rút được gì)", () => {
    const max = computeMaxWithdraw(1000_000000n, 0n);
    expect(max).toBe(0n);
  });

  it("supply == 0 → max = 0 (không có vị thế)", () => {
    const max = computeMaxWithdraw(0n, 5000_000000n);
    expect(max).toBe(0n);
  });
});

// ============================================================
// Tests: validateWithdraw (input validation)
// ============================================================
describe("webapp: validateWithdraw()", () => {
  const supply = 1000_000000n;  // 1000 USDC
  const liquidity = 500_000000n; // 500 USDC available

  it("passes valid withdrawal (assets ≤ supply and ≤ liquidity)", () => {
    const result = validateWithdraw({ assets: 300_000000n, supplyAssets: supply, liquidity });
    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("rejects zero amount", () => {
    const result = validateWithdraw({ assets: 0n, supplyAssets: supply, liquidity });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("zero");
  });

  it("rejects amount exceeding supply assets", () => {
    const result = validateWithdraw({ assets: supply + 1n, supplyAssets: supply, liquidity });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("over_balance");
  });

  it("rejects amount exceeding liquidity", () => {
    const result = validateWithdraw({ assets: liquidity + 1n, supplyAssets: supply, liquidity });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("over_liquidity");
  });

  it("rejects when both supply and liquidity exceeded", () => {
    // asset > both: supply check fires first
    const result = validateWithdraw({ assets: supply + 1n, supplyAssets: supply, liquidity: 1_000000n });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("over_balance");
  });

  it("allows exact max (assets == supplyAssets == liquidity)", () => {
    const result = validateWithdraw({ assets: 500_000000n, supplyAssets: 500_000000n, liquidity: 500_000000n });
    expect(result.valid).toBe(true);
  });

  it("không có vị thế và nhập 0 ⇒ 'zero', không phải 'over_balance'", () => {
    // Rút 0 với supply 0: 0 > 0 là false, nên phải rơi xuống nhánh zero.
    const result = validateWithdraw({ assets: 0n, supplyAssets: 0n, liquidity: 0n });
    expect(result.reason).toBe("zero");
  });
});

describe("claim age hiển thị cho claim đang broadcasting (R1)", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const ago = (ms) => new Date(now - ms).toISOString();

  it("tính số phút từ broadcastingAt", () => {
    expect(broadcastingAgeMinutes(ago(90_000), now)).toBe(1);
    expect(broadcastingAgeMinutes(ago(3_600_000), now)).toBe(60);
    expect(broadcastingAgeMinutes(ago(0), now)).toBe(0);
  });

  it("thiếu/không hợp lệ mốc thời gian ⇒ null (không vẽ tuổi giả)", () => {
    expect(broadcastingAgeMinutes(null, now)).toBe(null);
    expect(broadcastingAgeMinutes(undefined, now)).toBe(null);
    expect(broadcastingAgeMinutes("không-phải-ngày", now)).toBe(null);
  });

  it("chỉ claim đang broadcasting mới có tuổi", () => {
    expect(broadcastingAgeMinutes(ago(120_000), now)).toBe(2); // hàm thuần: caller giới hạn theo status
    expect(isClaimOverdue({ status: "pending", broadcastingAt: ago(600_000) }, now)).toBe(false);
    expect(isClaimOverdue({ status: "submitted", broadcastingAt: ago(600_000) }, now)).toBe(false);
  });

  it("quá ngưỡng recovery (180s) ⇒ báo quá hạn; đúng ngưỡng thì chưa", () => {
    const M = CLAIM_RECOVERY_MS_FALLBACK;
    expect(isClaimOverdue({ status: "broadcasting", broadcastingAt: ago(M) }, now)).toBe(false);
    expect(isClaimOverdue({ status: "broadcasting", broadcastingAt: ago(M + 1) }, now)).toBe(true);
    expect(isClaimOverdue({ status: "broadcasting", broadcastingAt: null }, now)).toBe(false);
  });

  it("ngưỡng do server inject (CFG.claimRecoveryMs) phải được tôn trọng", () => {
    // webapp-app.mjs truyền CLAIM_RECOVERY_MS của chính nó vào tham số thứ ba.
    const r = { status: "broadcasting", broadcastingAt: ago(200_000) };
    expect(isClaimOverdue(r, now)).toBe(true); // mặc định 180s
    expect(isClaimOverdue(r, now, 600_000)).toBe(false); // server cấu hình 10 phút
  });
});

describe("webapp-app — xác minh tx của tab Rút Tiền (R4)", () => {
  // Ví trỏ RPC về proxy ⇒ tx bị capture, không bao giờ lên chain, nhưng ví vẫn
  // trả hash nên UI cũ báo "thành công". Hàm này chỉ CẢNH BÁO (best-effort):
  // false cũng là kết quả đúng khi tx chưa lan truyền kịp.
  const spies = () => {
    const sleeps = [];
    return { sleeps, sleep: async (ms) => { sleeps.push(ms); } };
  };

  it("thấy tx ở lần thử đầu ⇒ true và không sleep", async () => {
    const { sleeps, sleep } = spies();
    let calls = 0;
    const client = { getTransaction: async () => { calls++; return { hash: "0xabc" }; } };
    await expect(txVisibleOnChain(client, "0xabc", { sleep })).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("throw rồi mới có tx ⇒ true (RPC lỗi tạm thời không kết luận là mất tx)", async () => {
    const { sleeps, sleep } = spies();
    let calls = 0;
    const client = {
      getTransaction: async () => {
        calls++;
        if (calls === 1) throw new Error("timeout");
        return { hash: "0xabc" };
      },
    };
    await expect(txVisibleOnChain(client, "0xabc", { sleep })).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([TX_VERIFY_DELAY_MS]);
  });

  it("tx không bao giờ xuất hiện ⇒ false sau đúng `attempts` lần gọi", async () => {
    const { sleeps, sleep } = spies();
    let calls = 0;
    const client = { getTransaction: async () => { calls++; return null; } };
    await expect(txVisibleOnChain(client, "0xabc", { sleep })).resolves.toBe(false);
    expect(calls).toBe(TX_VERIFY_ATTEMPTS);
    expect(sleeps).toEqual([TX_VERIFY_DELAY_MS, TX_VERIFY_DELAY_MS, TX_VERIFY_DELAY_MS]);
  });

  it("mọi lần thử đều throw ⇒ false, không ném ra ngoài", async () => {
    const { sleep } = spies();
    let calls = 0;
    const client = { getTransaction: async () => { calls++; throw new Error("RPC chết"); } };
    await expect(txVisibleOnChain(client, "0xabc", { sleep })).resolves.toBe(false);
    expect(calls).toBe(TX_VERIFY_ATTEMPTS);
  });

  it("tôn trọng attempts/delayMs khi được inject", async () => {
    const { sleeps, sleep } = spies();
    const client = { getTransaction: async () => null };
    await expect(txVisibleOnChain(client, "0xabc", { attempts: 2, delayMs: 10, sleep })).resolves.toBe(false);
    expect(sleeps).toEqual([10]);
  });
});

describe("webapp-app — contract xoá tier theo rung (R2)", () => {
  // Code UI nằm ở module webapp-app.mjs (audit A.1) nên kiểm hợp đồng tĩnh trên
  // module: nút ✕ PHẢI gọi kèm nonce, và URL DELETE phải gửi market+nonce+tier.
  // Không có nonce, API đã guard (F3) sẽ trả 400 cho market có ladder — tức là
  // người dùng không xoá được tier nào cả.
  const app = readSource("webapp-app.mjs");

  it("mọi nút ✕ đều gọi deleteTierFromBundle kèm (nonce, index)", () => {
    const onclickCalls = [...app.matchAll(/onclick="deleteTierFromBundle\(([^"]*)\)"/g)].map((m) => m[1]);
    expect(onclickCalls.length).toBeGreaterThan(0);
    for (const args of onclickCalls) expect(args.split(",").length).toBe(2);
  });

  it("URL DELETE gửi kèm market + nonce + tier", () => {
    expect(app).toContain("/api/presign?market=${encodeURIComponent(marketId)}&nonce=${encodeURIComponent(nonce)}&tier=${index}");
  });

  it("rung đang broadcasting không hiện nút xoá (API trả 409)", () => {
    expect(app).toContain('r.status !== "broadcasting"');
  });

  it("doWithdraw gọi xác minh và render note cảnh báo capture", () => {
    expect(app).toContain("txVisibleOnChain(publicClient, hash)");
    expect(app).toContain('id="tx-verify-note"');
    // Kết quả xác minh của lần rút cũ không được ghi đè banner của lần rút mới.
    expect(app).toContain("verifyToken !== txVerifyToken");
    // Cảnh báo phải nêu rõ nguyên nhân (ví trỏ RPC về proxy ⇒ chỉ được capture).
    expect(app).toContain("ghi lại (capture)");
  });
});

describe("A.1b — hợp đồng HTML ↔ module ↔ route (một onclick sai là UI chết lặng)", () => {
  const html = readSource("webapp.html");
  const app = readSource("webapp-app.mjs");
  const logic = readSource("webapp-logic.mjs");
  const server = readSource("webapp-server.mjs");
  const handlerSrc = readSource("webapp-handler.mjs");

  it("MỌI hàm được gọi từ thuộc tính on* trong HTML đều là thuộc tính của window trong module", () => {
    const attr = /\son(?:click|change|input|keydown|keyup|submit|blur|focus)="([^"]*)"/g;
    const called = new Set();
    for (const [, body] of html.matchAll(attr)) {
      for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
    }
    // Chốt chống regex hỏng: HTML có ~18 handler, đừng để test xanh vì match rỗng.
    expect(called.size).toBeGreaterThanOrEqual(15);
    const missing = [...called].filter((name) => !new RegExp(`window\\.${name}\\s*=`).test(app));
    expect(missing).toEqual([]);
  });

  it("webapp-logic.mjs là hàm THUẦN: không chạm DOM/window (nên import được trong test)", () => {
    expect(logic).not.toMatch(/\bdocument\b|\bwindow\b|localStorage|navigator/);
  });

  it("webapp-app.mjs import logic từ module chung, KHÔNG còn bản sao cục bộ", () => {
    for (const name of [
      "wadToPercent", "shortenAddr", "broadcastingAgeMinutes", "isClaimOverdue",
      "txVisibleOnChain", "computeSupplyAssets", "computeBorrowAssets", "computeLiquidity",
      "computeUtilization", "computeMaxWithdraw", "validateWithdraw",
    ]) {
      expect(app).toMatch(new RegExp(`^\\s*${name},?$`, "m"));           // có trong khối import
      expect(app).not.toMatch(new RegExp(`function ${name}\\b`));        // không định nghĩa lại
    }
    expect(app).toMatch(/from "\.\/webapp-logic\.mjs"/);
  });

  it("server đọc + truyền module logic, handler phục vụ route của nó", () => {
    expect(server).toContain("webapp-logic.mjs");
    expect(handlerSrc).toContain('"/webapp-logic.mjs"');
  });

  it("bản sao logic đã chuyển sang module chung được dùng ở đúng call site", () => {
    // Rút tiền: validation + MAX phải đi qua hàm chung (nếu không, test trên
    // module xanh mà UI vẫn dùng bản cũ — đúng thứ A.1b muốn chặn).
    expect(app).toContain("validateWithdraw({");
    expect(app).toContain("computeMaxWithdraw(");
    expect(app).toContain("computeSupplyAssets(");
    expect(app).toContain("computeBorrowAssets(");
    expect(app).toContain("computeLiquidity(");
    expect(app).toContain("computeUtilization(");
  });
});
