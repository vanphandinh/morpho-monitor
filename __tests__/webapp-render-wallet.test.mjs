/**
 * Audit P2.7 — test trực tiếp cho hai module browser tách từ webapp-app.mjs.
 *
 * Cùng lý do với A.1b: hàm thuần phải import được trong test, nếu không thì test
 * chỉ có thể NHÂN BẢN chúng và có thể xanh trong khi bản chạy trong browser đã khác.
 * `webapp-render.mjs` / `webapp-wallet.mjs` là module THẬT mà webapp-app.mjs import
 * (route do webapp-handler.mjs phục vụ), nên test ở đây chạm đúng code production.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { esc, row, formatToken } from "../webapp-render.mjs";
import { getWalletProviderName, getCompatibilityMessage } from "../webapp-wallet.mjs";
import { formatTokenAmount } from "../shared.mjs";

const readSource = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("webapp-render.mjs: esc()", () => {
  it("escape đủ 5 ký tự HTML nguy hiểm", () => {
    expect(esc(`<script>"a"&'b'</script>`)).toBe("&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;");
  });

  it("null/undefined/0 → chuỗi an toàn", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc(0)).toBe("0");
    expect(esc("USDC")).toBe("USDC");
  });
});

describe("webapp-render.mjs: row() / formatToken()", () => {
  it("row() dựng đúng markup label/value (value là HTML đã render)", () => {
    expect(row("Liquidity", "<b>1 USDC</b>")).toBe(
      '<div class="row"><span class="label">Liquidity</span><span class="value"><b>1 USDC</b></span></div>',
    );
  });

  it("formatToken() theo decimals + symbol của token", () => {
    expect(formatToken(1_000_000n, { decimals: 6, symbol: "USDC" })).toBe("1 USDC");
    expect(formatToken(0n, { decimals: 18, symbol: "WETH" })).toBe("0 WETH");
  });

  // Lưới an toàn P2.7: browser không import được shared.mjs, nên formatToken và
  // formatTokenAmount là hai bản cho cùng một phép format. Lệch nhau ⇒ card trong
  // webapp hiển thị khác thông báo của monitor.
  it("formatToken khớp formatTokenAmount của shared.mjs trên nhiều mẫu", () => {
    const samples = [0n, 1n, 1_000_000n, 123_456_789n, 1_000_000_000_000_000_000n];
    for (const amount of samples) {
      expect(formatToken(amount, { decimals: 6, symbol: "USDC" })).toBe(formatTokenAmount(amount, 6, "USDC"));
    }
  });
});

describe("webapp-wallet.mjs: nhận diện ví (brand-only)", () => {
  afterEach(() => {
    delete globalThis.window;
  });

  it("chưa có provider ⇒ null", () => {
    globalThis.window = {};
    expect(getWalletProviderName()).toBe(null);
  });

  it("nhận diện theo cờ EIP-1193, ưu tiên rabby > metamask", () => {
    globalThis.window = { ethereum: { isMetaMask: true, isRabby: true } };
    expect(getWalletProviderName()).toBe("rabby");
    globalThis.window = { ethereum: { isMetaMask: true } };
    expect(getWalletProviderName()).toBe("metamask");
    globalThis.window = { ethereum: {} };
    expect(getWalletProviderName()).toBe("unknown");
  });

  // H5 preflight gate đã bị gỡ (2026-09-24): MỌI ví đều ok — nếu ai đó vô tình
  // trả ok:false cho một ví, preflight sẽ chặn người dùng ký.
  it("mọi ví đều ok: true", () => {
    for (const provider of [null, {}, { isRabby: true }, { isMetaMask: true }, { isAmbire: true }, { isFrame: true }, { isCoinbaseWallet: true }, { isTrust: true }]) {
      globalThis.window = provider === null ? {} : { ethereum: provider };
      expect(getCompatibilityMessage().ok).toBe(true);
    }
  });
});

describe("P2.7 — webapp-app.mjs dùng module chung, không còn bản sao cục bộ", () => {
  const app = readSource("webapp-app.mjs");
  const render = readSource("webapp-render.mjs");
  const wallet = readSource("webapp-wallet.mjs");

  it("import cả hai module", () => {
    expect(app).toContain('from "./webapp-render.mjs"');
    expect(app).toContain('from "./webapp-wallet.mjs"');
  });

  it("không định nghĩa lại các hàm đã tách", () => {
    for (const name of ["esc", "row", "formatToken", "getWalletProviderName", "getCompatibilityMessage"]) {
      expect(app).not.toMatch(new RegExp(`function ${name}\\b`));
    }
  });

  it("module render/wallet không chạm DOM (chỉ wallet đọc window.ethereum)", () => {
    expect(render).not.toMatch(/\bdocument\b|\bwindow\b|localStorage/);
    expect(wallet).not.toMatch(/\bdocument\b|localStorage/);
  });
});
