import { blueAbi } from "@morpho-org/blue-sdk-viem";
import { AccrualPosition, Market, Position } from "@morpho-org/blue-sdk";
import { decodeAbiParameters, erc20Abi, parseUnits } from "viem";
import { CHAIN_ID, MORPHO_BLUE_ADDRESS } from "./shared.mjs";

/**
 * Zero address — `Morpho.idToMarketParams(id)` trả NGUYÊN struct 0 cho market id
 * không tồn tại (mapping mặc định), nên params toàn zero là dấu hiệu cấu hình sai
 * chứ không phải market rỗng.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Error code: configured market id does not exist on-chain (all-zero params). */
export const MARKET_PARAMS_ZERO = "MARKET_PARAMS_ZERO";

/**
 * Read Morpho market params directly from the configured Morpho contract.
 *
 * Không dùng `fetchMarketParams` của blue-sdk-viem: fetcher đó tra registry
 * chain nội bộ của SDK. Với deployment một chain, địa chỉ Morpho phải là địa
 * chỉ trong `config/chains.json`, không phải registry của SDK.
 */
async function defaultFetchParams(id, client, { morphoBlueAddress }) {
  const raw = await client.readContract({
    address: morphoBlueAddress,
    abi: blueAbi,
    functionName: "idToMarketParams",
    args: [id],
  });
  const params = Array.isArray(raw)
    ? { loanToken: raw[0], collateralToken: raw[1], oracle: raw[2], irm: raw[3], lltv: raw[4] }
    : raw;
  return {
    loanToken: params.loanToken,
    collateralToken: params.collateralToken,
    oracle: params.oracle,
    irm: params.irm,
    lltv: params.lltv,
  };
}

/**
 * Read ERC20 decimals/symbol directly through the chain client. `symbol()` is
 * bytes32 on a few legacy tokens; fall back to a raw call and decode bytes32.
 */
async function defaultFetchToken(address, client) {
  const [decimalsResult, symbolResult] = await client.multicall({
    contracts: [
      { address, abi: erc20Abi, functionName: "decimals" },
      { address, abi: erc20Abi, functionName: "symbol" },
    ],
    allowFailure: true,
  });

  if (decimalsResult.status !== "success") {
    throw new Error(`Cannot read decimals() for token ${address}`);
  }

  let symbol = symbolResult.status === "success" ? symbolResult.result : null;
  if (!symbol) {
    try {
      const raw = await client.call({ to: address, data: "0x95d89b41" });
      if (raw?.data && raw.data !== "0x") {
        const [decoded] = decodeAbiParameters([{ type: "bytes32" }], raw.data);
        symbol = String(decoded).replace(/\0.*$/, "").trim();
      }
    } catch {
      // Symbol is display-only; a token without it still works.
    }
  }

  return {
    address,
    decimals: Number(decimalsResult.result),
    symbol: symbol || null,
  };
}

/**
 * Deep read module: immutable params/token metadata are initialized once;
 * dynamic market and lender position state are read together via Multicall.
 *
 * `fetchParams`/`fetchTokenById` are injectable (audit P0.3) so this module — the
 * load-bearing "one multicall at one block" contract — is testable with fakes
 * instead of a live RPC.
 */
export async function createMarketReader({
  chainId = CHAIN_ID,
  client,
  lenderAddress,
  morphoBlueAddress = MORPHO_BLUE_ADDRESS,
  markets,
  fetchParams = defaultFetchParams,
  fetchTokenById = defaultFetchToken,
}) {
  const tokenCache = new Map();
  const runtimes = new Map();
  const unknownIds = [];

  for (const config of markets) {
    const params = await fetchParams(config.id, client, { chainId, morphoBlueAddress });
    // Fail fast (audit P0.3): một chữ sai trong config/markets.json trước đây biến
    // market đó thành market rỗng "hợp lệ" (liquidity 0, symbol undefined) và
    // monitor im lặng không bao giờ cảnh báo. Thà chết lúc khởi động kèm id.
    //
    // Audit vòng 5: KHÔNG throw ngay tại đây — quét hết danh sách trước. Với
    // markets.json nhiều market, throw-ngay bắt người vận hành sửa một id rồi
    // restart mới thấy id sai tiếp theo; gom lại thì một lần khởi động báo đủ.
    if (!params?.loanToken || params.loanToken.toLowerCase() === ZERO_ADDRESS) {
      unknownIds.push(config.id);
      continue; // không tốn RPC đọc token của market chắc chắn sai
    }
    const tokenFor = async (address) => {
      const key = `${chainId}:${address.toLowerCase()}`;
      if (!tokenCache.has(key)) tokenCache.set(key, fetchTokenById(address, client, { chainId }));
      return tokenCache.get(key);
    };
    const [loanToken, collateralToken] = await Promise.all([
      tokenFor(params.loanToken),
      tokenFor(params.collateralToken),
    ]);
    runtimes.set(config.id, {
      ...config,
      chainId,
      params,
      loanToken,
      collateralToken,
      minLiquidityWei: parseUnits(config.minLiquidity, loanToken.decimals),
    });
  }

  if (unknownIds.length) {
    const err = new Error(
      `❌ ${unknownIds.length} market id không tồn tại on-chain (params toàn zero) trên chain ${chainId}:\n` +
      unknownIds.map((id) => `   • ${id}`).join("\n") +
      `\n   → Kiểm tra lại \`id\` trong config/markets.json (MARKETS_FILE) — chain ${chainId}.`
    );
    err.code = MARKET_PARAMS_ZERO;
    err.chainId = chainId;
    err.marketId = unknownIds[0]; // back-compat: một id đầu tiên
    err.marketIds = unknownIds;   // đủ danh sách cho log/handler
    throw err;
  }

  async function readSnapshots(ids = [...runtimes.keys()]) {
    const requested = ids.map((id) => runtimes.get(id)).filter(Boolean);
    if (!requested.length) return { blockNumber: null, snapshots: new Map(), failures: new Map() };
    const blockNumber = await client.getBlockNumber();
    const contracts = requested.flatMap((runtime) => [
      { address: morphoBlueAddress, abi: blueAbi, functionName: "market", args: [runtime.id] },
      { address: morphoBlueAddress, abi: blueAbi, functionName: "position", args: [runtime.id, lenderAddress] },
    ]);
    const results = await client.multicall({
      contracts,
      blockNumber,
      allowFailure: true,
      batchSize: 4096,
    });
    const snapshots = new Map();
    const failures = new Map();
    for (let i = 0; i < requested.length; i++) {
      const runtime = requested[i];
      const marketResult = results[i * 2];
      const positionResult = results[i * 2 + 1];
      if (marketResult.status !== "success" || positionResult.status !== "success") {
        failures.set(runtime.id, marketResult.error || positionResult.error || new Error("multicall failed"));
        continue;
      }
      const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = marketResult.result;
      const [supplyShares, borrowShares, collateral] = positionResult.result;
      const market = new Market({
        params: runtime.params,
        totalSupplyAssets,
        totalSupplyShares,
        totalBorrowAssets,
        totalBorrowShares,
        lastUpdate,
        fee,
      });
      const rawPosition = new Position({ user: lenderAddress, marketId: runtime.id, supplyShares, borrowShares, collateral });
      const position = new AccrualPosition(rawPosition, market);
      snapshots.set(runtime.id, { ...runtime, market, position, blockNumber });
    }
    return { blockNumber, snapshots, failures };
  }

  return { markets: [...runtimes.values()], readSnapshots };
}
