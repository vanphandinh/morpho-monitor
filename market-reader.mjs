import { fetchMarketParams, fetchToken, blueAbi } from "@morpho-org/blue-sdk-viem";
import { AccrualPosition, Market, Position } from "@morpho-org/blue-sdk";
import { parseUnits } from "viem";

/**
 * Deep read module: immutable params/token metadata are initialized once;
 * dynamic market and lender position state are read together via Multicall.
 */
export async function createMarketReader({ client, lenderAddress, morphoBlueAddress, markets }) {
  const tokenCache = new Map();
  const runtimes = new Map();

  for (const config of markets) {
    const params = await fetchMarketParams(config.id, client, { chainId: 1 });
    const tokenFor = async (address) => {
      const key = address.toLowerCase();
      if (!tokenCache.has(key)) tokenCache.set(key, fetchToken(address, client, { chainId: 1 }));
      return tokenCache.get(key);
    };
    const [loanToken, collateralToken] = await Promise.all([
      tokenFor(params.loanToken),
      tokenFor(params.collateralToken),
    ]);
    runtimes.set(config.id, {
      ...config,
      params,
      loanToken,
      collateralToken,
      minLiquidityWei: parseUnits(config.minLiquidity, loanToken.decimals),
    });
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
