/**
 * A3 + M2 + B2: cấu hình browser của webapp.
 *
 * - `buildWebappConfig`/`injectWebappConfig` (webapp-config.mjs) là production
 *   code; test import trực tiếp (không boot server, không listen).
 * - `webapp.html` được đọc dưới dạng text để khẳng định: không còn API key của
 *   nhà cung cấp RPC trong file phục vụ công khai, và preflight proxy RPC được
 *   gọi TRƯỚC mọi `walletClient.sendTransaction`.
 *
 * Lưu ý: webapp.html là browser ESM (không import được bằng vitest), nên
 * predicate `isProxyInfoResponse` dưới đây là bản sao của production — debt đã
 * ghi trong CLAUDE.md, cùng convention với webapp.test.mjs.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebappConfig, injectWebappConfig } from "../webapp-config.mjs";

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

describe("webapp.html proxy preflight (B2/H5)", () => {
  const isProxyInfoResponse = (info) =>
    Boolean(info && typeof info === "object" && info.server === "morpho-proxy" && Number(info.chainId) === 1);

  it("predicate nhận đúng response của proxy và từ chối mọi thứ khác", () => {
    expect(isProxyInfoResponse({ server: "morpho-proxy", chainId: 1 })).toBe(true);
    expect(isProxyInfoResponse({ server: "morpho-proxy", chainId: "1" })).toBe(true);
    for (const bad of [null, undefined, "MorphoProxy/v1", {}, { server: "geth" }, { server: "morpho-proxy", chainId: 5 }, []]) {
      expect(isProxyInfoResponse(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("HTML dùng morpho_proxyInfo và predicate production giống bản test", () => {
    expect(html).toContain('const PROXY_INFO_METHOD = "morpho_proxyInfo";');
    expect(html).toContain('info.server === "morpho-proxy"');
    expect(html).toContain("Number(info.chainId) === 1");
  });

  it("assertProxyNetwork() chạy TRƯỚC mọi walletClient.sendTransaction", () => {
    const preflights = [...html.matchAll(/await assertProxyNetwork\(\)/g)].map((m) => m.index);
    const sends = [...html.matchAll(/walletClient\.sendTransaction\(/g)].map((m) => m.index);
    expect(preflights).toHaveLength(2);
    expect(sends).toHaveLength(2);
    sends.forEach((sendIdx, i) => expect(preflights[i]).toBeLessThan(sendIdx));
  });

  it("banner compat phản ánh kết quả kiểm tra thật (không chỉ thương hiệu ví)", () => {
    expect(html).toMatch(/let proxyNetworkCheck = \{ checked: false, ok: false, error: null, unsupported: false \}/);
    expect(html).toMatch(/if \(!proxyNetworkCheck\.checked\)/);
    expect(html).toMatch(/if \(!proxyNetworkCheck\.ok\)/);
    expect(html).toMatch(/banner\.className = compat\.ok === false \? "banner error"/);
  });

  it("M9: bundle expired/submitted hiện hướng dẫn ký lại với nonce mới", () => {
    expect(html).toMatch(/data\.status === "expired"/);
    expect(html).toMatch(/nonce dùng chung cho mọi market/);
    expect(html).toMatch(/ký lại/);
  });

  // Regression 2026-09-24: một số ví (Ambire, một số build MetaMask/Rabby) chặn
  // method JSON-RPC tùy chỉnh ngay ở client với lỗi
  // "method [morpho_proxyInfo] doesn't has corresponding handler" — RPC chưa hề
  // được gọi. Webapp phải (1) nhận diện ví Ambire, (2) fallback web3_clientVersion
  // để phân biệt proxy/node thật, (3) cho phép ký khi fallback xác nhận
  // MorphoProxy/v1 nhưng vẫn chặn khi RPC sai (nếu không, ví như Ambire sẽ bị
  // chặn vĩnh viễn dù đã trỏ đúng RPC), (4) nút "Thêm Mạng Proxy" có hướng dẫn
  // thủ công riêng.
  describe("wallets blocking custom methods (corresponding handler)", () => {
    it("nhận diện ví Ambire qua provider flag", () => {
      expect(html).toMatch(/if \(e\.isAmbire\) return "ambire";/);
      expect(html).toMatch(/ambire: "Ambire"/);
    });

    it("fallback web3_clientVersion: MorphoProxy/v1 ⇒ cho phép ký, client khác ⇒ chặn", () => {
      expect(html).toMatch(/raw\.includes\("corresponding handler"\)/);
      expect(html).toMatch(/method: "web3_clientVersion"/);
      // Nhánh khớp proxy: ok: true (nếu không, ví như Ambire bị chặn vĩnh viễn
      // dù đã trỏ đúng RPC — node thật không bao giờ trả "MorphoProxy/v1").
      expect(html).toMatch(/if \(version === "MorphoProxy\/v1"\)/);
      expect(html).toMatch(/ok: true, error: null, unsupported: true/);
      // Nhánh RPC sai hoặc không gọi được: vẫn chặn.
      expect(html).toMatch(/ok: false, unsupported: true,/);
      expect(html).toMatch(/KHÔNG phải proxy\./);
    });

    it("banner hiển thị xác nhận qua fallback khi ví chặn morpho_proxyInfo", () => {
      expect(html).toMatch(/web3_clientVersion xác nhận đây là proxy \(MorphoProxy\/v1\)/);
    });

    it("thông báo chặn ký giải thích nguyên nhân ví chặn method (không phải proxy sai)", () => {
      expect(html).toMatch(/check\.unsupported/);
      expect(html).toMatch(/Nguyên nhân:<\/b> ví của bạn tự chặn method kiểm tra/);
      expect(html).toMatch(/không phải proxy chạy sai/);
      expect(html).toMatch(/cũng bị ví từ chối cùng lỗi đó/);
    });

    it("nút Thêm Mạng Proxy có hướng dẫn thủ công khi ví chặn wallet_addEthereumChain", () => {
      expect(html).toMatch(/msg\.includes\("corresponding handler"\)/);
      expect(html).toMatch(/chặn <code>wallet_addEthereumChain<\/code> ngay trong app/);
      expect(html).toMatch(/nút webapp không thể thêm mạng hộ bạn/);
    });
  });
});
