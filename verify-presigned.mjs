import fs from "node:fs";
import { parseTransaction, decodeFunctionData, formatUnits } from "viem";
import { mainnet } from "viem/chains";

// ============================================================
// Morpho Blue ABI (hàm withdraw)
// ============================================================
const MORPHO_ABI = [{
  type: "function",
  name: "withdraw",
  inputs: [
    { name: "marketParams", type: "tuple", internalType: "MarketParams",
      components: [
        { name: "loanToken", type: "address" },
        { name: "collateralToken", type: "address" },
        { name: "oracle", type: "address" },
        { name: "irm", type: "address" },
        { name: "lltv", type: "uint256" },
      ]
    },
    { name: "assets", type: "uint256" },
    { name: "shares", type: "uint256" },
    { name: "onBehalf", type: "address" },
    { name: "receiver", type: "address" },
  ],
  outputs: [
    { name: "withdrawnAssets", type: "uint256" },
    { name: "withdrawnShares", type: "uint256" },
  ],
  stateMutability: "nonpayable",
}];

// ============================================================
// Helpers
// ============================================================
function formatAmount(wei, decimals = 6) {
  return `${formatUnits(BigInt(wei), decimals)} (${wei} wei)`;
}

function shorten(addr) {
  if (!addr) return "N/A";
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

// ============================================================
// Main
// ============================================================
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
const txNonces = []; // thu thập nonce từ tất cả tx để cross-check

for (let i = 0; i < bundle.withdrawals.length; i++) {
  const w = bundle.withdrawals[i];
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📌 Tier ${i + 1}: "${w.label || "N/A"}"`);
  console.log(`   amountWei:         ${w.amountWei} (${formatUnits(BigInt(w.amountWei || "0"), 6)} USDC)`);
  console.log(`   amountFormatted:   ${w.amountFormatted || "N/A"}`);

  if (!w.signedTx) {
    console.log(`   ❌ KHÔNG CÓ signedTx`);
    mismatched++;
    continue;
  }

  // Parse signed transaction
  let tx;
  try {
    tx = parseTransaction(w.signedTx);
  } catch (err) {
    console.log(`   ❌ Lỗi parse signedTx: ${err.message}`);
    mismatched++;
    continue;
  }

  txNonces.push(tx.nonce); // thu thập để cross-check sau

  console.log(`   ── Transaction ──`);
  console.log(`   chainId:           ${tx.chainId}`);
  console.log(`   nonce:             ${tx.nonce}`);
  console.log(`   to:                ${tx.to} ${tx.to?.toLowerCase() === bundle.morphoBlueAddress?.toLowerCase() ? "(Morpho Blue)" : "⚠️ KHÔNG PHẢI MORPHO"}`);
  console.log(`   value:             ${tx.value?.toString() || "0"} wei`);
  console.log(`   gas:               ${tx.gas?.toString() || "N/A"}`);
  console.log(`   maxFeePerGas:      ${tx.maxFeePerGas?.toString() || "N/A"} (${tx.maxFeePerGas ? formatUnits(tx.maxFeePerGas, 9) + " gwei" : "N/A"})`);
  console.log(`   maxPriorityFee:    ${tx.maxPriorityFeePerGas?.toString() || "N/A"} (${tx.maxPriorityFeePerGas ? formatUnits(tx.maxPriorityFeePerGas, 9) + " gwei" : "N/A"})`);
  console.log(`   type:              ${tx.type}`);

  // Decode calldata
  if (!tx.data || tx.data === "0x") {
    console.log(`   ❌ KHÔNG CÓ calldata`);
    mismatched++;
    continue;
  }

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: MORPHO_ABI, data: tx.data });
  } catch (err) {
    console.log(`   ❌ Lỗi decode calldata: ${err.message}`);
    mismatched++;
    continue;
  }

  if (decoded.functionName !== "withdraw") {
    console.log(`   ⚠️  Function: ${decoded.functionName} (không phải withdraw!)`);
    mismatched++;
    continue;
  }

  const args = decoded.args;
  const assets = args[1]; // assets là param thứ 2

  console.log(`   ── Morpho withdraw params ──`);
  console.log(`   loanToken:         ${args[0]?.loanToken || "N/A"}`);
  console.log(`   collateralToken:   ${args[0]?.collateralToken || "N/A"}`);
  console.log(`   oracle:            ${args[0]?.oracle || "N/A"}`);
  console.log(`   irm:               ${args[0]?.irm || "N/A"}`);
  console.log(`   lltv:              ${args[0]?.lltv?.toString() || "N/A"}`);
  console.log(`   assets:            ${assets?.toString() || "N/A"} (${assets ? formatUnits(assets, 6) + " USDC" : "N/A"})`);
  console.log(`   shares:            ${args[2]?.toString() || "N/A"} (0 = max withdraw)`);
  console.log(`   onBehalf:          ${args[3] || "N/A"}`);
  console.log(`   receiver:          ${args[4] || "N/A"}`);

  // Xác minh receiver = lender
  const receiver = args[4];
  if (bundle.lenderAddress) {
    if (receiver?.toLowerCase() !== bundle.lenderAddress.toLowerCase()) {
      console.log(`   ❌ RECEIVER SAI: receiver=${receiver}, lender=${bundle.lenderAddress}`);
      mismatched++;
    } else {
      console.log(`   ✅ Receiver khớp lender: ${receiver}`);
    }
  }

  // Compare
  if (assets && w.amountWei && BigInt(assets) === BigInt(w.amountWei)) {
    console.log(`   ✅ KHỚP: assets = amountWei = ${assets.toString()}`);
    matched++;
  } else {
    console.log(`   ❌ MISMATCH:`);
    console.log(`      amountWei (label): ${w.amountWei} (${w.amountFormatted})`);
    console.log(`      assets (signedTx): ${assets?.toString() || "N/A"} (${assets ? formatUnits(assets, 6) + " USDC" : "N/A"})`);
    mismatched++;
  }
}

// ============================================================
// Nonce cross-check (chỉ chạy khi tất cả tx parse thành công)
// ============================================================
// Chỉ cross-check khi tất cả withdrawal đều có signedTx parse thành công
if (txNonces.length === bundle.withdrawals.length) {
  const uniqueNonces = [...new Set(txNonces)];
  if (uniqueNonces.length > 1) {
    console.log("");
    console.log(`❌ CÁC TX CÓ NONCE KHÁC NHAU: ${uniqueNonces.join(", ")}`);
    mismatched++;
  } else if (bundle.nonce == null) {
    console.log("");
    console.log(`⚠️  Tất cả ${txNonces.length} tx có cùng nonce=${uniqueNonces[0]}, nhưng bundle không có nonce để so sánh`);
  } else if (uniqueNonces[0] !== Number(bundle.nonce)) {
    console.log("");
    console.log(`❌ NONCE KHÔNG KHỚP BUNDLE: tx nonce=${uniqueNonces[0]}, bundle nonce=${bundle.nonce}`);
    mismatched++;
  } else {
    console.log("");
    console.log(`✅ Tất cả ${txNonces.length} tx có cùng nonce=${uniqueNonces[0]}, khớp với bundle nonce=${bundle.nonce}`);
  }
}

console.log("");
console.log("╔══════════════════════════════════════════════════════════╗");
console.log(`║   Kết quả: ${matched} khớp, ${mismatched} mismatch / ${bundle.withdrawals.length} tiers`);
console.log("╚══════════════════════════════════════════════════════════╝");

if (mismatched > 0) {
  process.exit(1);
}
