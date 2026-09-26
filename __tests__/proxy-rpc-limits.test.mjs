/**
 * proxy-dispatcher.mjs — giới hạn nhánh JSON-RPC (audit vòng 5, O2).
 *
 * Bối cảnh: relay JSON-RPC KHÔNG xác thực được (ví không gửi header `Authorization`), nên ai
 * vào được port proxy cũng forward được sang `RPC_URLS` của operator. Vòng 2 đã chọn phương án
 * tài liệu hoá; đây là hai công cụ giới hạn thật, cả hai đều **opt-in**:
 *
 *   - `rpcRateLimit` — N request / cửa sổ / IP, vượt ⇒ lỗi JSON-RPC `-32005` (HTTP 200, để ví
 *     hiểu là lỗi RPC chứ không phải mạng chết rồi thử lại).
 *   - `rpcMethodAllowList` — chỉ cho tập method của ví.
 *
 * Hợp đồng số 1 được ghim ở đây: **mặc định tắt** ⇒ không đổi hành vi cũ.
 *
 * Handler được gọi với `req`/`res` giả (EventEmitter đúng cách `readBodyLimited` dùng) để điều
 * khiển được IP — thứ không làm được với HTTP server thật trên localhost.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { createProxyRequestHandler, RPC_METHOD_ALLOW_LIST } from "../proxy-dispatcher.mjs";
import { PROXY_RPC_RATE_LIMIT, PROXY_ALLOW_PUBLIC_RPC } from "../shared.mjs";

const MARKETS = [{ id: "0x" + "a".repeat(64) }];
const LENDER = "0x" + "1".repeat(40);
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const fakeClient = {
  getBlockNumber: async () => 0x1400000n,
  getGasPrice: async () => 10_000_000_000n,
  estimateMaxPriorityFeePerGas: async () => 1_000_000_000n,
  getTransactionCount: async () => 7,
  getBlock: async () => ({ number: 0x1400000n, hash: "0x" + "ab".repeat(32), baseFeePerGas: 10_000_000_000n }),
};

function makeHandler(options = {}) {
  return createProxyRequestHandler({
    markets: MARKETS,
    lenderAddress: LENDER,
    morphoBlueAddress: MORPHO,
    client: fakeClient,
    capturedTxs: [],
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    ...options,
  });
}

function fakeReq({ method = "POST", url = "/", body = "", ip = "127.0.0.1", headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: ip };
  req.destroy = () => {};
  // `readBodyLimited` gắn listener "data"/"end" đồng bộ trong lúc handler chạy ⇒ emit ở tick sau.
  process.nextTick(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    raw: "",
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    writeHead(code) { this.status = code; },
    end(payload = "") { this.raw = typeof payload === "string" ? payload : String(payload); },
    get json() { try { return JSON.parse(this.raw); } catch { return null; } },
  };
}

async function rpc(handler, { method = "eth_chainId", params = [], ip = "127.0.0.1", id = 1 } = {}) {
  const res = fakeRes();
  await handler(fakeReq({ body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), ip }), res);
  return res;
}

async function rpcBatch(handler, requests, { ip = "127.0.0.1" } = {}) {
  const res = fakeRes();
  await handler(fakeReq({ body: JSON.stringify(requests), ip }), res);
  return res;
}

describe("proxy JSON-RPC — rate limit theo IP (mặc định TẮT)", () => {
  it("không đặt rpcRateLimit ⇒ 150 request liên tiếp đều thành công (hành vi cũ)", async () => {
    // 150 chứ không phải vài request: con số này rộng hơn mọi ngưỡng ai đó có thể vô tình đặt
    // làm mặc định, nên test đỏ được ngay khi mặc định bị bật.
    const handler = makeHandler();
    for (let i = 0; i < 150; i++) {
      const res = await rpc(handler);
      expect(res.status).toBe(200);
      expect(res.json.error).toBeUndefined();
      expect(res.json.result).toBe("0x1");
    }
  });

  it("rpcRateLimit=3 ⇒ 3 request đầu OK, request thứ 4 trả -32005 và KHÔNG forward", async () => {
    const handler = makeHandler({ rpcRateLimit: 3 });
    for (let i = 0; i < 3; i++) expect((await rpc(handler, { id: i })).json.result).toBe("0x1");

    const blocked = await rpc(handler, { id: 99 });
    expect(blocked.status).toBe(200); // JSON-RPC: lỗi nằm trong body, không phải HTTP 429
    expect(blocked.json.result).toBeUndefined();
    expect(blocked.json.error.code).toBe(-32005);
    expect(blocked.json.error.message).toContain("3 requests per 60s");
    expect(blocked.json.id).toBe(99);
  });

  it("đếm theo IP: IP khác không bị ảnh hưởng", async () => {
    const handler = makeHandler({ rpcRateLimit: 2 });
    await rpc(handler, { ip: "10.0.0.1" });
    await rpc(handler, { ip: "10.0.0.1" });
    expect((await rpc(handler, { ip: "10.0.0.1" })).json.error.code).toBe(-32005);

    const other = await rpc(handler, { ip: "10.0.0.2" });
    expect(other.json.error).toBeUndefined();
    expect(other.json.result).toBe("0x1");
  });

  it("cửa sổ trượt: hết cửa sổ thì được cấp lại", async () => {
    let clock = 1_000_000;
    const handler = makeHandler({ rpcRateLimit: 1, rpcRateLimitWindowMs: 60_000, now: () => clock });
    expect((await rpc(handler)).json.result).toBe("0x1");
    expect((await rpc(handler)).json.error.code).toBe(-32005);

    clock += 60_000; // sang cửa sổ mới
    expect((await rpc(handler)).json.result).toBe("0x1");
  });

  it("vượt ngưỡng với batch ⇒ -32005 và id null", async () => {
    const handler = makeHandler({ rpcRateLimit: 1 });
    await rpc(handler);
    const blocked = await rpcBatch(handler, [{ jsonrpc: "2.0", id: 1, method: "eth_chainId" }]);
    expect(blocked.json.error.code).toBe(-32005);
    expect(blocked.json.id).toBeNull();
  });

  it("giới hạn chỉ áp cho nhánh JSON-RPC — OPTIONS vẫn 204 sau khi đã cạn lượt", async () => {
    const handler = makeHandler({ rpcRateLimit: 1 });
    await rpc(handler);
    expect((await rpc(handler)).json.error.code).toBe(-32005);

    const res = fakeRes();
    await handler(fakeReq({ method: "OPTIONS" }), res);
    expect(res.status).toBe(204);
  });
});

describe("proxy JSON-RPC — allow-list method (mặc định TẮT)", () => {
  it("không đặt allow-list ⇒ mọi method qua được (kể cả ngoài tập ví)", async () => {
    const handler = makeHandler();
    const res = await rpc(handler, { method: "morpho_proxyInfo" });
    expect(res.json.error).toBeUndefined();
    expect(res.json.result).toMatchObject({ server: "morpho-proxy" });
  });

  it("đặt allow-list ⇒ method ngoài danh sách trả -32601, method trong danh sách vẫn chạy", async () => {
    const handler = makeHandler({ rpcMethodAllowList: ["eth_chainId", "eth_blockNumber"] });
    const allowed = await rpc(handler, { method: "eth_blockNumber" });
    expect(allowed.json.error).toBeUndefined();

    const blocked = await rpc(handler, { method: "morpho_proxyInfo" });
    expect(blocked.status).toBe(200);
    expect(blocked.json.error.code).toBe(-32601);
    expect(blocked.json.error.message).toContain("PROXY_ALLOW_PUBLIC_RPC");
  });

  it("batch: item ngoài danh sách nhận -32601, item hợp lệ vẫn có result", async () => {
    const handler = makeHandler({ rpcMethodAllowList: ["eth_chainId"] });
    const res = await rpcBatch(handler, [
      { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
      { jsonrpc: "2.0", id: 2, method: "morpho_proxyInfo" },
    ]);
    expect(res.json).toHaveLength(2);
    expect(res.json[0].result).toBe("0x1");
    expect(res.json[1].error.code).toBe(-32601);
  });

  it("mặc định của deployment là TẮT, và bootstrap proxy truyền env vào handler", () => {
    // Env không được đặt trong môi trường test ⇒ đây là giá trị mặc định thực sự được ship.
    expect(PROXY_RPC_RATE_LIMIT).toBe(0);
    expect(PROXY_ALLOW_PUBLIC_RPC).toBe(false);

    const src = fs.readFileSync(new URL("../proxy-rpc.mjs", import.meta.url), "utf8");
    expect(src).toContain("rpcRateLimit: PROXY_RPC_RATE_LIMIT");
    expect(src).toContain("rpcMethodAllowList: PROXY_ALLOW_PUBLIC_RPC ? RPC_METHOD_ALLOW_LIST : null");
  });

  it("danh sách chuẩn của proxy chứa method ví cần để ký/rút", () => {
    for (const method of ["eth_chainId", "eth_call", "eth_estimateGas", "eth_getTransactionCount", "eth_sendRawTransaction", "eth_getLogs", "eth_gasPrice", "web3_clientVersion"]) {
      expect(RPC_METHOD_ALLOW_LIST).toContain(method);
    }
  });
});
