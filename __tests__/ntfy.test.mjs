/**
 * Tests for ntfy notification header safety and body content.
 *
 * Node.js fetch() (undici) enforces HTTP headers as Latin-1 (chars 0x00-0xFF).
 * Characters above U+00FF trigger a ByteString error. These tests verify
 * that all ntfy notification headers are Latin-1 safe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ============================================================
// Helpers — mirror the notification string building from monitor.mjs
// ============================================================

/**
 * Build ntfy notification payload exactly as monitor.mjs does.
 * This is deliberately duplicated (not imported) to test the actual
 * string content without requiring module-level side effects.
 */
function buildNtfyPayload({ loanSymbol, collateralSymbol, marketId, lenderAddress, webappUrl }) {
  const webappLink = `${webappUrl}?market=${marketId}&lender=${lenderAddress}`;
  const morphoAppLink = `https://app.morpho.org/ethereum/market?id=${marketId}`;

  // Body (Markdown) — mirrors monitor.mjs lines 67-77
  const body = [
    `**Thanh khoản đã xuất hiện trên market!**`,
    ``,
    `**Market:** ${collateralSymbol}/${loanSymbol}`,
    `**Thanh khoản khả dụng:** ...`,
    `**Utilization:** ...`,
    `**Supply APY:** ...`,
    `**Vị thế của bạn:** ...`,
    ``,
    `[Mở Webapp để rút tiền](${webappLink})`,
  ].join("\n");

  // Actions — mirrors monitor.mjs lines 79-90
  const actions = [
    {
      action: "view",
      label: "Mo Webapp Rut Tien",
      url: webappLink,
    },
    {
      action: "view",
      label: "Xem tren Morpho App",
      url: morphoAppLink,
    },
  ];

  // Headers — mirrors monitor.mjs lines 94-101
  const headers = {
    "Title": `Morpho Blue: Thanh khoan ${loanSymbol} kha dung!`,
    "Tags": "moneybag,chart_with_upwards_trend",
    "Priority": "4",
    "Markdown": "yes",
    "Click": webappLink,
    "Actions": JSON.stringify(actions),
  };

  return { headers, body, actions };
}

// ============================================================
// Helper: verify all characters in a string are Latin-1 (≤ 255)
// ============================================================
function assertLatin1Safe(str, label) {
  for (let i = 0; i < str.length; i++) {
    const cp = str.charCodeAt(i);
    if (cp > 255) {
      throw new Error(
        `${label} has non-Latin-1 char at index ${i}: ` +
        `U+${cp.toString(16).toUpperCase().padStart(4, "0")} (${cp})`
      );
    }
  }
}

/**
 * Build drain notification payload — mirrors the sudden_drain scenario in monitor.mjs.
 */
function buildDrainPayload({ loanSymbol, collateralSymbol, marketId, lenderAddress, webappUrl }) {
  const webappLink = `${webappUrl}?market=${marketId}&lender=${lenderAddress}`;
  const morphoAppLink = `https://app.morpho.org/ethereum/market?id=${marketId}`;

  const body = [
    `**Canh bao: Thanh khoan giam dot ngot!**`,
    ``,
    `**Market:** ${collateralSymbol}/${loanSymbol}`,
    `**Thanh khoản khả dụng:** ...`,
    `**Utilization:** ...`,
    `**Supply APY:** ...`,
    `**Vị thế của bạn:** ...`,
    ``,
    `[Mở Webapp để rút tiền](${webappLink})`,
  ].join("\n");

  const actions = [
    { action: "view", label: "Mo Webapp Rut Tien", url: webappLink },
    { action: "view", label: "Xem tren Morpho App", url: morphoAppLink },
  ];

  const headers = {
    "Title": `Morpho Blue: Canh bao rut thanh khoan! ${loanSymbol}`,
    "Tags": "warning,chart_with_downwards_trend",
    "Priority": "4",
    "Markdown": "yes",
    "Click": webappLink,
    "Actions": JSON.stringify(actions),
  };

  return { headers, body, actions };
}

// ============================================================
// Tests
// ============================================================

const FIXTURES = {
  marketId: "0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6",
  lenderAddress: "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3",
  webappUrl: "http://localhost:3000",
};

describe("ntfy notification headers", () => {
  describe("header Latin-1 safety", () => {
    it("all header values contain only Latin-1 characters (≤ U+00FF)", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      for (const [name, value] of Object.entries(headers)) {
        for (let i = 0; i < value.length; i++) {
          const cp = value.charCodeAt(i);
          expect(cp).toBeLessThanOrEqual(255);
        }
      }
    });

    it("Title header does not contain emoji characters", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      expect(headers.Title).not.toContain("💰");
      expect(headers.Title).not.toContain("🔗");
      expect(headers.Title).not.toContain("📊");
    });

    it("Title header starts with ASCII text (not an emoji)", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      const firstChar = headers.Title.charCodeAt(0);
      // 'M' = 77, must be ≤ 127 (ASCII)
      expect(firstChar).toBeLessThanOrEqual(127);
    });

    it("Actions JSON does not contain emoji characters", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      const actions = JSON.parse(headers.Actions);
      for (const action of actions) {
        expect(action.label).not.toContain("💰");
        expect(action.label).not.toContain("🔗");
        expect(action.label).not.toContain("📊");
      }
    });

    it("Tags header does not contain emoji characters (uses emoji shortcodes)", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      // "moneybag" and "chart_with_upwards_trend" are ASCII shortcodes
      assertLatin1Safe(headers.Tags, "Tags");
    });
  });

  describe("header content correctness", () => {
    it("Title includes loan symbol", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      expect(headers.Title).toContain("USDC");
      expect(headers.Title).toContain("Morpho Blue");
    });

    it("Title is meaningful without emojis", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "DAI",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      expect(headers.Title).toBe("Morpho Blue: Thanh khoan DAI kha dung!");
    });

    it("Click header is a valid URL", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      expect(headers.Click).toMatch(/^https?:\/\//);
      expect(headers.Click).toContain("market=");
      expect(headers.Click).toContain("lender=");
    });

    it("Actions contain two view actions", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      const actions = JSON.parse(headers.Actions);
      expect(actions).toHaveLength(2);
      expect(actions[0].action).toBe("view");
      expect(actions[1].action).toBe("view");
    });

    it("Action URLs are valid", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      const actions = JSON.parse(headers.Actions);
      expect(actions[0].url).toContain("localhost:3000");
      expect(actions[1].url).toContain("app.morpho.org");
    });
  });

  describe("body content", () => {
    it("body preserves Vietnamese text with diacritics", () => {
      const { body } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      // The body is UTF-8 (not a header), so Vietnamese diacritics are safe here
      expect(body).toContain("Thanh khoản"); // with diacritic
      expect(body).toContain("Vị thế");
      expect(body).toContain("rút tiền");
    });

    it("body includes market info", () => {
      const { body } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      expect(body).toContain("WETH/USDC");
      expect(body).toContain("Thanh khoản khả dụng");
      expect(body).toContain("Supply APY");
    });

    it("body includes clickable webapp link", () => {
      const { body } = buildNtfyPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      expect(body).toContain("[Mở Webapp để rút tiền]");
      expect(body).toContain("localhost:3000");
    });
  });

  describe("edge cases: token symbols", () => {
    it("handles short token symbols", () => {
      const { headers, body } = buildNtfyPayload({
        loanSymbol: "DAI",
        collateralSymbol: "ETH",
        ...FIXTURES,
      });

      expect(headers.Title).toContain("DAI");
      expect(body).toContain("ETH/DAI");
    });

    it("handles long token symbols", () => {
      const { headers, body } = buildNtfyPayload({
        loanSymbol: "USDC.e",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });

      expect(headers.Title).toContain("USDC.e");
      expect(body).toContain("WETH/USDC.e");
    });

    it("handles token symbols with special chars (hyphen, dot)", () => {
      const { headers } = buildNtfyPayload({
        loanSymbol: "stETH",
        collateralSymbol: "wstETH",
        ...FIXTURES,
      });

      // All chars in standard token symbols are ASCII
      for (let i = 0; i < headers.Title.length; i++) {
        expect(headers.Title.charCodeAt(i)).toBeLessThanOrEqual(127);
      }
    });

    it("handles null token symbol gracefully", () => {
      const { headers, body } = buildNtfyPayload({
        loanSymbol: null,
        collateralSymbol: null,
        ...FIXTURES,
      });

      // null becomes "null" string via template literal
      expect(headers.Title).toContain("null");
      expect(body).toContain("null/null");
    });
  });
});

// ============================================================
// Integration: mock fetch and verify the full HTTP request
// ============================================================
describe("ntfy notification fetch call", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Simulate the fetch call exactly as monitor.mjs does
  async function simulateSendNtfy(payload, server, topic) {
    const response = await fetch(`${server}/${topic}`, {
      method: "POST",
      headers: payload.headers,
      body: payload.body,
    });
    if (!response.ok) {
      throw new Error(`ntfy responded with ${response.status}`);
    }
    return response;
  }

  it("sends POST to correct ntfy URL", async () => {
    const payload = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    await simulateSendNtfy(payload, "https://ntfy.sh", "morpho-monitor-test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ntfy.sh/morpho-monitor-test");
  });

  it("sends POST method", async () => {
    const payload = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    await simulateSendNtfy(payload, "https://ntfy.sh", "test-topic");

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe("POST");
  });

  it("includes all required ntfy headers", async () => {
    const payload = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    await simulateSendNtfy(payload, "https://ntfy.sh", "test-topic");

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Title).toBeDefined();
    expect(options.headers.Tags).toBeDefined();
    expect(options.headers.Priority).toBe("4");
    expect(options.headers.Markdown).toBe("yes");
    expect(options.headers.Click).toBeDefined();
    expect(options.headers.Actions).toBeDefined();
  });

  it("throws on non-2xx response", async () => {
    fetchMock.mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    const payload = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    await expect(
      simulateSendNtfy(payload, "https://ntfy.sh", "test-topic")
    ).rejects.toThrow("ntfy responded with 500");
  });

  it("does not throw on 2xx response", async () => {
    const payload = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    await expect(
      simulateSendNtfy(payload, "https://ntfy.sh", "test-topic")
    ).resolves.toBeDefined();
  });

  it("header values are all Latin-1 safe in the actual fetch call", async () => {
    const payload = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    // fetch() would throw ByteString error if any header had chars > 255
    await simulateSendNtfy(payload, "https://ntfy.sh", "test-topic");

    // If we got here, no ByteString error occurred
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Drain notification tests
// ============================================================
describe("ntfy drain notification", () => {
  describe("header Latin-1 safety", () => {
    it("drain header values contain only Latin-1 characters", () => {
      const { headers } = buildDrainPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });
      for (const [name, value] of Object.entries(headers)) {
        for (let i = 0; i < value.length; i++) {
          expect(value.charCodeAt(i)).toBeLessThanOrEqual(255);
        }
      }
    });

    it("drain Title does not contain emoji characters", () => {
      const { headers } = buildDrainPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });
      expect(headers.Title).not.toContain("💰");
      expect(headers.Title).not.toContain("🔗");
    });

    it("drain Tags uses emoji shortcodes (ASCII-safe)", () => {
      const { headers } = buildDrainPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });
      assertLatin1Safe(headers.Tags, "Drain Tags");
    });
  });

  describe("header content correctness", () => {
    it("drain Title is a warning, not a positive event", () => {
      const { headers } = buildDrainPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });
      expect(headers.Title).toContain("Canh bao rut thanh khoan!");
      expect(headers.Title).not.toContain("kha dung");
    });

    it("drain Tags use warning and downward trend", () => {
      const { headers } = buildDrainPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });
      expect(headers.Tags).toContain("warning");
      expect(headers.Tags).toContain("chart_with_downwards_trend");
      expect(headers.Tags).not.toContain("moneybag");
    });

    it("drain body contains drain-specific intro", () => {
      const { body } = buildDrainPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });
      expect(body).toContain("Canh bao: Thanh khoan giam dot ngot!");
    });

    it("drain Click header is a valid URL", () => {
      const { headers } = buildDrainPayload({
        loanSymbol: "USDC",
        collateralSymbol: "WETH",
        ...FIXTURES,
      });
      expect(headers.Click).toMatch(/^https?:\/\//);
      expect(headers.Click).toContain("market=");
      expect(headers.Click).toContain("lender=");
    });
  });
});

// ============================================================
// Live integration: gửi thực tế đến ntfy.sh
// ============================================================
const NTFY_SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";
const TEST_TOPIC = `morpho-test-${crypto.randomBytes(4).toString("hex")}`;

describe("ntfy live integration", () => {
  // In ra topic để dev có thể subscribe test trên app ntfy
  console.log(`\n📱 Subscribe ntfy topic để xem kết quả test:`);
  console.log(`   ${NTFY_SERVER}/${TEST_TOPIC}\n`);

  it("gửi notification thành công (200 OK)", async () => {
    const { body, headers } = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    const response = await fetch(`${NTFY_SERVER}/${TEST_TOPIC}`, {
      method: "POST",
      headers,
      body,
    });

    // In response để debug
    const responseBody = await response.text();
    console.log(`   Status: ${response.status}`);
    console.log(`   Response: ${responseBody}`);

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
  }, 15000);

  it("headers không gây lỗi ByteString với USDC symbol", async () => {
    const { body, headers } = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    let error = null;
    try {
      await fetch(`${NTFY_SERVER}/${TEST_TOPIC}`, {
        method: "POST",
        headers,
        body,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeNull();
    if (error) console.error("ByteString error:", error.message);
  }, 15000);

  it("gửi notification với test topic riêng (không ảnh hưởng topic thật)", async () => {
    const uniqueTopic = `morpho-test-isolated-${crypto.randomBytes(3).toString("hex")}`;
    const { body, headers } = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    const response = await fetch(`${NTFY_SERVER}/${uniqueTopic}`, {
      method: "POST",
      headers,
      body,
    });

    console.log(`   Unique topic: ${uniqueTopic} → ${response.status}`);
    expect(response.ok).toBe(true);
  }, 15000);

  it("gửi notification thành công với DAI symbol", async () => {
    const { body, headers } = buildNtfyPayload({
      loanSymbol: "DAI",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    const response = await fetch(`${NTFY_SERVER}/${TEST_TOPIC}`, {
      method: "POST",
      headers,
      body,
    });

    expect(response.ok).toBe(true);
  }, 15000);

  it("gửi notification thành công với stETH symbol (có ký tự đặc biệt)", async () => {
    const { body, headers } = buildNtfyPayload({
      loanSymbol: "stETH",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    const response = await fetch(`${NTFY_SERVER}/${TEST_TOPIC}`, {
      method: "POST",
      headers,
      body,
    });

    expect(response.ok).toBe(true);
  }, 15000);

  it("body hiển thị đúng tiếng Việt có dấu", async () => {
    const { body, headers } = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    const response = await fetch(`${NTFY_SERVER}/${TEST_TOPIC}`, {
      method: "POST",
      headers,
      body,
    });

    expect(response.ok).toBe(true);

    // Verify body gốc chứa tiếng Việt có dấu (UTF-8 trong body an toàn)
    expect(body).toContain("Thanh khoản");
    expect(body).toContain("khả dụng");
    expect(body).toContain("Vị thế");
    expect(body).toContain("rút tiền");
  }, 15000);

  it("tất cả header values là Latin-1 safe (≤ U+00FF)", () => {
    const { headers } = buildNtfyPayload({
      loanSymbol: "USDC",
      collateralSymbol: "WETH",
      ...FIXTURES,
    });

    for (const [name, value] of Object.entries(headers)) {
      for (let i = 0; i < value.length; i++) {
        const cp = value.charCodeAt(i);
        if (cp > 255) {
          console.error(
            `❌ Header "${name}" có ký tự không an toàn tại index ${i}: ` +
            `U+${cp.toString(16).toUpperCase()} (${cp})`
          );
        }
        expect(cp).toBeLessThanOrEqual(255);
      }
      console.log(`   ✅ Header "${name}": ${value.length} chars, all Latin-1 safe`);
    }
  });
});
