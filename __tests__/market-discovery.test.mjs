import { describe, expect, it } from "vitest";
import { discoverMarkets } from "../market-discovery.mjs";

const ID_A = "0x" + "11".repeat(32);
const ID_B = "0x" + "22".repeat(32);
const LENDER = "0x" + "aa".repeat(20);

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe("discoverMarkets", () => {
  it("lọc đúng chain, bỏ supply_shares = 0, map threshold mặc định", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return jsonResponse({
        data: [
          { chain_id: 1, market_id: ID_A, supply_shares: "100" },
          { chain_id: 8453, market_id: ID_B, supply_shares: "100" },
          { chain_id: 1, market_id: ID_B, supply_shares: "0" },
        ],
        cursor: null,
      });
    };

    const markets = await discoverMarkets({ lenderAddress: LENDER, chainId: 1, fetchImpl });

    expect(markets).toEqual([
      { id: ID_A, minLiquidity: "10000", suddenDrainMultiplier: 2 },
    ]);
    const url = new URL(calls[0]);
    expect(url.origin).toBe("https://api.morpho.org");
    expect(url.pathname).toBe(`/v0/blue/users/${LENDER}/positions`);
    expect(url.searchParams.get("active_only")).toBe("true");
    expect(url.searchParams.get("chain_ids")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("theo cursor đến hết và sắp xếp id tăng dần", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return jsonResponse({
          data: [{ chain_id: 1, market_id: ID_B, supply_shares: "1" }],
          cursor: "next",
        });
      }
      return jsonResponse({
        data: [{ chain_id: 1, market_id: ID_A, supply_shares: "1" }],
        cursor: null,
      });
    };

    const markets = await discoverMarkets({ lenderAddress: LENDER, chainId: 1, fetchImpl });

    expect(markets.map((market) => market.id)).toEqual([ID_A, ID_B]);
    expect(new URL(calls[1]).searchParams.get("cursor")).toBe("next");
  });

  it("retry lỗi tạm thời rồi thành công", async () => {
    let calls = 0;
    const sleeps = [];
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return jsonResponse({
        data: [{ chain_id: 1, market_id: ID_A, supply_shares: "1" }],
        cursor: null,
      });
    };

    await discoverMarkets({
      lenderAddress: LENDER,
      chainId: 1,
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it("không retry lỗi 4xx", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return jsonResponse({ error: "bad request" }, 400);
    };

    await expect(discoverMarkets({ lenderAddress: LENDER, chainId: 1, fetchImpl }))
      .rejects.toMatchObject({ code: "AUTO_DISCOVERY_FAILED" });
    expect(calls).toBe(1);
  });

  it("0 market active → AUTO_MARKETS_EMPTY", async () => {
    const fetchImpl = async () => jsonResponse({ data: [], cursor: null });

    await expect(discoverMarkets({ lenderAddress: LENDER, chainId: 1, fetchImpl }))
      .rejects.toMatchObject({ code: "AUTO_MARKETS_EMPTY" });
  });

  it("hơn 9 market → AUTO_MARKETS_TOO_MANY", async () => {
    const data = Array.from({ length: 10 }, (_, index) => ({
      chain_id: 1,
      market_id: "0x" + index.toString(16).padStart(2, "0").repeat(32),
      supply_shares: "1",
    }));
    const fetchImpl = async () => jsonResponse({ data, cursor: null });

    await expect(discoverMarkets({ lenderAddress: LENDER, chainId: 1, fetchImpl }))
      .rejects.toMatchObject({ code: "AUTO_MARKETS_TOO_MANY" });
  });

  it("từ chối lender/chain/API URL không hợp lệ", async () => {
    await expect(discoverMarkets({ lenderAddress: "0x0", chainId: 1 }))
      .rejects.toMatchObject({ code: "AUTO_LENDER_INVALID" });
    await expect(discoverMarkets({ lenderAddress: LENDER, chainId: 0 }))
      .rejects.toMatchObject({ code: "AUTO_INPUT_INVALID" });
    await expect(discoverMarkets({ lenderAddress: LENDER, chainId: 1, apiUrl: "ftp://x" }))
      .rejects.toMatchObject({ code: "AUTO_INPUT_INVALID" });
  });
});
