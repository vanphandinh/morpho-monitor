/**
 * A3 + M2 + B2: cấu hình browser của webapp.
 *
 * - `buildWebappConfig`/`injectWebappConfig` (webapp-config.mjs) là production
 *   code; test import trực tiếp (không boot server, không listen).
 * - `webapp.html` được đọc dưới dạng text để khẳng định: không còn API key của
 *   nhà cung cấp RPC trong file phục vụ công khai; từ 2026-09-24 cổng preflight
 *   H5 đã gỡ theo quyết định user (mục sign flow bên dưới).
 *
 * Lưu ý: webapp.html là browser ESM (không import được bằng vitest), nên các
 * assertion chạy trên text của file — cùng convention với webapp.test.mjs.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebappConfig, injectWebappConfig, assertWebappAuthConfig, assertProxyAuthConfig } from "../webapp-config.mjs";
import { RECOVERY_THRESHOLD_MS } from "../presigned-broadcast.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "..", "webapp.html"), "utf8");

const MARKET = { id: "0x" + "a".repeat(64), minLiquidity: "100", suddenDrainMultiplier: 2 };
const LENDER = "0x" + "b".repeat(40);

describe("buildWebappConfig (A3)", () => {
  it("derive proxy URL + rpcUrls + markets từ shared/args", () => {
    const config = buildWebappConfig({
      markets: [MARKET],
      lenderAddress: LENDER,
      proxyRpcUrl: "https://vps.example.com:8545",
      rpcUrls: ["https://rpc.example.com", "  "],
    });
    expect(config.markets).toEqual([MARKET]);
    expect(config.lenderAddress).toBe(LENDER);
    expect(config.proxyRpcUrl).toBe("https://vps.example.com:8545");
    expect(config.rpcUrls).toEqual(["https://rpc.example.com"]); // blank filtered
    // R1: ngưỡng quá hạn của claim broadcasting phải là MỘT nguồn sự thật
    // (presigned-broadcast.mjs), inject cho browser thay vì copy hằng số.
    expect(config.claimRecoveryMs).toBe(RECOVERY_THRESHOLD_MS);
  });

  it("C3: thiếu/zero LENDER_ADDRESS → fail-fast với hướng dẫn tiếng Việt", () => {
    for (const lenderAddress of ["", "   ", "0x0000000000000000000000000000000000000000", "not-an-address"]) {
      expect(() => buildWebappConfig({ markets: [MARKET], lenderAddress })).toThrow(/LENDER_ADDRESS/);
    }
  });

  it("C3: thiếu PROXY_RPC_URL → fail-fast (không để browser rơi về 127.0.0.1)", () => {
    expect(() => buildWebappConfig({ markets: [MARKET], lenderAddress: LENDER, proxyRpcUrl: "" })).toThrow(/PROXY_RPC_URL/);
  });

  it("từ chối markets rỗng và RPC_URLS rỗng", () => {
    expect(() => buildWebappConfig({ markets: [], lenderAddress: LENDER })).toThrow(/markets\.json/);
    expect(() => buildWebappConfig({ markets: [MARKET], lenderAddress: LENDER, rpcUrls: [] })).toThrow(/RPC_URLS/);
  });
});

describe("injectWebappConfig (A3)", () => {
  it("chèn window.MORPHO_CONFIG ngay trước </head> và escape `<`", () => {
    const out = injectWebappConfig("<html><head></head><body>x</body></html>", {
      markets: [MARKET],
      lenderAddress: LENDER,
      proxyRpcUrl: "https://evil.example.com/</script><script>alert(1)</script>",
      rpcUrls: ["https://rpc.example.com"],
    });
    expect(out).toContain("window.MORPHO_CONFIG=");
    expect(out).not.toContain("</script><script>alert(1)");
    expect(out).toContain("\\u003c/script");
    const payload = out.slice(out.indexOf("window.MORPHO_CONFIG=") + "window.MORPHO_CONFIG=".length, out.indexOf("</script></head>"));
    expect(JSON.parse(payload).rpcUrls).toEqual(["https://rpc.example.com"]);
  });

  it("thiếu marker </head> → throw rõ ràng thay vì im lặng không inject", () => {
    expect(() => injectWebappConfig("<html></html>", {})).toThrow(/<\/head>/);
  });
});

describe("webapp.html hygiene (M2)", () => {
  it("không còn RPC URL kèm API key trong file phục vụ công khai", () => {
    expect(html).not.toMatch(/infura\.io\/v3\//);
    expect(html).not.toMatch(/ankr\.com\/eth\/0x/);
    expect(html).not.toMatch(/alchemy\.com\/v2\//);
    expect(html).not.toMatch(/lb\.drpc\.live\/ethereum\//);
    expect(html).not.toMatch(/core\.chainstack\.com\//);
    expect(html).not.toMatch(/onfinality\.io\/rpc\?apikey=/);
  });

  it("dùng CFG.rpcUrls do server inject, với fallback keyless", () => {
    expect(html).toMatch(/const RPC_URLS = \(Array\.isArray\(CFG\.rpcUrls\)/);
    expect(html).toMatch(/https:\/\/ethereum-rpc\.publicnode\.com/);
    expect(html).toMatch(/https:\/\/rpc\.ankr\.com\/eth"/); // endpoint công khai, không key
  });
});

describe("assertWebappAuthConfig (P1, 2026-09-24)", () => {
  it("thiếu WEBAPP_PASSWORD mà không override → fail-fast, message có đủ 2 hướng dẫn", () => {
    let err = null;
    try { assertWebappAuthConfig({ password: "", allowInsecure: false }); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.message).toContain("WEBAPP_PASSWORD");
    expect(err.message).toContain("WEBAPP_ALLOW_INSECURE=1");
  });

  it("WEBAPP_ALLOW_INSECURE=1 → dev mode có chủ đích, kèm cảnh báo", () => {
    const mode = assertWebappAuthConfig({ password: "", allowInsecure: true });
    expect(mode.secure).toBe(false);
    expect(mode.warning).toMatch(/MỞ hoàn toàn/);
  });

  it("có WEBAPP_PASSWORD → secure, không cảnh báo", () => {
    expect(assertWebappAuthConfig({ password: "s3cret" })).toEqual({ secure: true, warning: null });
  });
});

describe("assertProxyAuthConfig (R3)", () => {
  it("loopback không cần mật khẩu (dev) — không cảnh báo, không throw", () => {
    for (const host of [undefined, "127.0.0.1", "localhost", "::1"]) {
      expect(assertProxyAuthConfig({ host, password: "", allowInsecure: false })).toEqual({ secure: false, warning: null, publicBind: false });
    }
  });

  it("bind PUBLIC mà thiếu mật khẩu ⇒ fail-fast, message có hành động", () => {
    let err = null;
    try { assertProxyAuthConfig({ host: "0.0.0.0", password: "", allowInsecure: false }); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.message).toContain("PROXY_HOST=0.0.0.0");
    expect(err.message).toContain("WEBAPP_PASSWORD");
    expect(err.message).toContain("WEBAPP_ALLOW_INSECURE=1");
    expect(err.message).toContain("127.0.0.1");
  });

  it("WEBAPP_ALLOW_INSECURE=1 ⇒ chạy được nhưng cảnh báo rõ /captured mở", () => {
    const mode = assertProxyAuthConfig({ host: "0.0.0.0", password: "", allowInsecure: true });
    expect(mode.secure).toBe(false);
    expect(mode.publicBind).toBe(true);
    expect(mode.warning).toContain("/captured");
  });

  it("có mật khẩu + loopback ⇒ secure, im lặng", () => {
    expect(assertProxyAuthConfig({ host: "127.0.0.1", password: "s3cret" })).toEqual({ secure: true, warning: null, publicBind: false });
  });

  // D3 (audit vòng 2): mật khẩu KHÔNG làm proxy kín — nhánh JSON-RPC vẫn công khai
  // (ví không gửi được header Authorization). Trước đây trường hợp này im lặng.
  it("có mật khẩu + bind public ⇒ vẫn secure nhưng CẢNH BÁO relay JSON-RPC mở (D3)", () => {
    const mode = assertProxyAuthConfig({ host: "0.0.0.0", password: "s3cret" });
    expect(mode.secure).toBe(true);
    expect(mode.publicBind).toBe(true);
    expect(typeof mode.warning).toBe("string");
    expect(mode.warning).toContain("PROXY_HOST=0.0.0.0");
    expect(mode.warning).toContain("JSON-RPC");
    expect(mode.warning).toContain("LENDER_ADDRESS");
    expect(mode.warning).toContain("firewall");
  });

  it("cảnh báo D3 nói rõ phạm vi: /bundle + /captured vẫn được bảo vệ", () => {
    const mode = assertProxyAuthConfig({ host: "0.0.0.0", password: "s3cret" });
    expect(mode.warning).toContain("/bundle");
    expect(mode.warning).toContain("/captured");
  });
});

describe("webapp.html sign flow (H5 reverted 2026-09-24)", () => {
  // Quyết định 2026-09-24: GỠ cổng preflight H5 (morpho_proxyInfo chặn ký).
  // Nguyên nhân: Ambire (smart-contract wallet) chặn method tùy chỉnh ngay ở
  // client ("doesn't has corresponding handler") và tự trả lời
  // web3_clientVersion ("Ambire v6.21.4") nên không thể xác thực RPC qua ví.
  // Flow ký quay về như main: mọi ví → ok, an toàn dựa vào các check
  // server-side (đúng lender, đúng market đã cấu hình, đúng bundle/nonce).
  // Trade-off: ví EOA trỏ sai RPC sẽ không bị chặn trước khi ký.

  it("H5 gỡ sạch: không còn probe/ gate trong webapp", () => {
    expect(html).not.toContain("morpho_proxyInfo");
    expect(html).not.toContain("assertProxyNetwork");
    expect(html).not.toContain("PROXY_INFO_METHOD");
    expect(html).not.toContain("CHẶN KÝ");
    expect(html).not.toMatch(/wallet_addEthereumChain[\s\S]{0,400}morpho_proxyInfo/);
  });

  it("banner compat theo thương hiệu ví như main, mọi ví đều ok: true", () => {
    // Cấu trúc switch giống main; Ambire có case riêng thay vì default.
    expect(html).toMatch(/case "rabby": return \{ ok: true,/);
    expect(html).toMatch(/case "metamask": return \{ ok: true,/);
    expect(html).toMatch(/case "ambire": return \{ ok: true,/);
    expect(html).toMatch(/case "frame": return \{ ok: true,/);
    expect(html).toMatch(/case "coinbase": return \{ ok: true,/);
    expect(html).toMatch(/case "trust": return \{ ok: true,/);
    expect(html).toMatch(/default: return \{ ok: true,/);
    // Không còn nhánh chặn nào trong banner.
    expect(html).not.toMatch(/ok: false/);
  });

  it("nhận diện Ambire qua provider flag (chỉ để hiển thị)", () => {
    expect(html).toMatch(/if \(e\.isAmbire\) return "ambire";/);
  });

  it("ký gọi thẳng sendTransaction, không gate phía trước", () => {
    const sends = [...html.matchAll(/walletClient\.sendTransaction\(/g)].map((m) => m.index);
    expect(sends).toHaveLength(2);
    expect(html).not.toMatch(/await assertProxyNetwork\(\)/);
  });

  it("nút Thêm Mạng Proxy: message thành công như main + giữ hướng dẫn khi ví chặn method", () => {
    expect(html).toContain('✅ Đã thêm mạng Proxy! Hãy chuyển sang mạng <b>Ethereum Proxy Sign</b>.');
    // UX-only: chỉ hướng dẫn thủ công, không chặn gì.
    expect(html).toMatch(/msg\.includes\("corresponding handler"\)/);
    expect(html).toMatch(/nút webapp không thể thêm mạng hộ bạn/);
  });

  it("multi-market: có market switcher + khối overview presign", () => {
    expect(html).toContain('id="market-switcher"');
    expect(html).toContain('id="market-switcher-wrap"');
    expect(html).toMatch(/SERVER_MARKETS\.length <= 1/); // ẩn khi 1 market
    expect(html).toMatch(/window\.switchMarket = function/);
    expect(html).toContain('id="presign-overview"');
    expect(html).toMatch(/api\/overview/);
    expect(html).toMatch(/refreshPresignOverview\(\)/);
    expect(html).toMatch(/initMarketSwitcher\(\)/);
  });

  it("multi-market: cảnh báo race cùng nonce + note bậc thang nonce", () => {
    expect(html).toMatch(/đang được dùng bởi nhiều market cùng lúc/);
    expect(html).toMatch(/trigger trước/);
    expect(html).toMatch(/sẽ <b>expired<\/b>/);
    expect(html).toMatch(/Bậc thang nonce/);
    // Race check trước khi ký: confirm dialog, không chặn cứng.
    expect(html).toMatch(/TRIGGER trước/);
    expect(html).toMatch(/EXPIRED ngay khi nonce này được tiêu thụ/);
  });

  it("M9: bundle expired/submitted hiện hướng dẫn ký lại với nonce mới", () => {
    expect(html).toMatch(/r\.status === "expired"/);
    expect(html).toMatch(/on-chain nonce đã đi qua nonce của bundle đó/);
    expect(html).toMatch(/Ký lại với nonce mới/);
    expect(html).toMatch(/submitted\/failed/);
  });
});
