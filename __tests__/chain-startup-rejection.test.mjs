/**
 * Integration: monitor và proxy phải từ chối endpoint sai chain ngay lúc khởi
 * động, trước khi gửi bất kỳ request đọc dữ liệu nào (đặc biệt
 * `eth_getTransactionCount` — nonce của ví lender).
 *
 * Test spawn đúng entrypoint production thay vì chỉ gọi
 * `createChainBoundPublicClient`: như vậy nó phủ luôn env/chain registry,
 * `retryStartup` (mismatch là fatal, không retry) và nhánh exit của từng service.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_CHAIN_ID = 1;
const WRONG_CHAIN_ID = 8453; // Base — khác chain đang cấu hình (Ethereum)
const MARKET_ID = `0x${"11".repeat(32)}`;
const LENDER_ADDRESS = `0x${"22".repeat(20)}`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

/**
 * Mock JSON-RPC trả SAI chain cho `eth_chainId`; mọi method khác bị ghi lại để
 * test chứng minh không có request nào khác từng tới endpoint.
 */
async function startWrongChainRpc() {
  const methods = [];
  const server = http.createServer((req, res) => {
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
        if (call?.method === "eth_chainId") {
          return { jsonrpc: "2.0", id: call.id, result: `0x${WRONG_CHAIN_ID.toString(16)}` };
        }
        return {
          jsonrpc: "2.0",
          id: call?.id ?? null,
          error: { code: -32601, message: `unexpected method: ${call?.method}` },
        };
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

function writeMarketsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-chain-startup-"));
  const file = path.join(dir, "markets.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    markets: [{ id: MARKET_ID, minLiquidity: "1" }],
  }));
  return file;
}

function childEnv(rpcUrl, marketsFile) {
  return {
    ...process.env,
    CHAIN_ID: String(EXPECTED_CHAIN_ID),
    CHAIN_CONFIG_FILE: path.join(ROOT, "config", "chains.json"),
    MARKETS_FILE: marketsFile,
    LENDER_ADDRESS,
    RPC_URLS: rpcUrl,
    // Không để monitor mở WebSocket thật sau khi reader được tạo.
    WSS_URLS: "",
    NTFY_TOPIC: "chain-startup-rejection-test",
    PRESIGNED_FILE: path.join(path.dirname(marketsFile), "presigned.json"),
    WEBAPP_PASSWORD: "test-password",
    PROXY_HOST: "127.0.0.1",
    PROXY_PORT: "18545",
  };
}

function runNode(script, env, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, script)],
      { cwd: ROOT, env, timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === "number" ? err.code : null) : 0,
        stdout,
        stderr,
      })
    );
  });
}

function expectWrongChainRejection(result) {
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`Không có RPC endpoint nào trả đúng chain ${EXPECTED_CHAIN_ID}`);
  expect(result.stderr).toContain(`chainId ${WRONG_CHAIN_ID}`);
}

describe("wrong-chain RPC is rejected at startup", { timeout: 30_000 }, () => {
  it("monitor thoát fatal trước khi đọc market qua endpoint sai chain", async () => {
    const rpc = await startWrongChainRpc();
    const marketsFile = writeMarketsFile();
    try {
      const result = await runNode("monitor.mjs", childEnv(rpc.url, marketsFile));

      expectWrongChainRejection(result);
      // Chỉ được gửi đúng một loại request: probe chain. Không eth_call,
      // eth_getLogs, eth_getBlockByNumber... nào chạm endpoint sai chain.
      expect([...new Set(rpc.methods)]).toEqual(["eth_chainId"]);
    } finally {
      fs.rmSync(path.dirname(marketsFile), { recursive: true, force: true });
      await rpc.close();
    }
  });

  it("proxy thoát fatal trước khi đọc nonce qua endpoint sai chain", async () => {
    const rpc = await startWrongChainRpc();
    const marketsFile = writeMarketsFile();
    try {
      const result = await runNode("proxy-rpc.mjs", childEnv(rpc.url, marketsFile));

      expectWrongChainRejection(result);
      expect(result.stdout).not.toContain("RPC Proxy"); // chưa hề listen
      expect([...new Set(rpc.methods)]).toEqual(["eth_chainId"]);
      expect(rpc.methods).not.toContain("eth_getTransactionCount");
    } finally {
      fs.rmSync(path.dirname(marketsFile), { recursive: true, force: true });
      await rpc.close();
    }
  });
});
