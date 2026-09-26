/**
 * Test payload ntfy của monitor.
 *
 * Audit vòng 5 (O4): file này trước đây **nhân bản** payload của `monitor.mjs` (một hàm
 * `buildNtfyPayload` cục bộ + một bản cho drain). Bản sao đó đã lệch khỏi production từ lâu —
 * nó vẫn khẳng định Title kiểu `"Morpho Blue: Thanh khoan DAI kha dung!"`, header `Actions`,
 * `Supply APY`… trong khi production đã đổi sang `Morpho: liquidity drain <SYM>` / không còn
 * `Actions`. Nghĩa là nhóm test đó xanh nhưng **không kiểm gì cả**.
 *
 * Nay hàm dựng payload được export từ production (`monitor.mjs`) và `monitor.mjs` import không
 * có side effect (P1.5), nên test import ĐÚNG thứ đang chạy.
 *
 * Bất biến quan trọng nhất vẫn giữ nguyên: mọi **header** phải là Latin-1 (≤ U+00FF) vì undici
 * ném `ByteString` error với ký tự cao hơn; tiếng Việt có dấu chỉ được nằm trong body (UTF-8).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildNtfyPayload } from "../monitor.mjs";

const FIXTURES = {
  marketId: "0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6",
  lenderAddress: "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3",
  webappUrl: "http://localhost:3000",
};
const LINK = `${FIXTURES.webappUrl}?market=${FIXTURES.marketId}&lender=${FIXTURES.lenderAddress}`;

/** Snapshot tối thiểu đúng hình dạng mà monitor truyền vào (`market`, `position`, token…). */
const snapshot = ({
  loanSymbol = "USDC",
  collateralSymbol = "WETH",
  liquidity = 12_500_000_000n,
  supplyAssets = 3_000_000_000n,
  utilization = 500_000_000_000_000_000n,
} = {}) => ({
  id: FIXTURES.marketId,
  loanToken: { symbol: loanSymbol, decimals: 6 },
  collateralToken: { symbol: collateralSymbol, decimals: 18 },
  market: { liquidity, utilization },
  position: { supplyAssets },
});

const payload = (scenario = "liquidity_appeared", overrides = {}) =>
  buildNtfyPayload({ ...snapshot(overrides), scenario, webappUrl: FIXTURES.webappUrl, lenderAddress: FIXTURES.lenderAddress });

/** Kiểm mọi giá trị header ≤ U+00FF (điều kiện sống còn của undici). */
function assertLatin1Safe(headers, label) {
  for (const [name, value] of Object.entries(headers)) {
    for (let i = 0; i < value.length; i++) {
      const cp = value.charCodeAt(i);
      if (cp > 255) {
        throw new Error(`${label} header "${name}" has non-Latin-1 char at ${i}: U+${cp.toString(16).toUpperCase()} (${cp})`);
      }
    }
  }
}

describe("ntfy payload — sự kiện thanh khoản xuất hiện", () => {
  it("Title/Tags nói thanh khoản khả dụng và có tên token vay", () => {
    const { headers } = payload();
    expect(headers.Title).toBe("Morpho: liquidity available USDC");
    expect(headers.Tags).toBe("moneybag");
    expect(headers.Tags).not.toContain("warning");
  });

  it("Priority/Markdown/Click đúng hợp đồng ntfy", () => {
    const { headers } = payload();
    expect(headers.Priority).toBe("4");
    expect(headers.Markdown).toBe("yes");
    expect(headers.Click).toBe(LINK);
    expect(headers.Click).toMatch(/^https?:\/\//);
    expect(headers.Click).toContain("market=");
    expect(headers.Click).toContain("lender=");
  });

  it("body có intro, cặp market, số liệu đã format và link webapp", () => {
    const { body } = payload();
    expect(body).toContain("**Liquidity available**");
    expect(body).toContain("**Market:** WETH/USDC");
    expect(body).toContain("**Liquidity:** 12500 USDC");   // 12_500_000_000 @ 6dp
    expect(body).toContain("**Position:** 3000 USDC");     // 3_000_000_000 @ 6dp
    expect(body).toContain("**Utilization:** 50.00%");     // 5e17 WAD
    expect(body).toContain(`[Open withdrawal page](${LINK})`);
  });

  it("mọi header Latin-1 safe; tiếng Việt có dấu chỉ nằm trong body", () => {
    const { headers, body } = payload();
    assertLatin1Safe(headers, "available");
    // Header thật của production là ASCII; body mới được phép có dấu (UTF-8).
    for (const value of Object.values(headers)) expect(value.charCodeAt(0)).toBeLessThan(128);
    // Body hiện tại là ASCII (chỉ tiếng Anh). Không dùng regex khoảng điều khiển vì oxlint
    // `no-control-regex` cấm — kiểm bằng code point.
    expect([...body].every((ch) => ch.codePointAt(0) < 128)).toBe(true);
  });

  it("payload dùng được với undici thật (Headers/Request tự kiểm byte header)", () => {
    const { headers, body } = payload();
    expect(() => new Headers(headers)).not.toThrow();
    expect(() => new Request("https://ntfy.sh/morpho-test", { method: "POST", headers, body })).not.toThrow();
  });
});

describe("ntfy payload — sự kiện rút thanh khoản đột ngột", () => {
  it("Title/Tags là cảnh báo, không phải sự kiện tích cực", () => {
    const { headers } = payload("sudden_drain");
    expect(headers.Title).toBe("Morpho: liquidity drain USDC");
    expect(headers.Tags).toBe("warning,chart_with_downwards_trend");
    expect(headers.Tags).not.toContain("moneybag");
  });

  it("body có intro cảnh báo nhưng vẫn đủ số liệu và link", () => {
    const { body } = payload("sudden_drain");
    expect(body).toContain("**Liquidity drain warning**");
    expect(body).not.toContain("**Liquidity available**");
    expect(body).toContain("**Market:** WETH/USDC");
    expect(body).toContain(`[Open withdrawal page](${LINK})`);
  });

  it("hai kịch bản cho ra Title/Tags khác nhau, cùng Click", () => {
    const available = payload("liquidity_appeared");
    const drain = payload("sudden_drain");
    expect(available.headers.Title).not.toBe(drain.headers.Title);
    expect(available.headers.Tags).not.toBe(drain.headers.Tags);
    expect(available.headers.Click).toBe(drain.headers.Click);
  });

  it("mọi header Latin-1 safe (không emoji, không dấu)", () => {
    const { headers } = payload("sudden_drain");
    assertLatin1Safe(headers, "drain");
    expect(headers.Title).not.toContain("💰");
    expect(headers.Title).not.toContain("📉");
  });
});

describe("ntfy payload — không được quay lại bản sao", () => {
  it("file test này import payload từ production, không định nghĩa bản riêng", () => {
    const self = fs.readFileSync(new URL(import.meta.url), "utf8");
    expect(self).toContain('from "../monitor.mjs"');
    // Mẫu được viết bằng lớp ký tự để chính dòng này không tự match chính nó.
    expect(self).not.toMatch(/function build[A-Za-z]*Payload/);
  });
});

describe("ntfy payload — biên token symbol", () => {
  it("symbol ngắn và dài vẫn vào đúng Title/body", () => {
    for (const symbol of ["DAI", "USDC.e", "stETH"]) {
      const { headers, body } = payload("liquidity_appeared", { loanSymbol: symbol });
      expect(headers.Title).toContain(symbol);
      expect(body).toContain(`**Market:** WETH/${symbol}`);
      assertLatin1Safe(headers, symbol);
    }
  });

  it("symbol null ⇒ KHÔNG in chữ \"null\" vào header/body", () => {
    // Production dùng `symbol || ""` cho Title và `|| "?"` cho body — khác bản sao cũ trong test
    // (bản cũ khẳng định null biến thành chuỗi "null", tức là khẳng định hành vi production không có).
    const { headers, body } = payload("liquidity_appeared", { loanSymbol: null, collateralSymbol: null });
    expect(headers.Title).not.toContain("null");
    expect(body).not.toContain("null");
    expect(body).toContain("**Market:** ?/?");
    // formatTokenAmount rơi về "tokens" khi thiếu symbol
    expect(body).toContain("**Liquidity:** 12500 tokens");
  });

  it("liquidity/supply bằng 0 vẫn format được (không NaN)", () => {
    const { body } = payload("liquidity_appeared", { liquidity: 0n, supplyAssets: 0n, utilization: 0n });
    expect(body).toContain("**Liquidity:** 0 USDC");
    expect(body).toContain("**Position:** 0 USDC");
    expect(body).toContain("**Utilization:** 0.00%");
  });
});

// ============================================================
// Live integration: gửi thực tế đến ntfy.sh
// ============================================================
const NTFY_SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";
const TEST_TOPIC = `morpho-test-${crypto.randomBytes(4).toString("hex")}`;

// Live tests gửi request THẬT đến ntfy.sh — chỉ chạy khi NTFY_LIVE=1.
// `npm run check`/`npm test` phải hermetic (không network) nên nhóm này skip mặc định.
describe.skipIf(process.env.NTFY_LIVE !== "1")("ntfy live integration", () => {
  console.log(`\n📱 Subscribe ntfy topic để xem kết quả test:`);
  console.log(`   ${NTFY_SERVER}/${TEST_TOPIC}\n`);

  it("gửi notification thành công (200 OK)", async () => {
    const { headers, body } = payload();
    const response = await fetch(`${NTFY_SERVER}/${TEST_TOPIC}`, { method: "POST", headers, body });
    const responseBody = await response.text();
    console.log(`   Status: ${response.status}`);
    console.log(`   Response: ${responseBody}`);
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
  }, 15000);

  it("headers không gây lỗi ByteString với USDC symbol", async () => {
    const { headers, body } = payload();
    await expect(fetch(`${NTFY_SERVER}/${TEST_TOPIC}`, { method: "POST", headers, body })).resolves.toBeDefined();
  }, 15000);

  it("gửi notification với test topic riêng (không ảnh hưởng topic thật)", async () => {
    const uniqueTopic = `morpho-test-isolated-${crypto.randomBytes(3).toString("hex")}`;
    const { headers, body } = payload();
    const response = await fetch(`${NTFY_SERVER}/${uniqueTopic}`, { method: "POST", headers, body });
    console.log(`   Unique topic: ${uniqueTopic} → ${response.status}`);
    expect(response.ok).toBe(true);
  }, 15000);

  it("gửi notification thành công với DAI symbol", async () => {
    const { headers, body } = payload("sudden_drain", { loanSymbol: "DAI" });
    const response = await fetch(`${NTFY_SERVER}/${TEST_TOPIC}`, { method: "POST", headers, body });
    expect(response.ok).toBe(true);
  }, 15000);

  it("gửi notification thành công với stETH symbol (có ký tự đặc biệt)", async () => {
    const { headers, body } = payload("liquidity_appeared", { loanSymbol: "stETH" });
    const response = await fetch(`${NTFY_SERVER}/${TEST_TOPIC}`, { method: "POST", headers, body });
    expect(response.ok).toBe(true);
  }, 15000);

  it("body gửi đi khớp body production", async () => {
    const { headers, body } = payload();
    const response = await fetch(`${NTFY_SERVER}/${TEST_TOPIC}`, { method: "POST", headers, body });
    expect(response.ok).toBe(true);
    expect(body).toContain("**Liquidity available**");
    expect(body).toContain(`[Open withdrawal page](${LINK})`);
  }, 15000);

  it("tất cả header values là Latin-1 safe (≤ U+00FF)", async () => {
    const { headers } = payload();
    assertLatin1Safe(headers, "live");
  });
});
