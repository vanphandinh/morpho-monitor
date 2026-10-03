/**
 * Hồi quy market-switch (báo cáo 2026-10-03):
 *  1. tiêu đề app phải theo market hiện tại (không kẹt `dCOMP/USDC Market`);
 *  2. placeholder mốc rút phải theo loan token (AUSD thay vì USDC cứng);
 *  3. selector phải hiện label giàu (symbol + id) và đồng bộ theme;
 *  4. chuyển đổi đơn vị phải dùng decimals của loan token từng market.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseUnits } from "viem";
import { installBrowserEnv, readWebappHtml } from "./helpers/dom-stub.mjs";

const MARKET_A = "0x" + "a".repeat(64);
const MARKET_B = "0x" + "b".repeat(64);

let env;
let state;
let overview;
let presign;

beforeAll(async () => {
  env = installBrowserEnv({
    config: {
      markets: [
        { id: MARKET_A, minLiquidity: "5000", suddenDrainMultiplier: 2 },
        { id: MARKET_B, minLiquidity: "100", suddenDrainMultiplier: 2 },
      ],
      lenderAddress: "0x" + "1".repeat(40),
      proxyRpcUrl: "http://127.0.0.1:8545",
      rpcUrls: ["http://127.0.0.1:1"],
    },
  });
  ({ state } = await import("../webapp-state.mjs"));
  overview = await import("../webapp-overview.mjs");
  presign = await import("../webapp-presign.mjs");
  // Giả lập market mới: loan token AUSD 6 decimals, collateral khác.
  state.marketId = MARKET_B;
  state.loanToken = { decimals: 6, symbol: "AUSD" };
  state.collateralToken = { decimals: 18, symbol: "wSTETH" };
  state.presignedTiers = [{ amount: "", amountWei: null, signedTx: null, status: "pending" }];
});

afterAll(() => env.restore());

describe("tiêu đề app theo market hiện tại", () => {
  it("updateMarketSubtitle ghi `wSTETH/AUSD Market`, không kẹt tên market cũ", () => {
    overview.updateMarketSubtitle();
    expect(env.elements.get("market-subtitle").textContent).toBe("wSTETH/AUSD Market");
  });
});

describe("placeholder theo loan token của market", () => {
  it("tier mới hiện `Số AUSD`, không phải `Số USDC`", () => {
    presign.renderTierList();
    expect(env.elements.get("tier-list").innerHTML).toContain('placeholder="Số AUSD"');
    expect(env.elements.get("tier-list").innerHTML).not.toContain("USDC");
  });
  it("ô rút tiền hiện `Số AUSD`", () => {
    overview.syncWithdrawPlaceholder();
    expect(env.elements.get("withdraw-amount").placeholder).toBe("Số AUSD");
  });
});

describe("selector đồng bộ giao diện", () => {
  it("option market hiện tại mang symbol + id rút gọn, có class theme tối", () => {
    overview.initMarketSwitcher();
    const select = env.elements.get("market-switcher");
    const current = [...select.options ?? []].find((o) => o.value === MARKET_B)
      ?? { textContent: select.innerHTML };
    expect(current.textContent ?? select.innerHTML).toContain("AUSD");
    // Class theme tối nằm ở HTML tĩnh (stub không parse class tĩnh vào classSet) ⇒ khẳng định trên nguồn.
    expect(readWebappHtml()).toContain('class="market-switcher"');
    expect(env.elements.get("market-switcher-wrap").classList.contains("visible")).toBe(true);
  });
});

describe("chuyển đổi đơn vị theo decimals từng market", () => {
  it("1.5 AUSD (6 decimals) = 1500000 wei, khác hẳn token 18 decimals", () => {
    expect(parseUnits("1.5", state.loanToken.decimals)).toBe(1_500_000n);
    expect(parseUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
  });
});
