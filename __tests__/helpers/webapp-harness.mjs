/**
 * Harness lái webapp: RPC giả + ví giả + REST giả, để **chạy thật** các handler đường tiền
 * (vòng 6, P2).
 *
 * Vì sao không mock thẳng module: mọi lỗi của lớp "tách file" (P5) nằm ở *dây nối* — tham số
 * truyền vào viem, thứ tự gọi, giá trị ghi vào DOM, body gửi lên server. Muốn thấy chúng thì
 * phải đi qua `fetch`/`window.ethereum` thật của code, không phải qua stub hàm nội bộ.
 *
 * Ba lớp giả, mỗi lớp ghi lại mọi request vào một buffer riêng:
 *
 *   - `createFakeRpc()`      — JSON-RPC (`eth_call`, `eth_getTransactionCount`, …). Trả lời
 *                              bằng chính viem (`encodeFunctionResult`), nên byte trên dây
 *                              đúng như RPC thật.
 *   - `createFakeProvider()` — EIP-1193 (`eth_requestAccounts`, `personal_sign`,
 *                              `eth_sendTransaction`). `eth_sendTransaction` là chỗ CHỨA
 *                              CALLDATA rút tiền — artifact quan trọng nhất của cả harness.
 *   - `createFakeApi()`      — REST `/api/*` (challenge/auth/overview/presign/bundle).
 *
 * Bốn bất biến của harness (đều để so sánh được giữa hai cây code):
 *   1. **Không rời khỏi máy.** Không có request thật nào; `fetch` bị chiếm chỗ hoàn toàn.
 *   2. **Tất định.** Hash/giá trị sinh ra theo bộ đếm, không dùng thời gian/ngẫu nhiên.
 *   3. **Thứ tự so sánh được.** Gọi song song (`Promise.all` trong `fetchAllData`) xong theo thứ
 *      tự bất kỳ, nên buffer được SẮP XẾP trước khi so — giữ nguyên *tập* lời gọi, bỏ thứ tự
 *      chồng chéo không xác định. Thứ tự ở mức handler do scenario chụp theo bước.
 *   4. **Không import gì từ cây đang kiểm.** ABI ở đây là định nghĩa *dây dẫn* của RPC giả, không
 *      phải logic production; nhờ vậy CÙNG harness lái được cả cây trước P5 (một file) và cây
 *      hiện tại (7 module). Nếu production đổi ABI thì trace đổi và test đỏ ngay.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodeFunctionData, encodeFunctionResult, toFunctionSelector } from "viem";
import { installBrowserEnv, readWebappHtml } from "./dom-stub.mjs";

// ── ABI tối thiểu của phía RPC giả (định dạng dây dẫn, không phải logic production) ──────────
const ID_TO_MARKET_PARAMS = [{
  type: "function", name: "idToMarketParams", stateMutability: "view",
  inputs: [{ name: "id", type: "bytes32" }],
  outputs: [
    { name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" },
    { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" },
  ],
}];
const MARKET = [{
  type: "function", name: "market", stateMutability: "view",
  inputs: [{ name: "id", type: "bytes32" }],
  outputs: [
    { name: "totalSupplyAssets", type: "uint128" }, { name: "totalSupplyShares", type: "uint128" },
    { name: "totalBorrowAssets", type: "uint128" }, { name: "totalBorrowShares", type: "uint128" },
    { name: "lastUpdate", type: "uint128" }, { name: "fee", type: "uint128" },
  ],
}];
const POSITION = [{
  type: "function", name: "position", stateMutability: "view",
  inputs: [{ name: "id", type: "bytes32" }, { name: "user", type: "address" }],
  outputs: [
    { name: "supplyShares", type: "uint256" }, { name: "borrowShares", type: "uint128" },
    { name: "collateral", type: "uint128" },
  ],
}];
const ERC20 = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const MORPHO_WITHDRAW = [{
  type: "function", name: "withdraw", stateMutability: "nonpayable",
  inputs: [
    { name: "marketParams", type: "tuple", components: [
      { name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" },
      { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" },
    ] },
    { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" },
    { name: "onBehalf", type: "address" }, { name: "receiver", type: "address" },
  ],
  // Morpho Blue THẬT trả về (assetsWithdrawn, sharesWithdrawn). Phải khai đúng output, nếu không
  // `simulateContract` thấy `0x` và ném "returned no data" — bản ABI này là một phần của dây dẫn.
  outputs: [{ type: "uint256" }, { type: "uint256" }],
}];

const SELECTORS = {
  idToMarketParams: toFunctionSelector(ID_TO_MARKET_PARAMS[0]),
  market: toFunctionSelector(MARKET[0]),
  position: toFunctionSelector(POSITION[0]),
  decimals: toFunctionSelector(ERC20[0]),
  symbol: toFunctionSelector(ERC20[1]),
  withdraw: toFunctionSelector(MORPHO_WITHDRAW[0]),
};

/** Hash giả tất định: cùng chỉ số ⇒ cùng hash, khác chỉ số ⇒ khác hash. */
export const fakeHash = (n) => "0x" + (n + 1).toString(16).padStart(64, "0");

/** Địa chỉ Morpho Blue — cùng hằng số với production (`webapp-state.mjs`). */
export const MORPHO_BLUE_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

export const DEFAULT_MARKET_ID = "0x" + "a".repeat(64);
export const DEFAULT_LENDER = "0x" + "1".repeat(40);
export const DEFAULT_LOAN_TOKEN = "0x" + "2".repeat(40);
export const DEFAULT_COLLATERAL_TOKEN = "0x" + "3".repeat(40);

/** Cấu hình webapp (`window.MORPHO_CONFIG`) dùng chung cho mọi lần chạy. */
export function webappConfig(overrides = {}) {
  return {
    markets: [{ id: DEFAULT_MARKET_ID, minLiquidity: "5000", suddenDrainMultiplier: 2 }],
    lenderAddress: DEFAULT_LENDER,
    proxyRpcUrl: "http://127.0.0.1:8545",
    // MỘT url duy nhất: `fallbackTransport` chọn điểm bắt đầu ngẫu nhiên, nhiều url ⇒ trace
    // không tất định giữa hai lần chạy. Đây là lý do phải ép còn một.
    rpcUrls: ["http://127.0.0.1:1"],
    ...overrides,
  };
}

/**
 * Giải mã calldata `withdraw()` của Morpho thành các tham số có tên.
 *
 * Dùng cho CẢ hai chiều: test khẳng định tham số mà app thật gửi đi, và đó là artifact quan trọng
 * nhất của đường tiền — một đảo thứ tự `assets`/`shares` ở đây là mất tiền thật.
 */
export function decodeWithdrawCalldata(data) {
  const decoded = decodeFunctionData({ abi: MORPHO_WITHDRAW, data });
  const [params, assets, shares, onBehalf, receiver] = decoded.args;
  return {
    // `decodeFunctionData` trả tuple dưới dạng object có tên field (không phải mảng).
    loanToken: params.loanToken,
    collateralToken: params.collateralToken,
    oracle: params.oracle,
    irm: params.irm,
    lltv: params.lltv,
    assets,
    shares,
    onBehalf,
    receiver,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? 1, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? 1, error: { code, message } };
}

/**
 * RPC giả. Mọi lời gọi được ghi vào `calls` (sắp xếp được, không chứa thời gian).
 *
 * @param {object} [fixtures]
 * @param {object} [fixtures.marketParams] 5 field của `idToMarketParams`
 * @param {object} [fixtures.market] 6 field của `market`
 * @param {object} [fixtures.position] 3 field của `position`
 * @param {Map<string,{decimals:number,symbol:string}>} [fixtures.tokens] metadata ERC20 theo địa chỉ
 * @param {string|null} [fixtures.pendingNonce] giá trị `eth_getTransactionCount`
 * @param {boolean} [fixtures.txVisible] `eth_getTransactionByHash` trả tx thật hay `null`
 * @param {string[]} [fixtures.failingMethods] phương thức luôn trả lỗi JSON-RPC — dùng để dựng
 *   "RPC công cộng hỏng" (mặc định `[]`, không đổi hành vi của mọi kịch bản cũ)
 */
export function createFakeRpc(fixtures = {}) {
  const {
    marketParams = {
      loanToken: DEFAULT_LOAN_TOKEN, collateralToken: DEFAULT_COLLATERAL_TOKEN,
      oracle: "0x" + "4".repeat(40), irm: "0x" + "5".repeat(40), lltv: 860000000000000000n,
    },
    market = {
      totalSupplyAssets: 1_000_000_000n, totalSupplyShares: 1_000_000_000n,
      totalBorrowAssets: 400_000_000n, totalBorrowShares: 300_000_000n,
      lastUpdate: 1_700_000_000n, fee: 0n,
    },
    position = { supplyShares: 500_000_000n, borrowShares: 0n, collateral: 0n },
    tokens = new Map(),
    pendingNonce = "0xb",
    txVisible = true,
    failingMethods = [],
    // Phí gas RPC giả trả về. MUTABLE qua `setGas()` để kịch bản "bấm Tự Động Gas lần nữa"
    // có thể đổi phí giữa hai lần gọi (audit 2026-09-26, D14) — mặc định giữ nguyên hành vi cũ.
    priorityFee = "0x3b9aca00",
    baseFee = "0x3b9aca00",
  } = fixtures;
  let gasPriority = priorityFee;
  let gasBaseFee = baseFee;
  // Số nonce on-chain trả về là MUTABLE: kịch bản "nonce bị tiêu thụ trong lúc trang mở"
  // (chẩn đoán 2026-09-26) cần đổi nó giữa hai lần gọi.
  let nonce = pendingNonce;

  const calls = [];

  const metaOf = (address) => {
    const key = String(address).toLowerCase();
    if (tokens.has(key)) return tokens.get(key);
    if (key === DEFAULT_LOAN_TOKEN.toLowerCase()) return { decimals: 6, symbol: "USDC" };
    if (key === DEFAULT_COLLATERAL_TOKEN.toLowerCase()) return { decimals: 18, symbol: "dCOMP" };
    return { decimals: 18, symbol: "?" };
  };

  const blockFixture = {
    number: "0x10", hash: fakeHash(90), parentHash: fakeHash(91), nonce: "0x0000000000000000",
    sha3Uncles: fakeHash(92), logsBloom: "0x" + "0".repeat(512), transactionsRoot: fakeHash(93),
    stateRoot: fakeHash(94), receiptsRoot: fakeHash(95), miner: "0x" + "9".repeat(40),
    difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x100",
    gasLimit: "0x1c9c380", gasUsed: "0x5208", timestamp: "0x60000000", transactions: [],
    uncles: [], baseFeePerGas: gasBaseFee, mixHash: fakeHash(96),
  };

  const txFixture = (hash) => ({
    blockHash: fakeHash(97), blockNumber: "0x10", from: DEFAULT_LENDER,
    gas: "0x5208", hash, input: "0x", nonce: "0x1", to: "0x" + "b".repeat(40),
    transactionIndex: "0x0", value: "0x0", type: "0x0", gasPrice: "0x3b9aca00",
    chainId: "0x1", v: "0x1b", r: fakeHash(98), s: fakeHash(99),
  });

  const handleCall = (params) => {
    const [tx] = params ?? [];
    const to = String(tx?.to ?? "").toLowerCase();
    const data = String(tx?.data ?? "0x");
    const selector = data.slice(0, 10);
    if (selector === SELECTORS.idToMarketParams) {
      return encodeFunctionResult({
        abi: ID_TO_MARKET_PARAMS, functionName: "idToMarketParams",
        result: [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv],
      });
    }
    if (selector === SELECTORS.market) {
      return encodeFunctionResult({
        abi: MARKET, functionName: "market",
        result: [market.totalSupplyAssets, market.totalSupplyShares, market.totalBorrowAssets, market.totalBorrowShares, market.lastUpdate, market.fee],
      });
    }
    if (selector === SELECTORS.position) {
      return encodeFunctionResult({
        abi: POSITION, functionName: "position",
        result: [position.supplyShares, position.borrowShares, position.collateral],
      });
    }
    if (selector === SELECTORS.decimals) {
      return encodeFunctionResult({ abi: ERC20, functionName: "decimals", result: metaOf(to).decimals });
    }
    if (selector === SELECTORS.symbol) {
      return encodeFunctionResult({ abi: ERC20, functionName: "symbol", result: metaOf(to).symbol });
    }
    if (selector === SELECTORS.withdraw) {
      // Echo lại (assets, shares) mà chính calldata yêu cầu — đúng ngữ nghĩa Morpho.
      const decoded = decodeFunctionData({ abi: MORPHO_WITHDRAW, data });
      return encodeFunctionResult({
        abi: MORPHO_WITHDRAW, functionName: "withdraw",
        result: [decoded.args[1], decoded.args[2]],
      });
    }
    return "0x";
  };

  const handle = (req) => {
    const { method, params, id } = req;
    if (failingMethods.includes(method)) {
      return rpcError(id, -32000, `fake rpc: ${method} bị chặn (failingMethods)`);
    }
    switch (method) {
      case "eth_chainId": return rpcResult(id, "0x1");
      case "eth_blockNumber": return rpcResult(id, "0x10");
      case "eth_call": return rpcResult(id, handleCall(params));
      case "eth_estimateGas": return rpcResult(id, "0x5208");
      case "eth_getTransactionCount": return rpcResult(id, nonce);
      case "eth_gasPrice": return rpcResult(id, "0x3b9aca00");
      case "eth_maxPriorityFeePerGas": return rpcResult(id, gasPriority);
      case "eth_getBlockByNumber": return rpcResult(id, { ...blockFixture, baseFeePerGas: gasBaseFee });
      case "eth_getTransactionByHash": return rpcResult(id, txVisible ? txFixture(params?.[0]) : null);
      case "eth_getTransactionReceipt": return rpcResult(id, txVisible ? { transactionHash: params?.[0], status: "0x1", blockNumber: "0x10" } : null);
      default: return rpcError(id, -32601, `fake rpc: chưa hỗ trợ ${method}`);
    }
  };

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    const batch = Array.isArray(body) ? body : [body];
    for (const req of batch) {
      calls.push({ kind: "rpc", method: req.method, params: req.params ?? [] });
    }
    const responses = batch.map(handle);
    return jsonResponse(Array.isArray(body) ? responses : responses[0]);
  };

  return {
    fetch: fetchImpl,
    calls,
    /**
     * Đổi phí gas mà RPC giả trả về cho các lần gọi SAU (kịch bản D14: người dùng bấm
     * "Tự Động Gas" lần nữa sau khi đã ký). Không truyền field nào ⇒ giữ nguyên giá trị cũ,
     * nên ca âm ("phí KHÔNG đổi ⇒ phải GIỮ chữ ký") chạy được trên cùng một kịch bản.
     */
    setGas: ({ priorityFee: nextPriority, baseFee: nextBaseFee } = {}) => {
      if (nextPriority != null) gasPriority = nextPriority;
      if (nextBaseFee != null) gasBaseFee = nextBaseFee;
    },
    /**
     * Đổi nonce on-chain cho các lần gọi SAU — kịch bản "trang giữ nonce cũ, on-chain đã đi
     * qua" (chẩn đoán 2026-09-26). Nhận hex string ("0xa") hoặc bigint/number.
     */
    setNonce: (next) => {
      nonce = typeof next === "number" || typeof next === "bigint" ? `0x${BigInt(next).toString(16)}` : next;
    },
  };
}

/**
 * Ví EIP-1193 giả. `eth_sendTransaction` là nơi calldata rút tiền đi qua — artifact chính.
 */
export function createFakeProvider({ account = DEFAULT_LENDER, chainId = "0x1", signHashBase = 0 } = {}) {
  const calls = [];
  const listeners = new Map();
  let sentCount = 0;

  const request = async ({ method, params }) => {
    calls.push({ kind: "provider", method, params: params ?? [] });
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account];
      case "eth_chainId":
        return chainId;
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "personal_sign":
        return "0x" + "ab".repeat(65);
      case "eth_signTransaction":
        // Không dùng ở đường hiện tại (ví tài khoản JSON-RPC ⇒ viem gọi eth_sendTransaction),
        // nhưng nếu code đổi sang ký cục bộ thì trace sẽ lộ ra ngay thay vì im lặng.
        return "0x" + "cd".repeat(100);
      case "eth_sendTransaction": {
        sentCount += 1;
        return fakeHash(signHashBase + sentCount);
      }
      default:
        throw new Error(`fake provider: chưa hỗ trợ ${method}`);
    }
  };

  const provider = {
    isMetaMask: true,
    request,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    removeListener() {},
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
  };

  return { provider, calls };
}

/** REST giả cho `/api/*`. Mọi request được ghi lại kèm body. */
export function createFakeApi(fixtures = {}) {
  const {
    challenge = { ok: true, message: "Morpho monitor: xác thực ví", challenge: "0x" + "ef".repeat(32) },
    auth = { ok: true, token: "test-token", expiresAt: 4102444800000 },
    overview = {
      ok: true,
      markets: [{ id: DEFAULT_MARKET_ID, ladder: [{ status: "pending", nonce: 11, tiers: [{}] }] }],
      rounds: [{ nonce: 11, markets: [{ id: DEFAULT_MARKET_ID, status: "pending" }] }],
    },
    presign = {
      ok: true,
      exists: true,
      ladder: [{
        nonce: 11, status: "pending",
        tiers: [
          { amount: "100", amountWei: "100000000", amountFormatted: "100 USDC", label: "100 USDC" },
          { type: "all-shares", sharesWei: "500000000", amountFormatted: "Toàn bộ shares", label: "Rút toàn bộ shares" },
        ],
      }],
    },
    // Mặc định `null` ⇒ proxy giả trả ĐÚNG số tier mà body gửi lên (giống proxy thật, nơi số tier
    // trong phản hồi là kết quả merge). Truyền một object thì dùng đúng object đó.
    bundle = null,
    /**
     * `GET /api/captured` — bằng chứng nonce của chữ ký ví (proxy capture).
     *
     * Mặc định RỖNG: cây hiện tại coi "không có bằng chứng" là trung tính (không chặn ký, không
     * chặn lưu) nên mọi test cũ giữ nguyên hành vi. Ca cần đo phải tự khai `txs` với `hash` +
     * `nonce` (`fakeHash(n)` là hash mà ví giả trả cho lần ký thứ n).
     */
    captured = { ok: true, count: 0, txs: [] },
    deleteTier = { ok: true, removed: "100 USDC", remaining: 1 },
    /**
     * Lỗi TẠM THỜI theo đường dẫn, mặc định TẮT (không đổi hành vi mọi kịch bản cũ):
     * `{ "/api/presign": { status: 503, times: 1 } }` ⇒ `times` lần đầu trả `status` rồi mới
     * trả fixture. Dùng để dựng "một lần 503 thoáng qua rồi tự lành" (chẩn đoán 2026-09-26).
     */
    failures = {},
  } = fixtures;

  const calls = [];
  const remainingFailures = new Map(
    Object.entries(failures).map(([path, spec]) => [path, { status: spec.status ?? 503, times: spec.times ?? 1 }])
  );
  // `presign` là MUTABLE qua `setPresign()`: kịch bản ladder (rung expired + rung pending, chẩn
  // đoán 2026-09-26) cần đổi payload giữa hai lần đọc mà không phải nạp lại module.
  let presignFixture = presign;
  // `overview` cũng MUTABLE qua `setOverview()`: cần dựng shape lạ để thử lưới lỗi khi DỰNG
  // tổng quan (render ném) mà không phải nạp lại module (audit D15–D20, 2026-09-26).
  let overviewFixture = overview;
  // `bundle` (phản hồi POST /api/bundle, tức /bundle của proxy) cũng MUTABLE: kịch bản
  // "proxy từ chối vì nonce đã tiêu thụ" (D20) cần đổi phản hồi giữa hai lần lưu.
  let bundleFixture = bundle;
  // `captured` cũng MUTABLE: ca lệch nonce cần đổi bằng chứng GIỮA hai lần ký (ví đổi hành vi),
  // hoặc dựng bằng chứng xuất hiện muộn cho preflight của bước Lưu.
  let capturedFixture = captured;

  const fetchImpl = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const requestBody = init.body ? JSON.parse(init.body) : null;
    calls.push({
      kind: "api",
      method,
      url: String(url),
      body: requestBody,
      authorization: init.headers?.Authorization ?? init.headers?.authorization ?? null,
    });
    const pathOnly = String(url).split("?")[0];
    const failure = remainingFailures.get(pathOnly);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      calls[calls.length - 1].failure = failure.status; // để test đếm được lần lỗi
      return jsonResponse({ ok: false, error: "fake api: lỗi tạm thời" }, failure.status);
    }
    if (pathOnly === "/api/challenge") return jsonResponse(challenge);
    if (pathOnly === "/api/auth") return jsonResponse(auth);
    if (pathOnly === "/api/overview") return jsonResponse(overviewFixture);
    if (pathOnly === "/api/captured") return jsonResponse(capturedFixture);
    if (pathOnly === "/api/presign" && method === "DELETE") return jsonResponse(deleteTier);
    if (pathOnly === "/api/presign") return jsonResponse(presignFixture);
    if (pathOnly === "/api/bundle") {
      return jsonResponse(bundleFixture ?? { ok: true, tiers: requestBody?.tiers?.length ?? 0 });
    }
    return jsonResponse({ ok: false, error: `fake api: chưa hỗ trợ ${method} ${url}` }, 404);
  };

  return {
    fetch: fetchImpl,
    calls,
    /** Số lần lỗi tạm thời còn lại của một đường dẫn (0 = đã lành). */
    failuresLeft: (path) => remainingFailures.get(path)?.times ?? 0,
    /** Bơm lỗi tạm thời cho các lần gọi SAU của một đường dẫn. */
    failNext: (path, { status = 503, times = 1 } = {}) => {
      remainingFailures.set(path, { status, times });
    },
    /** Xoá lỗi tạm thời đã bơm (trả đường dẫn về trạng thái lành). */
    clearFailures: (path) => {
      remainingFailures.delete(path);
    },
    /** Đổi payload `GET /api/presign` cho các lần đọc sau (ladder khác). */
    /** Đổi payload `GET /api/overview` cho các lần đọc sau (shape lạ ⇒ thử nhánh lỗi DỰNG tổng quan). */
    setOverview: (next) => {
      overviewFixture = next;
    },
    setPresign: (next) => {
      presignFixture = next;
    },
    /** Đổi phản hồi `POST /api/bundle` (proxy) cho các lần lưu sau — vd `{ ok: false, code: "NONCE_CONSUMED" }`. */
    setBundle: (next) => {
      bundleFixture = next;
    },
    /** Đổi bằng chứng `GET /api/captured` (nonce thật của chữ ký) cho các lần đọc sau. */
    setCaptured: (next) => {
      capturedFixture = next;
    },
  };
}

/** Chuẩn hoá một lời gọi về dạng so sánh được (bỏ thứ tự, giữ nguyên nội dung). */
export function canonicalCall(call) {
  return JSON.stringify(call, (_key, value) => (typeof value === "bigint" ? `${value}n` : value));
}

/**
 * Cài môi trường + nạp webapp + chạy `init()`, trả về handle để lái và soi.
 *
 * `entry` là **đường dẫn tuyệt đối** tới `webapp-app.mjs` của cây cần kiểm, nên cùng hàm này
 * chạy được cả cây trước P5 (`git show` ra thư mục tạm) lẫn cây hiện tại.
 */
export async function loadWebapp({
  entry = path.resolve(process.cwd(), "webapp-app.mjs"),
  config = webappConfig(),
  rpc = createFakeRpc(),
  api = createFakeApi(),
  provider = createFakeProvider(),
  selfInjectedIds = new Set(),
  html = readWebappHtml(),
  confirmResult = true,
} = {}) {
  const traffic = [];
  const record = (calls) => {
    traffic.push(...calls);
    calls.length = 0;
  };

  const fetchImpl = async (url, init) => {
    const target = String(url);
    const source = target.startsWith("/api") ? api : rpc;
    const response = await source.fetch(target, init);
    record(source.calls);
    return response;
  };

  const env = installBrowserEnv({
    html,
    config,
    fetchImpl,
    ethereum: provider.provider,
    selfInjectedIds,
    confirmResult,
  });

  await import(pathToFileURL(entry).href);

  // Nạp xong mới lái init: readyState = "loading" nên app đã đăng ký DOMContentLoaded.
  await env.fireDomContentLoaded();
  record(provider.calls);

  const window = env.window;

  return {
    env,
    window,
    /** Lấy (và xoá) mọi lời gọi đã xảy ra kể từ lần lấy trước. */
    takeCalls() {
      record(provider.calls);
      record(rpc.calls);
      record(api.calls);
      const taken = traffic.splice(0, traffic.length);
      return taken.map(canonicalCall).sort();
    },
    /** Nội dung text của một element theo id (dùng để chụp trạng thái UI). */
    text(id) {
      const el = env.elements.get(id);
      return el ? String(el.textContent) : null;
    },
    /** `innerHTML` của một element (đã materialize id bên trong, như browser). */
    html(id) {
      const el = env.elements.get(id);
      return el ? String(el.innerHTML) : null;
    },
    value(id) {
      const el = env.elements.get(id);
      return el ? String(el.value) : null;
    },
    setValue(id, value) {
      const el = env.elements.get(id);
      if (!el) throw new Error(`harness: không có element #${id}`);
      el.value = String(value);
    },
    restore() {
      env.restore();
    },
  };
}
