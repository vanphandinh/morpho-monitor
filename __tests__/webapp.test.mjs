/**
 * Unit tests for pure computation logic from webapp.html.
 *
 * These functions mirror the browser code in webapp.html <script type="module">.
 * They're duplicated here for unit testing since browser ESM can't be
 * directly imported by vitest (Node.js).
 *
 * When editing webapp.html logic, update both the HTML and this test file.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";

// ============================================================
// Mirror of webapp.html pure functions
// ============================================================

/**
 * Format a WAD-scaled value (1e18) as a percentage string.
 * Mirrors webapp.html line 345-347.
 */
function wadToPercent(wad) {
  return (Number(wad) / 1e16).toFixed(2) + "%";
}

/**
 * Shorten an Ethereum address for display.
 * Mirrors webapp.html line 349-351.
 */
function shortenAddr(addr) {
  if (!addr) return "N/A";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Age in minutes of a broadcasting claim (audit R1).
 * Mirrors webapp.html `broadcastingAgeMinutes`.
 */
function broadcastingAgeMinutes(broadcastingAt, nowMs = Date.now()) {
  const started = Date.parse(broadcastingAt ?? "");
  if (!Number.isFinite(started)) return null;
  return Math.floor(Math.max(0, nowMs - started) / 60000);
}

/**
 * Is a broadcasting claim past the recovery threshold?
 * Mirrors webapp.html `isClaimOverdue`. Threshold is injected by the server
 * (window.MORPHO_CONFIG.claimRecoveryMs) from presigned-broadcast.mjs.
 */
const CLAIM_RECOVERY_MS = 180_000;
function isClaimOverdue(r, nowMs = Date.now()) {
  if (!r || r.status !== "broadcasting") return false;
  const started = Date.parse(r.broadcastingAt ?? "");
  return Number.isFinite(started) && nowMs - started > CLAIM_RECOVERY_MS;
}

/**
 * Ngân sách xác minh tx của tab "Rút Tiền" (audit R4).
 * Mirrors webapp.html `TX_VERIFY_ATTEMPTS` / `TX_VERIFY_DELAY_MS`.
 */
const TX_VERIFY_ATTEMPTS = 4;
const TX_VERIFY_DELAY_MS = 3000;

/**
 * Hash mà ví trả về có thật sự nằm trên RPC công khai?
 * Mirrors webapp.html `txVisibleOnChain`. `sleep` được inject để test không phải
 * chờ thật.
 */
async function txVisibleOnChain(client, hash, {
  attempts = TX_VERIFY_ATTEMPTS,
  delayMs = TX_VERIFY_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (await client.getTransaction({ hash })) return true;
    } catch {
      // Chưa thấy, hoặc RPC lỗi tạm thời → thử lại.
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/**
 * Compute supply assets from shares.
 * Mirrors webapp.html line 454-456.
 *
 * assets = (shares * totalSupplyAssets) / totalSupplyShares
 */
function computeSupplyAssets(shares, totalSupplyAssets, totalSupplyShares) {
  if (totalSupplyShares === 0n) return 0n;
  return (shares * totalSupplyAssets) / totalSupplyShares;
}

/**
 * Compute borrow assets from shares.
 * Mirrors webapp.html line 507-509.
 */
function computeBorrowAssets(shares, totalBorrowAssets, totalBorrowShares) {
  if (totalBorrowShares === 0n) return 0n;
  return (shares * totalBorrowAssets) / totalBorrowShares;
}

/**
 * Compute market liquidity.
 * Mirrors webapp.html line 458-460.
 */
function computeLiquidity(totalSupplyAssets, totalBorrowAssets) {
  const liquidity = totalSupplyAssets - totalBorrowAssets;
  return liquidity < 0n ? 0n : liquidity;
}

/**
 * Compute utilization (WAD-scaled).
 * Mirrors webapp.html line 463-465.
 */
function computeUtilization(totalBorrowAssets, totalSupplyAssets) {
  if (totalSupplyAssets === 0n) return 0n;
  return (totalBorrowAssets * BigInt(1e18)) / totalSupplyAssets;
}

/**
 * Compute the max withdrawable amount.
 * MAX = min(supplyAssets, liquidity)
 * Mirrors the MAX button logic in webapp.html.
 */
function computeMaxWithdraw(supplyAssets, liquidity) {
  return supplyAssets < liquidity ? supplyAssets : liquidity;
}

/**
 * Validate withdraw input (client-side check before on-chain tx).
 * Mirrors the validation logic added to webapp.html withdrawAmount().
 *
 * Returns { valid: boolean, error: string | null }
 */
function validateWithdraw({ assets, supplyAssets, liquidity }) {
  if (assets === 0n) {
    return { valid: false, error: "Số lượng rút không thể bằng 0." };
  }
  if (assets > supplyAssets) {
    return { valid: false, error: "Số lượng vượt quá số dư có thể rút." };
  }
  if (assets > liquidity) {
    return { valid: false, error: "Thanh khoản market không đủ." };
  }
  return { valid: true, error: null };
}

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
    const result = validateWithdraw({
      assets: 300_000000n,
      supplyAssets: supply,
      liquidity,
    });
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  it("rejects zero amount", () => {
    const result = validateWithdraw({
      assets: 0n,
      supplyAssets: supply,
      liquidity,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("0");
  });

  it("rejects amount exceeding supply assets", () => {
    const result = validateWithdraw({
      assets: supply + 1n,
      supplyAssets: supply,
      liquidity,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("số dư");
  });

  it("rejects amount exceeding liquidity", () => {
    const result = validateWithdraw({
      assets: liquidity + 1n,
      supplyAssets: supply,
      liquidity,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Thanh khoản");
  });

  it("rejects when both supply and liquidity exceeded", () => {
    // asset > both: supply check fires first
    const result = validateWithdraw({
      assets: supply + 1n,
      supplyAssets: supply,
      liquidity: 1_000000n,
    });
    expect(result.valid).toBe(false);
  });

  it("allows exact max (assets == supplyAssets == liquidity)", () => {
    const result = validateWithdraw({
      assets: 500_000000n,
      supplyAssets: 500_000000n,
      liquidity: 500_000000n,
    });
    expect(result.valid).toBe(true);
  });
});

describe("webapp-app — contract xoá tier theo rung (R2)", () => {
  // Code UI nằm ở module webapp-app.mjs (audit A.1) nên kiểm hợp đồng tĩnh trên
  // module: nút ✕ PHẢI gọi kèm nonce, và URL DELETE phải gửi market+nonce+tier.
  // Không có nonce, API đã guard (F3) sẽ trả 400 cho market có ladder — tức là
  // người dùng không xoá được tier nào cả.
  const app = fs.readFileSync(new URL("../webapp-app.mjs", import.meta.url), "utf8");

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
    expect(isClaimOverdue({ status: "broadcasting", broadcastingAt: ago(CLAIM_RECOVERY_MS) }, now)).toBe(false);
    expect(isClaimOverdue({ status: "broadcasting", broadcastingAt: ago(CLAIM_RECOVERY_MS + 1) }, now)).toBe(true);
    expect(isClaimOverdue({ status: "broadcasting", broadcastingAt: null }, now)).toBe(false);
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

  it("doWithdraw gọi xác minh và render note cảnh báo capture", () => {
    const app = fs.readFileSync(new URL("../webapp-app.mjs", import.meta.url), "utf8");
    expect(app).toContain("txVisibleOnChain(publicClient, hash)");
    expect(app).toContain('id="tx-verify-note"');
    // Kết quả xác minh của lần rút cũ không được ghi đè banner của lần rút mới.
    expect(app).toContain("verifyToken !== txVerifyToken");
    // Cảnh báo phải nêu rõ nguyên nhân (ví trỏ RPC về proxy ⇒ chỉ được capture).
    expect(app).toContain("ghi lại (capture)");
  });
});
