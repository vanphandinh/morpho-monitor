/**
 * Round-4 audit (quota RPC, 2026-09-25): webapp public KHÔNG ĐƯỢC inject
 * RPC_URLS của server — toàn bộ endpoint đó mang API key (drpc/alchemy trong
 * path, ankr 64-hex, chainstack 32-hex, onfinality ?apikey=). Docker publish
 * port 3000 ⇒ mỗi visitor đọc được window.MORPHO_CONFIG là bóc lịch key.
 *
 * Hợp đồng ghim ở đây:
 * 1. Browser chỉ nhận PUBLIC_RPC_URLS (mặc định: endpoint key-less duy nhất).
 * 2. PUBLIC_RPC_URLS vẫn dùng được cho server (UI tự render), nhưng khi nó
 *    chứa endpoint kèm key thì lỗi cấu hình phải bị chặn — fail closed thay vì
 *    bóc lịch ra public.
 * 3. Output KHÔNG BAO GIỜ chứa URL khớp mẫu credential, kể cả khi override.
 */
import { describe, expect, it } from "vitest";
import { buildWebappConfig } from "../webapp-config.mjs";

const MARKET = { id: "0x" + "a".repeat(64), minLiquidity: "100", suddenDrainMultiplier: 2 };
const LENDER = "0x" + "b".repeat(40);

/** Mẫu URL mang credential thật (chỉ định dạng, không phải key thật). */
const WITH_CREDENTIALS = [
  "https://eth-mainnet.g.alchemy.com/v2/" + "f".repeat(32),
  "https://lb.drpc.live/ethereum/" + "a".repeat(43) + "X",
  "https://rpc.ankr.com/eth/" + "0".repeat(64),
  "https://ethereum-mainnet.core.chainstack.com/" + "c".repeat(32),
  "https://eth.api.onfinality.io/rpc?apikey=secret",
];

/** URL khớp mẫu credential: key trong path (hex dài) hoặc query apikey. */
function looksCredentialed(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("apikey") || u.searchParams.has("api_key") || u.searchParams.has("key")) return true;
    const path = u.pathname;
    if (u.hostname.endsWith("alchemy.com") && /\/v2\/[0-9a-zA-Z_-]+$/.test(path)) return true;
    if (u.hostname.endsWith("drpc.live") && /\/ethereum\/[0-9a-zA-Z_-]+$/.test(path)) return true;
    if (u.hostname.endsWith("chainstack.com") && /\/[0-9a-fA-F]{32,}$/.test(path)) return true;
    if (u.hostname.endsWith("ankr.com") && /^\/eth\/[0-9a-fA-F]{32,}$/.test(path)) return true;
    return false;
  } catch {
    return false; // URL không parse được không phải mẫu credential
  }
}

describe("buildWebappConfig — webapp chỉ nhận RPC key-less (round-4 quota)", () => {
  it("default: inject đúng 1 endpoint key-less publicnode, không đọc RPC_URLS", () => {
    const config = buildWebappConfig({
      markets: [MARKET],
      lenderAddress: LENDER,
      proxyRpcUrl: "https://vps.example.com:8545",
    });
    expect(config.rpcUrls).toEqual(["https://ethereum-rpc.publicnode.com"]);
  });

  it("override publicRpcUrls được tôn trọng", () => {
    const config = buildWebappConfig({
      markets: [MARKET],
      lenderAddress: LENDER,
      proxyRpcUrl: "https://vps.example.com:8545",
      publicRpcUrls: ["https://eth.llamarpc.com", "https://ethereum-rpc.publicnode.com"],
    });
    expect(config.rpcUrls).toEqual(["https://eth.llamarpc.com", "https://ethereum-rpc.publicnode.com"]);
  });

  it("KHÔNG chấp nhận rpcUrls có key: inject sẽ bóc lịch ⇒ fail closed", () => {
    expect(() =>
      buildWebappConfig({
        markets: [MARKET],
        lenderAddress: LENDER,
        proxyRpcUrl: "https://vps.example.com:8545",
        publicRpcUrls: WITH_CREDENTIALS,
      })
    ).toThrow(/key|credential/i);
  });

  it("output không bao giờ chứa URL khớp mẫu credential (kể cả mix hợp lệ/lệ)", () => {
    let config = null;
    try {
      config = buildWebappConfig({
        markets: [MARKET],
        lenderAddress: LENDER,
        proxyRpcUrl: "https://vps.example.com:8545",
        publicRpcUrls: ["https://eth.llamarpc.com", ...WITH_CREDENTIALS, "https://rpc.ankr.com/eth"],
      });
    } catch {
      // Hàm fail closed ⇒ config giữ null; assertion dưới là lưới an toàn nếu ai
      // sau này đổi hành vi: mọi URL xuất hiện trong output phải key-less.
    }
    for (const url of config?.rpcUrls ?? []) {
      expect(looksCredentialed(url)).toBe(false);
    }
  });
});
