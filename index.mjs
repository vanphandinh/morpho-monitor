import { CHAIN, CHAIN_ID, CHAIN_NAME, LENDER_ADDRESS, MORPHO_BLUE_ADDRESS, RPC_URLS, MARKETS_FILE, formatTokenAmount, wadToPercent } from "./shared.mjs";
import { createChainBoundPublicClient } from "./rpc-client.mjs";
import { loadMarkets } from "./market-config.mjs";
import { createMarketReader } from "./market-reader.mjs";

async function main() {
  const markets = loadMarkets(MARKETS_FILE);
  const { client } = await createChainBoundPublicClient(RPC_URLS, { chain: CHAIN.chain });
  const reader = await createMarketReader({ chainId: CHAIN_ID, client, lenderAddress: LENDER_ADDRESS, morphoBlueAddress: MORPHO_BLUE_ADDRESS, markets });
  const { blockNumber, snapshots, failures } = await reader.readSnapshots();
  console.log(`[${CHAIN_NAME} ${CHAIN_ID}] Morpho Blue markets at block ${blockNumber}`);
  for (const snapshot of snapshots.values()) {
    const { market, position, loanToken, collateralToken, id } = snapshot;
    console.log(`\n${id}\n  Market: ${collateralToken.symbol || "?"}/${loanToken.symbol || "?"}\n  Liquidity: ${formatTokenAmount(market.liquidity, loanToken.decimals, loanToken.symbol)}\n  Your supply: ${formatTokenAmount(position.supplyAssets, loanToken.decimals, loanToken.symbol)}\n  Utilization: ${wadToPercent(market.utilization)}`);
  }
  for (const [id, error] of failures) console.error(`${id}: ${error.message || error}`);
}
main().catch((error) => { console.error("Error:", error.message); process.exit(1); });
