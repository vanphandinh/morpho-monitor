import { formatUnits } from "viem";
import { fetchMarket, fetchAccrualPosition, fetchToken } from "@morpho-org/blue-sdk-viem";
import { Time } from "@morpho-org/morpho-ts";
import {
  MARKET_ID,
  LENDER_ADDRESS,
  RPC_URLS,
  createClient,
  wadToPercent,
  formatTokenAmount,
  formatApy,
} from "./shared.mjs";

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     Morpho Blue - Market & Lender Info          ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // 1. Create client
  const client = await createClient(RPC_URLS);

  // 2. Fetch market data
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📊 Fetching market data...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const market = await fetchMarket(MARKET_ID, client, { deployless: false });

  // 3. Fetch token metadata for both collateral and loan tokens
  console.log("\n🔍 Fetching token metadata...");
  const [collateralToken, loanToken] = await Promise.all([
    fetchToken(market.params.collateralToken, client, { deployless: false }),
    fetchToken(market.params.loanToken, client, { deployless: false }),
  ]);

  const collateralDecimals = collateralToken.decimals;
  const loanDecimals = loanToken.decimals;
  const collateralSymbol = collateralToken.symbol;
  const loanSymbol = loanToken.symbol;

  // 4. Fetch lender position (AccrualPosition = position + market state)
  console.log("\n👤 Fetching lender position...");
  const position = await fetchAccrualPosition(LENDER_ADDRESS, MARKET_ID, client, { deployless: false });

  // ============================================================
  // DISPLAY: Market Info
  // ============================================================
  console.log("\n\n╔══════════════════════════════════════════════════╗");
  console.log("║              📊 MARKET INFO                      ║");
  console.log("╚══════════════════════════════════════════════════╝");

  console.log(`\n  Market ID:       ${market.id}`);
  console.log(`  Collateral:      ${market.params.collateralToken} (${collateralSymbol ?? "?"} - ${collateralDecimals ?? "?"} decimals)`);
  console.log(`  Loan Token:      ${market.params.loanToken} (${loanSymbol ?? "?"} - ${loanDecimals ?? "?"} decimals)`);
  console.log(`  Oracle:          ${market.params.oracle}`);
  console.log(`  IRM:             ${market.params.irm}`);
  console.log(`  LLTV:            ${wadToPercent(market.params.lltv)}`);

  console.log(`\n  ── State ──`);
  console.log(`  Total Supply:    ${formatTokenAmount(market.totalSupplyAssets, loanDecimals, loanSymbol)}`);
  console.log(`  Total Borrow:    ${formatTokenAmount(market.totalBorrowAssets, loanDecimals, loanSymbol)}`);
  console.log(`  Liquidity:       ${formatTokenAmount(market.liquidity, loanDecimals, loanSymbol)}`);
  console.log(`  Utilization:     ${wadToPercent(market.utilization)}`);
  console.log(`  Oracle Price:    ${market.price != null ? formatUnits(market.price, 36) : "N/A"} (${collateralSymbol}/${loanSymbol})`);
  console.log(`  Fee:             ${wadToPercent(market.fee)}`);

  console.log(`\n  ── Rates ──`);
  console.log(`  Supply APY:      ${formatApy(market.supplyApy)}`);
  console.log(`  Borrow APY:      ${formatApy(market.borrowApy)}`);
  if (market.apyAtTarget != null) {
    console.log(`  APY at Target:   ${formatApy(market.apyAtTarget)}`);
  }

  console.log(`\n  ── Timestamps ──`);
  console.log(`  Last Update:     ${new Date(Number(market.lastUpdate) * 1000).toISOString()}`);
  console.log(`  Current Time:    ${new Date(Number(Time.timestamp()) * 1000).toISOString()}`);

  // ============================================================
  // DISPLAY: Lender Position
  // ============================================================
  console.log("\n\n╔══════════════════════════════════════════════════╗");
  console.log("║           👤 LENDER POSITION                     ║");
  console.log("╚══════════════════════════════════════════════════╝");

  console.log(`\n  Wallet:          ${position.user}`);
  console.log(`  Market ID:       ${position.market.id}`);

  console.log(`\n  ── Supply (Lending) ──`);
  console.log(`  Supply Shares:   ${position.supplyShares.toString()}`);
  console.log(`  Supply Assets:   ${formatTokenAmount(position.supplyAssets, loanDecimals, loanSymbol)}`);

  console.log(`\n  ── Borrow ──`);
  console.log(`  Borrow Shares:   ${position.borrowShares.toString()}`);
  console.log(`  Borrow Assets:   ${formatTokenAmount(position.borrowAssets, loanDecimals, loanSymbol)}`);

  console.log(`\n  ── Collateral ──`);
  console.log(`  Collateral:      ${formatTokenAmount(position.collateral, collateralDecimals, collateralSymbol)}`);
  if (position.collateralValue != null) {
    console.log(`  Collateral Value: ${formatTokenAmount(position.collateralValue, loanDecimals, loanSymbol)}`);
  }

  console.log(`\n  ── Health Metrics ──`);
  if (position.isHealthy != null) {
    console.log(`  Is Healthy:      ${position.isHealthy ? "✅ Yes" : "❌ No"}`);
  }
  if (position.healthFactor != null) {
    const hf = Number(position.healthFactor) / 1e18;
    console.log(`  Health Factor:   ${hf.toFixed(4)}`);
  }
  if (position.ltv != null) {
    console.log(`  LTV:             ${wadToPercent(position.ltv)}`);
  }
  if (position.maxBorrowableAssets != null) {
    console.log(`  Max Borrowable:  ${formatTokenAmount(position.maxBorrowableAssets, loanDecimals, loanSymbol)}`);
  }
  if (position.liquidationPrice != null) {
    console.log(`  Liquidation Price: ${formatUnits(position.liquidationPrice, 36)} (${collateralSymbol}/${loanSymbol})`);
  }
  if (position.priceVariationToLiquidationPrice != null) {
    const pctVar = (Number(position.priceVariationToLiquidationPrice) / 1e16);
    const sign = pctVar < 0 ? "" : "+";
    console.log(`  Price Var to Liq: ${sign}${pctVar.toFixed(2)}%`);
  }

  // Check if this address has NO position on this market
  const hasNoPosition =
    position.supplyShares === 0n &&
    position.borrowShares === 0n &&
    position.collateral === 0n;

  if (hasNoPosition) {
    console.log(`\n  ⚠️  This wallet has NO active position on this market.`);
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ Done.");
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  if (error.cause) {
    console.error("  Cause:", error.cause);
  }
  process.exit(1);
});
