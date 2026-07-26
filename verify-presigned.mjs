import fs from "node:fs";
import { formatUnits } from "viem";
import {
  verifyPresignedBundle,
  verifyWithdrawCalldata,
  computeMarketId,
  MORPHO_WITHDRAW_ABI,
} from "./presign-verify.mjs";
import { parseTransaction, decodeFunctionData } from "viem";

// Re-export for callers that import from CLI path
export { verifyPresignedBundle, verifyWithdrawCalldata, computeMarketId, MORPHO_WITHDRAW_ABI };

function shorten(addr) {
  if (!addr) return "N/A";
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

const filePath = process.argv[2] || "./presigned.json";

if (!fs.existsSync(filePath)) {
  console.error(`❌ File không tồn tại: ${filePath}`);
  process.exit(1);
}

let bundle;
try {
  bundle = JSON.parse(fs.readFileSync(filePath, "utf-8"));
} catch (err) {
  console.error(`❌ Lỗi parse JSON: ${err.message}`);
  process.exit(1);
}

if (!bundle.withdrawals || bundle.withdrawals.length === 0) {
  console.log("📄 Bundle rỗng — không có withdrawal nào.");
  process.exit(0);
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║   Verify Presigned Bundle                              ║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log("");
console.log(`  File:      ${filePath}`);
console.log(`  Status:    ${bundle.status}`);
console.log(`  Nonce:     ${bundle.nonce}`);
console.log(`  Created:   ${bundle.createdAt}`);
console.log(`  Chain ID:  ${bundle.chainId}`);
console.log(`  Market:    ${bundle.marketId ? shorten(bundle.marketId) : "N/A"}`);
console.log(`  Lender:    ${bundle.lenderAddress ? shorten(bundle.lenderAddress) : "N/A"}`);
console.log(`  Tiers:     ${bundle.withdrawals.length}`);
console.log("");

if (bundle.maxFeePerGas) {
  console.log(`  MaxFeePerGas:         ${bundle.maxFeePerGas} (${formatUnits(BigInt(bundle.maxFeePerGas), 9)} gwei)`);
}
if (bundle.maxPriorityFeePerGas) {
  console.log(`  MaxPriorityFeePerGas: ${bundle.maxPriorityFeePerGas} (${formatUnits(BigInt(bundle.maxPriorityFeePerGas), 9)} gwei)`);
}
console.log(`  Gas Limit:            ${bundle.gas || "N/A"}`);
console.log("");

let matched = 0;
let mismatched = 0;

for (let i = 0; i < bundle.withdrawals.length; i++) {
  const w = bundle.withdrawals[i];
  const isAllShares = w.type === "all-shares";
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📌 ${isAllShares ? "All-Shares" : `Tier ${i + 1}`}: "${w.label || "N/A"}"`);
  if (isAllShares) {
    console.log(`   sharesWei:         ${w.sharesWei || "N/A"}`);
    console.log(`   amountFormatted:   ${w.amountFormatted || "N/A"}`);
  } else {
    console.log(`   amountWei:         ${w.amountWei} (${formatUnits(BigInt(w.amountWei || "0"), 6)} USDC)`);
    console.log(`   amountFormatted:   ${w.amountFormatted || "N/A"}`);
  }

  if (!w.signedTx) {
    console.log(`   ❌ KHÔNG CÓ signedTx`);
    mismatched++;
    continue;
  }

  let tx;
  try {
    tx = parseTransaction(w.signedTx);
  } catch (err) {
    console.log(`   ❌ Lỗi parse signedTx: ${err.message}`);
    mismatched++;
    continue;
  }

  console.log(`   ── Transaction ──`);
  console.log(`   chainId:           ${tx.chainId}`);
  console.log(`   nonce:             ${tx.nonce}`);
  console.log(`   to:                ${tx.to}`);
  console.log(`   gas:               ${tx.gas?.toString() || "N/A"}`);

  const result = await verifyWithdrawCalldata(w.signedTx, {
    morphoBlueAddress: bundle.morphoBlueAddress,
    lenderAddress: bundle.lenderAddress,
    marketId: bundle.marketId,
    nonce: bundle.nonce,
    amountWei: w.amountWei,
    sharesWei: w.sharesWei,
    isAllShares,
  });

  if (result.ok) {
    const d = result.decoded;
    console.log(`   ── Morpho withdraw params ──`);
    console.log(`   assets:            ${d.assets?.toString()}`);
    console.log(`   shares:            ${d.shares?.toString()}`);
    console.log(`   onBehalf:          ${d.onBehalf}`);
    console.log(`   receiver:          ${d.receiver}`);
    console.log(`   from:              ${d.from}`);
    console.log(`   ✅ KHỚP`);
    matched++;
  } else {
    // Still try to dump decode for debugging
    try {
      const decoded = decodeFunctionData({ abi: MORPHO_WITHDRAW_ABI, data: tx.data });
      console.log(`   function:          ${decoded.functionName}`);
      console.log(`   assets:            ${decoded.args[1]?.toString()}`);
      console.log(`   shares:            ${decoded.args[2]?.toString()}`);
    } catch { /* ignore */ }
    console.log(`   ❌ ${result.error}`);
    mismatched++;
  }
}

const bundleResult = await verifyPresignedBundle(bundle);
console.log("");
console.log("╔══════════════════════════════════════════════════════════╗");
console.log(`║   Kết quả: ${matched} khớp, ${mismatched} mismatch / ${bundle.withdrawals.length} tiers`);
if (!bundleResult.ok) {
  console.log(`║   Bundle check: ${bundleResult.error}`);
}
console.log("╚══════════════════════════════════════════════════════════╝");

if (mismatched > 0 || !bundleResult.ok) {
  process.exit(1);
}
