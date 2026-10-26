/**
 * Multi-chain wiring — chain metadata is the source of truth, and every layer
 * that can move money is chain-bound.
 *
 * These tests deliberately use chain 8453 (Base) to prove a deployment only
 * needs `CHAIN_ID` + `.env`, not a source fork. ETH keeps its old behaviour via
 * config/chains.json.
 */
import { describe, it, expect } from "vitest";
import { encodeFunctionData, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHAIN_CONFIG_INVALID,
  CHAIN_CONFIG_MISSING,
  UNSUPPORTED_CHAIN,
  loadChainConfig,
  parseChainConfig,
  resolveChain,
  txUrl,
} from "../chain-config.mjs";
import { buildWebappConfig } from "../webapp-config.mjs";
import { createRpcDispatcher } from "../proxy-dispatcher.mjs";
import {
  MORPHO_WITHDRAW_ABI,
  VERIFY_BUNDLE_INVALID,
  VERIFY_CONFIG_MISMATCH,
  computeMarketId,
  verifyPresignedBundle,
  verifyWithdrawCalldata,
} from "../presign-verify.mjs";
import { WSS_CHAIN_MISMATCH, createWssConnect } from "../wss-connect.mjs";

const BASE_MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const BASE = {
  id: 8453,
  name: "Base",
  viemChain: "base",
  morphoBlueAddress: BASE_MORPHO,
  explorerUrl: "https://basescan.org",
  explorerName: "Basescan",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  publicRpcUrls: ["https://base.example"],
  wsRpcUrls: ["wss://base.example"],
};
const LENDER = "0x" + "1".repeat(40);
const MARKET_PARAMS = {
  loanToken: "0x" + "2".repeat(40),
  collateralToken: "0x" + "3".repeat(40),
  oracle: "0x" + "4".repeat(40),
  irm: "0x" + "5".repeat(40),
  lltv: 860000000000000000n,
};
const MARKET_ID = computeMarketId(MARKET_PARAMS);
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);

async function signedWithdraw({ chainId = 8453, to = BASE_MORPHO } = {}) {
  return account.signTransaction({
    to,
    data: encodeFunctionData({
      abi: MORPHO_WITHDRAW_ABI,
      functionName: "withdraw",
      args: [MARKET_PARAMS, 50_000_000_000n, 0n, account.address, account.address],
    }),
    nonce: 7,
    chainId,
    gas: 200_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    type: "eip1559",
    value: 0n,
  });
}

describe("config/chains.json — parse + resolve", () => {
  it("chọn đúng metadata Base từ một entry cấu hình", () => {
    const parsed = parseChainConfig({ version: 1, chains: [BASE] });
    const chain = resolveChain(parsed, 8453);
    expect(chain.id).toBe(8453);
    expect(chain.name).toBe("Base");
    expect(chain.morphoBlueAddress.toLowerCase()).toBe(BASE_MORPHO.toLowerCase());
    expect(chain.explorerUrl).toBe("https://basescan.org");
    expect(chain.publicRpcUrls).toEqual(["https://base.example"]);
    expect(chain.chain.id).toBe(8453);
    expect(txUrl(chain, "0xabc")).toBe("https://basescan.org/tx/0xabc");
  });

  it("chain không có trong config ⇒ UNSUPPORTED_CHAIN kèm danh sách có sẵn", () => {
    const parsed = parseChainConfig({ version: 1, chains: [BASE] });
    try {
      resolveChain(parsed, 1);
      throw new Error("đáng lẽ phải ném");
    } catch (err) {
      expect(err.code).toBe(UNSUPPORTED_CHAIN);
      expect(err.message).toContain("8453");
    }
  });

  it("fail closed với id trùng / địa chỉ Morpho sai / RPC rỗng", () => {
    expect(() => parseChainConfig({ version: 1, chains: [BASE, BASE] })).toThrow(/Duplicate chain id/);
    expect(() => parseChainConfig({
      version: 1,
      chains: [{ ...BASE, morphoBlueAddress: "0x123" }],
    })).toThrow(/morphoBlueAddress/);
    expect(() => parseChainConfig({
      version: 1,
      chains: [{ ...BASE, publicRpcUrls: [] }],
    })).toThrow(/publicRpcUrls/);
  });

  it("file cấu hình thiếu ⇒ lỗi có mã CHAIN_CONFIG_MISSING (không chạy với metadata rỗng)", () => {
    try {
      loadChainConfig("./config/khong-ton-tai.json");
      throw new Error("đáng lẽ phải ném");
    } catch (err) {
      expect(err.code).toBe(CHAIN_CONFIG_MISSING);
    }
  });

  it("repo thật có đủ Ethereum, Base, Monad", () => {
    const config = loadChainConfig("./config/chains.json");
    expect(config.chains.map((c) => c.id).sort((a, b) => a - b)).toEqual([1, 143, 8453]);
  });

  it("mã lỗi config không đổi (caller dựa vào code)", () => {
    expect(CHAIN_CONFIG_INVALID).toBe("CHAIN_CONFIG_INVALID");
  });
});

describe("browser config — chain metadata thay cho mainnet hardcode", () => {
  it("inject đúng chainId/explorer/Morpho và không kéo RPC Ethereum vào Base", () => {
    const config = buildWebappConfig({
      markets: [{ id: MARKET_ID, minLiquidity: "100", suddenDrainMultiplier: 2 }],
      lenderAddress: LENDER,
      proxyRpcUrl: "https://base.example:8546",
      publicRpcUrls: ["https://base.example"],
      chainId: 8453,
      chainName: "Base",
      nativeCurrency: BASE.nativeCurrency,
      explorerUrl: BASE.explorerUrl,
      explorerName: BASE.explorerName,
      morphoBlueAddress: BASE_MORPHO,
    });
    expect(config.chainId).toBe(8453);
    expect(config.chainIdHex).toBe("0x2105");
    expect(config.chainName).toBe("Base");
    expect(config.explorerName).toBe("Basescan");
    expect(config.morphoBlueAddress).toBe(BASE_MORPHO);
    expect(config.chain.id).toBe(8453);
    expect(config.rpcUrls).toEqual(["https://base.example"]);
    expect(JSON.stringify(config)).not.toMatch(/ethereum-rpc\.publicnode\.com/);
  });
});

describe("proxy — eth_chainId / capture gate theo CHAIN_ID", () => {
  function makeDispatcher(chainId = 8453) {
    return createRpcDispatcher({
      markets: [{ id: MARKET_ID }],
      lenderAddress: account.address,
      morphoBlueAddress: BASE_MORPHO,
      chainId,
      client: { getTransactionCount: async () => 7 },
      capturedTxs: [],
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
  }

  it("Base trả 0x2105 / net_version 8453 / morpho_proxyInfo chainId 8453", async () => {
    const { handleRpc } = makeDispatcher(8453);
    expect(await handleRpc("eth_chainId", [])).toBe("0x2105");
    expect(await handleRpc("net_version", [])).toBe("8453");
    expect(await handleRpc("morpho_proxyInfo", [])).toEqual({ server: "morpho-proxy", chainId: 8453 });
  });

  it("chữ ký chain 1 KHÔNG được capture trên proxy Base", async () => {
    const capturedTxs = [];
    const dispatcher = createRpcDispatcher({
      markets: [{ id: MARKET_ID }],
      lenderAddress: account.address,
      morphoBlueAddress: BASE_MORPHO,
      chainId: 8453,
      client: { getTransactionCount: async () => 7 },
      capturedTxs,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const signed = await signedWithdraw({ chainId: 1 });
    const result = await dispatcher.handleRpc("eth_sendRawTransaction", [signed]);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/chainId 1 !== 8453/);
    expect(capturedTxs).toHaveLength(0);
  });

  it("chữ ký Base hợp lệ vẫn capture bình thường", async () => {
    const capturedTxs = [];
    const dispatcher = createRpcDispatcher({
      markets: [{ id: MARKET_ID }],
      lenderAddress: account.address,
      morphoBlueAddress: BASE_MORPHO,
      chainId: 8453,
      client: { getTransactionCount: async () => 7 },
      capturedTxs,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const signed = await signedWithdraw({ chainId: 8453 });
    expect(await dispatcher.handleRpc("eth_sendRawTransaction", [signed])).toBe(keccak256(signed));
    expect(capturedTxs).toHaveLength(1);
  });
});

describe("presign verify — bundle bị ràng buộc chain", () => {
  it("tx ký chain 1 bị từ chối khi deployment là 8453", async () => {
    const signed = await signedWithdraw({ chainId: 1 });
    const result = await verifyWithdrawCalldata(signed, {
      chainId: 8453,
      morphoBlueAddress: BASE_MORPHO,
      lenderAddress: account.address,
      marketId: MARKET_ID,
      nonce: 7,
      amountWei: "50000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(VERIFY_BUNDLE_INVALID);
    expect(result.error).toMatch(/chainId 1 !== 8453/);
  });

  it("bundle.chainId lệch config ⇒ CONFIG_MISMATCH, không đánh hỏng bundle", async () => {
    const signed = await signedWithdraw({ chainId: 8453 });
    const bundle = {
      chainId: 1,
      morphoBlueAddress: BASE_MORPHO,
      lenderAddress: account.address,
      marketId: MARKET_ID,
      nonce: 7,
      withdrawals: [{ amountWei: "50000000000", signedTx: signed }],
    };
    const result = await verifyPresignedBundle(bundle, {
      chainId: 8453,
      morphoBlueAddress: BASE_MORPHO,
      lenderAddress: account.address,
      marketId: MARKET_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(VERIFY_CONFIG_MISMATCH);
  });
});

describe("WSS — endpoint sai chain bị đóng và loại", () => {
  it("probe chain 1 khi deployment 8453 ⇒ WSS_CHAIN_MISMATCH", async () => {
    const close = () => {};
    const client = {
      getChainId: async () => 1,
      transport: { value: { getRpcClient: () => Promise.resolve({ close }) } },
      watchContractEvent: () => () => {},
    };
    const connect = createWssConnect({
      address: BASE_MORPHO,
      expectedChainId: 8453,
      createClient: () => client,
      webSocketTransport: () => ({ value: client.transport.value }),
    });
    await expect(connect("wss://base.example")).rejects.toMatchObject({
      code: WSS_CHAIN_MISMATCH,
      actual: 1,
      expected: 8453,
    });
  });
});
