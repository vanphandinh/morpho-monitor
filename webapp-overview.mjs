/**
 * Tab "Tổng quan": RPC client, nạp market/position, chuyển market (audit P5).
 *
 * Chỉ phụ thuộc lớp lá (state/shell/logic/render) — không gọi ngược lên luồng ký/rút.
 */

import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { computeBorrowAssets, computeLiquidity, computeSupplyAssets, computeUtilization, shortenAddr, wadToPercent } from "./webapp-logic.mjs";
import { formatToken, row } from "./webapp-render.mjs";
import { ERC20_ABI, MORPHO_ABI, MORPHO_BLUE, RPC_URLS, SERVER_MARKETS, state } from "./webapp-state.mjs";

/**
 * Fallback transport — bản rút gọn của server-side round-robin transport.
 * Mỗi request bắt đầu từ URL hiện tại (random lúc khởi tạo).
 * Nếu thất bại → thử URL tiếp theo. Thành công → advance index cho request sau.
 * Không có circuit breaker vì browser session ngắn.
 */
function fallbackTransport(urls, opts = {}) {
  const { timeout = 15000 } = opts;
  let idx = Math.floor(Math.random() * urls.length); // random start — phân tán tải

  return (config) => {
    const transports = urls.map(url => http(url, { timeout })(config));

    return {
      ...transports[0],
      request: async (args) => {
        let lastError;
        for (let i = 0; i < urls.length; i++) {
          const urlIdx = (idx + i) % urls.length;
          try {
            const result = await transports[urlIdx].request(args);
            idx = (urlIdx + 1) % urls.length; // advance cho request tiếp theo
            return result;
          } catch (err) {
            lastError = err;
          }
        }
        throw lastError;
      },
    };
  };
}

export async function createRpcClient() {
  const client = createPublicClient({
    chain: mainnet,
    transport: fallbackTransport(RPC_URLS, { timeout: 15000 }),
  });
  // Startup health check — chỉ fail nếu TẤT CẢ URL đều down
  await client.getChainId();
  return client;
}

// ============================================================
// FETCH DATA
// ============================================================
export async function fetchAllData() {
  // Fetch market params
  const params = await state.publicClient.readContract({
    address: MORPHO_BLUE,
    abi: MORPHO_ABI,
    functionName: "idToMarketParams",
    args: [state.marketId],
  });
  state.marketParams = {
    loanToken: params[0],
    collateralToken: params[1],
    oracle: params[2],
    irm: params[3],
    lltv: params[4],
  };

  // Fetch market state + position + token metadata in parallel
  const [market, position, cToken, lToken] = await Promise.all([
    state.publicClient.readContract({
      address: MORPHO_BLUE,
      abi: MORPHO_ABI,
      functionName: "market",
      args: [state.marketId],
    }),
    state.publicClient.readContract({
      address: MORPHO_BLUE,
      abi: MORPHO_ABI,
      functionName: "position",
      args: [state.marketId, state.lenderAddress],
    }),
    state.publicClient.readContract({
      address: state.marketParams.collateralToken,
      abi: ERC20_ABI,
      functionName: "decimals",
    }).then(d => state.publicClient.readContract({
      address: state.marketParams.collateralToken, abi: ERC20_ABI, functionName: "symbol",
    }).then(s => ({ decimals: d, symbol: s }))).catch(() => ({ decimals: 18, symbol: "?" })),
    state.publicClient.readContract({
      address: state.marketParams.loanToken,
      abi: ERC20_ABI,
      functionName: "decimals",
    }).then(d => state.publicClient.readContract({
      address: state.marketParams.loanToken, abi: ERC20_ABI, functionName: "symbol",
    }).then(s => ({ decimals: d, symbol: s }))).catch(() => ({ decimals: 6, symbol: "?" })),
  ]);

  state.marketData = {
    totalSupplyAssets: market[0],
    totalSupplyShares: market[1],
    totalBorrowAssets: market[2],
    totalBorrowShares: market[3],
    lastUpdate: market[4],
    fee: market[5],
  };

  state.positionData = {
    supplyShares: position[0],
    borrowShares: position[1],
    collateral: position[2],
  };

  state.collateralToken = cToken;
  state.loanToken = lToken;

  // Compute derived values
  const supplyAssets = computeSupplyAssets(
    state.positionData.supplyShares,
    state.marketData.totalSupplyAssets,
    state.marketData.totalSupplyShares
  );

  state.marketData.liquidity = computeLiquidity(state.marketData.totalSupplyAssets, state.marketData.totalBorrowAssets);
  state.marketData.supplyAssets = supplyAssets;
  state.marketData.utilization = computeUtilization(state.marketData.totalBorrowAssets, state.marketData.totalSupplyAssets);
}

// ============================================================
// RENDER
// ============================================================
export function renderMarketInfo() {
  const liquidity = state.marketData.liquidity;
  const liquidityClass = liquidity > 0n ? "green" : "red";

  document.getElementById("market-info").innerHTML = [
    row("Collateral", `${shortenAddr(state.marketParams.collateralToken)} (${state.collateralToken.symbol})`),
    row("Loan Token", `${shortenAddr(state.marketParams.loanToken)} (${state.loanToken.symbol})`),
    row("Oracle", shortenAddr(state.marketParams.oracle)),
    row("IRM", shortenAddr(state.marketParams.irm)),
    row("LLTV", wadToPercent(state.marketParams.lltv)),
    row("Total Supply", formatToken(state.marketData.totalSupplyAssets, state.loanToken)),
    row("Total Borrow", formatToken(state.marketData.totalBorrowAssets, state.loanToken)),
    row("Liquidity",
      `<span class="value ${liquidityClass}">${formatToken(liquidity, state.loanToken)}</span>`),
    row("Utilization", wadToPercent(state.marketData.utilization)),
  ].join("");

  document.getElementById("market-section").style.display = "block";

  // Show liquidity warning if 0
  const warnEl = document.getElementById("liquidity-warning");
  if (liquidity === 0n) {
    warnEl.style.display = "block";
    warnEl.textContent = "⚠️ Market đang 100% utilized. Giao dịch rút tiền sẽ thất bại cho đến khi có thanh khoản.";
  } else {
    warnEl.style.display = "none";
  }
}

export function renderPosition() {
  const supplyAssets = state.marketData.supplyAssets;

  document.getElementById("position-info").innerHTML = [
    row("Supply Shares", state.positionData.supplyShares.toString()),
    row("Supply Assets", formatToken(supplyAssets, state.loanToken)),
    row("Borrow Shares", state.positionData.borrowShares.toString()),
    row("Borrow Assets", formatToken(
      computeBorrowAssets(state.positionData.borrowShares, state.marketData.totalBorrowAssets, state.marketData.totalBorrowShares),
      state.loanToken
    )),
    row("Collateral", formatToken(state.positionData.collateral, state.collateralToken)),
  ].join("");

  document.getElementById("position-section").style.display = "block";

  // MAX = min(supplyAssets, liquidity): chỉ rút được tối đa bằng thanh khoản hiện có
  const maxWithdraw = supplyAssets < state.marketData.liquidity ? supplyAssets : state.marketData.liquidity;
  document.getElementById("max-withdraw").textContent = formatToken(maxWithdraw, state.loanToken);
}

// ============================================================
// MARKET SWITCHER (>1 market)
// ============================================================
export function initMarketSwitcher() {
  const wrap = document.getElementById("market-switcher-wrap");
  const select = document.getElementById("market-switcher");
  if (!wrap || !select || SERVER_MARKETS.length <= 1) return;
  const short = (id) => `${id.slice(0, 10)}…${id.slice(-4)}`;
  select.innerHTML = SERVER_MARKETS.map((m) =>
    `<option value="${m.id}"${m.id === state.marketId ? " selected" : ""}>${short(m.id)}</option>`
  ).join("");
  wrap.style.display = "block";
}

export function switchMarket(id) {
  if (!id || id === state.marketId) return;
  location.search = `?market=${encodeURIComponent(id)}`;
};
