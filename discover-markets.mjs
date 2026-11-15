/**
 * Pre-start market discovery CLI.
 *
 * Run by docker-entrypoint.sh before monitor/webapp/proxy. Manual
 * config/markets.json wins; otherwise this refreshes data/markets.auto.json
 * from the Morpho REST API. The three long-running services only read files.
 */
import { pathToFileURL } from "node:url";
import {
  AUTO_MARKETS_CONFIG,
  AUTO_MARKETS_FILE,
  CHAIN,
  CHAIN_ID,
  LENDER_ADDRESS,
  MARKETS_FILE,
  MORPHO_BLUE_ADDRESS,
} from "./shared.mjs";
import { discoverAndWriteMarkets } from "./market-discovery.mjs";

async function main() {
  const result = await discoverAndWriteMarkets({
    marketsFile: MARKETS_FILE,
    autoMarketsFile: AUTO_MARKETS_FILE,
    lenderAddress: LENDER_ADDRESS,
    chainId: CHAIN_ID,
    morphoBlueAddress: MORPHO_BLUE_ADDRESS,
    canonicalMorphoBlueAddress: CHAIN.morphoBlueAddress,
    ...AUTO_MARKETS_CONFIG,
  });
  console.log(`[markets] ${result.mode}: ${result.markets.length} market(s)`);
}

const isDirectRun = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal markets discovery error:", err.message);
    process.exit(1);
  });
}
