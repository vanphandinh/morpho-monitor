/**
 * Integration: danh sách RPC HỖN HỢP — một endpoint đúng chain, một endpoint
 * sai chain. Đây là ca thật của bug "chain check chỉ kiểm một endpoint": nếu
 * code chỉ probe một URL, nó có thể vô tình chọn endpoint sai (dịch vụ chết)
 * hoặc bỏ qua endpoint sai rồi để dữ liệu/nonce chạm vào nó sau đó.
 *
 * Test spawn đúng `monitor.mjs` và `proxy-rpc.mjs`, không mock module:
 *   - cả HAI endpoint phải nhận `eth_chainId` (probe toàn bộ danh sách);
 *   - endpoint sai chỉ được nhận `eth_chainId`, không có market read/block/nonce;
 *   - monitor vẫn đọc market qua endpoint đúng và giữ process sống;
 *   - proxy vẫn listen, trả nonce qua endpoint đúng.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  toFunctionSelector,
} from "viem";
import { blueAbi } from "@morpho-org/blue-sdk-viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOOD_CHAIN_ID = 1;
const BAD_CHAIN_ID = 8453; // Base — khác deployment Ethereum
const MARKET_ID = `0x${"11".repeat(32)}`;
const LENDER_ADDRESS = `0x${"22".repeat(20)}`;
const LOAN_TOKEN = `0x${"2".repeat(40)}`;
const COLLATERAL_TOKEN = `0x${"3".repeat(40)}`;
const ORACLE = `0x${"4".repeat(40)}`;
const IRM = `0x${"5".repeat(40)}`;
const LLTV = 860_000_000_000_000_000n;

const MULTICALL_AGGREGATE3 = multicall3Abi.find((item) => item.type === "function" && item.name === "aggregate3");
const SELECTORS = {
  idToMarketParams: toFunctionSelector(blueAbi.find((item) => item.type === "function" && item.name === "idToMarketParams")),
  market: toFunctionSelector(blueAbi.find((item) => item.type === "function" && item.name === "market")),
  position: toFunctionSelector(blueAbi.find((item) => item.type === "function" && item.name === "position")),
  decimals: toFunctionSelector(erc20Abi.find((item) => item.type === "function" && item.name === "decimals")),
  symbol: toFunctionSelector(erc20Abi.find((item) => item.type === "function" && item.name === "symbol")),
  aggregate3: toFunctionSelector(MULTICALL_AGGREGATE3),
};

const fakeHash = (n) => "0x" + (n + 1).toString(16).padStart(64, "0");

function blockFixture() {
  return {
    number: "0x10",
    hash: fakeHash(90),
    parentHash: fakeHash(91),
    nonce: "0x0000000000000000",
    sha3Uncles: fakeHash(92),
    logsBloom: "0x" + "0".repeat(512),
    transactionsRoot: fakeHash(93),
    stateRoot: fakeHash(94),
    receiptsRoot: fakeHash(95),
    miner: `0x${"9".repeat(40)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x100",
    gasLimit: "0x1c9c380",
    gasUsed: "0x5208",
    timestamp: "0x60000000",
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x3b9aca00",
    mixHash: fakeHash(96),
  };
}

/** Metadata token theo địa chỉ; endpoint giả dùng đúng hai token của market. */
function tokenMeta(address) {
  const key = String(address).toLowerCase();
  if (key === LOAN_TOKEN.toLowerCase()) return { decimals: 6, symbol: "USDC" };
  if (key === COLLATERAL_TOKEN.toLowerCase()) return { decimals: 18, symbol: "dCOMP" };
  return { decimals: 18, symbol: "?" };
}

/** Trả `eth_call` result cho các hàm mà monitor/proxy thực sự đọc. */
function handleEthCall(to, data) {
  const selector = String(data ?? "0x").slice(0, 10).toLowerCase();
  if (selector === SELECTORS.idToMarketParams) {
    return encodeFunctionResult({
      abi: blueAbi,
      functionName: "idToMarketParams",
      result: [LOAN_TOKEN, COLLATERAL_TOKEN, ORACLE, IRM, LLTV],
    });
  }
  if (selector === SELECTORS.market) {
    return encodeFunctionResult({
      abi: blueAbi,
      functionName: "market",
      result: [1_000_000_000n, 1_000_000_000n, 400_000_000n, 300_000_000n, 1_700_000_000n, 0n],
    });
  }
  if (selector === SELECTORS.position) {
    return encodeFunctionResult({
      abi: blueAbi,
      functionName: "position",
      result: [500_000_000n, 0n, 0n],
    });
  }
  if (selector === SELECTORS.decimals) {
    return encodeFunctionResult({
      abi: erc20Abi,
      functionName: "decimals",
      result: tokenMeta(to).decimals,
    });
  }
  if (selector === SELECTORS.symbol) {
    return encodeFunctionResult({
      abi: erc20Abi,
      functionName: "symbol",
      result: tokenMeta(to).symbol,
    });
  }
  if (selector === SELECTORS.aggregate3) {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data });
    const calls = args[0] ?? [];
    const results = calls.map((call) => {
      try {
        return { success: true, returnData: handleEthCall(call.target, call.callData) };
      } catch {
        return { success: false, returnData: "0x" };
      }
    });
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: results,
    });
  }
  return "0x";
}

function handleRpc(chainId, method, params) {
  switch (method) {
    case "eth_chainId":
      return `0x${chainId.toString(16)}`;
    case "eth_blockNumber":
      return "0x10";
    case "eth_getBlockByNumber":
      return blockFixture();
    case "eth_getTransactionCount":
      return "0x5";
    case "eth_call":
      return handleEthCall(params?.[0]?.to, params?.[0]?.data);
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      return "0x3b9aca00";
    case "eth_getLogs":
      return [];
    case "eth_getTransactionReceipt":
    case "eth_getTransactionByHash":
      return null;
    default:
      throw new Error(`mock rpc: unsupported method ${method}`);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function startRpcServer(chainId) {
  const methods = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
      }

      const batch = Array.isArray(payload);
      const calls = batch ? payload : [payload];
      const replies = calls.map((call) => {
        methods.push(call?.method);
        try {
          return { jsonrpc: "2.0", id: call?.id ?? null, result: handleRpc(chainId, call?.method, call?.params) };
        } catch (err) {
          return { jsonrpc: "2.0", id: call?.id ?? null, error: { code: -32601, message: err.message } };
        }
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(batch ? replies : replies[0]));
    });
  });

  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    methods,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

async function startMixedRpc() {
  const good = await startRpcServer(GOOD_CHAIN_ID);
  const bad = await startRpcServer(BAD_CHAIN_ID);
  return {
    good,
    bad,
    urls: [good.url, bad.url],
    close: () => Promise.all([good.close(), bad.close()]),
  };
}

function writeMarketsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-mixed-chain-"));
  const file = path.join(dir, "markets.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    markets: [{ id: MARKET_ID, minLiquidity: "1" }],
  }));
  return { dir, file };
}

function childEnv(rpcUrls, marketsFile, overrides = {}) {
  return {
    ...process.env,
    CHAIN_ID: String(GOOD_CHAIN_ID),
    CHAIN_CONFIG_FILE: path.join(ROOT, "config", "chains.json"),
    MARKETS_FILE: marketsFile,
    LENDER_ADDRESS,
    RPC_URLS: rpcUrls.join(","),
    // Không mở WebSocket thật; monitor chỉ dùng polling trong test.
    WSS_URLS: "",
    MONITOR_INTERVAL_MS: "60000",
    NTFY_TOPIC: "mixed-chain-rpc-test",
    PRESIGNED_FILE: path.join(path.dirname(marketsFile), "presigned.json"),
    WEBAPP_PASSWORD: "test-password",
    PROXY_HOST: "127.0.0.1",
    ...overrides,
  };
}

function spawnNode(script, env) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForText(proc, text, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.stdout().includes(text)) return;
    if (proc.child.exitCode !== null) {
      throw new Error(
        `process exited (${proc.child.exitCode}) before "${text}"\n` +
        `stdout:\n${proc.stdout()}\nstderr:\n${proc.stderr()}`
      );
    }
    await delay(50);
  }
  throw new Error(
    `timed out waiting for "${text}"\n` +
    `stdout:\n${proc.stdout()}\nstderr:\n${proc.stderr()}`
  );
}

async function stopChild(proc) {
  if (proc.child.exitCode !== null) return proc.exited;
  proc.child.kill("SIGTERM");
  const stopped = await Promise.race([proc.exited, delay(5_000).then(() => null)]);
  if (stopped) return stopped;
  proc.child.kill("SIGKILL");
  return proc.exited;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function rpcCall(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return response.json();
}

describe("mixed RPC list — dùng endpoint đúng chain và bỏ endpoint sai", { timeout: 40_000 }, () => {
  it("monitor khởi động, đọc market qua endpoint đúng; endpoint sai chỉ nhận eth_chainId", async () => {
    const rpc = await startMixedRpc();
    const markets = writeMarketsFile();
    const proc = spawnNode("monitor.mjs", childEnv(rpc.urls, markets.file));
    try {
      await waitForText(proc, "1/2 HTTP RPC endpoint(s)");
      expect(proc.child.exitCode).toBeNull();

      expect(rpc.good.methods).toContain("eth_chainId");
      expect(rpc.good.methods).toContain("eth_call");
      // Probe phải chạm CẢ HAI URL; endpoint sai không được dùng cho market read.
      expect(rpc.bad.methods).toContain("eth_chainId");
      expect([...new Set(rpc.bad.methods)]).toEqual(["eth_chainId"]);
    } finally {
      await stopChild(proc);
      fs.rmSync(markets.dir, { recursive: true, force: true });
      await rpc.close();
    }
  });

  it("proxy khởi động, đọc block/nonce qua endpoint đúng; endpoint sai chỉ nhận eth_chainId", async () => {
    const rpc = await startMixedRpc();
    const markets = writeMarketsFile();
    const port = await freePort();
    const proc = spawnNode("proxy-rpc.mjs", childEnv(rpc.urls, markets.file, {
      PROXY_PORT: String(port),
    }));
    try {
      await waitForText(proc, "🔌 Proxy:");
      expect(proc.child.exitCode).toBeNull();
      expect(proc.stdout()).toContain("1/2 RPC endpoint(s)");

      const chain = await rpcCall(`http://127.0.0.1:${port}`, "eth_chainId");
      expect(chain.result).toBe("0x1");

      const nonce = await rpcCall(`http://127.0.0.1:${port}`, "eth_getTransactionCount", [LENDER_ADDRESS, "latest"]);
      expect(nonce.result).toBe("0x5");

      expect(rpc.good.methods).toContain("eth_getBlockByNumber");
      expect(rpc.good.methods).toContain("eth_getTransactionCount");
      // Endpoint sai không được nhận block/nonce nào — chỉ probe chain.
      expect(rpc.bad.methods).toContain("eth_chainId");
      expect([...new Set(rpc.bad.methods)]).toEqual(["eth_chainId"]);
    } finally {
      await stopChild(proc);
      fs.rmSync(markets.dir, { recursive: true, force: true });
      await rpc.close();
    }
  });
});
