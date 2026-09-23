/**
 * CLI verify presigned bundle / registry v2.
 *
 * H2 (audit 2026-09-23): trước đây script đọc file như một bare bundle. Chạy
 * trên `data/presigned.json` (`{ version: 2, bundles: { marketId: bundle } }`)
 * nó in "📄 Bundle rỗng" rồi exit 0 — sai lệch âm thầm. Nay:
 *   - registry v2 → verify từng market, có tổng hợp theo market, `--market <id>`
 *   - bare bundle → giữ nguyên hành vi cũ (back-compat)
 *   - exit 1 khi có mismatch/rỗng/không verify được
 *
 * Usage:
 *   node --env-file=.env verify-presigned.mjs [path] [--market <marketId>]
 *   (path mặc định: $PRESIGNED_FILE hoặc ./presigned.json)
 */
import fs from "node:fs";
import { formatUnits, parseTransaction, decodeFunctionData } from "viem";
import {
  verifyPresignedBundle,
  verifyWithdrawCalldata,
  computeMarketId,
  MORPHO_WITHDRAW_ABI,
} from "./presign-verify.mjs";

// Re-export for callers that import from CLI path
export { verifyPresignedBundle, verifyWithdrawCalldata, computeMarketId, MORPHO_WITHDRAW_ABI };

function shorten(addr) {
  if (!addr) return "N/A";
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

/** Parse `[path] [--market <id>]` (hỗ trợ cả `--market=<id>`). */
export function parseArgs(argv) {
  let market = null;
  let filePath = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--market") {
      market = argv[++i] ?? null;
    } else if (arg.startsWith("--market=")) {
      market = arg.slice("--market=".length);
    } else if (!arg.startsWith("--") && filePath === null) {
      filePath = arg;
    }
  }
  return { filePath, market };
}

/** Detect registry v2 vs bare bundle. */
export function isRegistryV2(parsed) {
  return Boolean(parsed && parsed.version === 2 && parsed.bundles && typeof parsed.bundles === "object" && !Array.isArray(parsed.bundles));
}

/**
 * Verify one bundle and print its tiers. Returns counts for the caller summary.
 * @returns {Promise<{matched: number, mismatched: number, empty: boolean}>}
 */
async function verifyBundle(bundle, { label, marketId, filePath }) {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Verify Presigned Bundle                              ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  File:      ${filePath}`);
  if (label) console.log(`  Market:    ${label}`);
  console.log(`  Status:    ${bundle.status}`);
  console.log(`  Nonce:     ${bundle.nonce}`);
  console.log(`  Created:   ${bundle.createdAt ?? "N/A"}`);
  console.log(`  Terminal:  ${bundle.terminalAt ?? "—"}`);
  console.log(`  Chain ID:  ${bundle.chainId}`);
  console.log(`  MarketId:  ${bundle.marketId ? shorten(bundle.marketId) : "N/A"}`);
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
      marketId: marketId ?? bundle.marketId,
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

  const bundleResult = await verifyPresignedBundle(bundle, marketId ? { marketId } : {});
  console.log("");
  console.log(`   Kết quả bundle: ${matched} khớp, ${mismatched} mismatch / ${bundle.withdrawals.length} tiers`);
  if (!bundleResult.ok) console.log(`   Bundle check: ${bundleResult.error}`);
  console.log("");

  return { matched, mismatched, empty: bundle.withdrawals.length === 0, bundleOk: bundleResult.ok };
}

async function main() {
  const { filePath: argPath, market } = parseArgs(process.argv.slice(2));
  const filePath = argPath || process.env.PRESIGNED_FILE || "./presigned.json";

  if (!fs.existsSync(filePath)) {
    console.error(`❌ File không tồn tại: ${filePath}`);
    return 1;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(`❌ Lỗi parse JSON: ${err.message}`);
    return 1;
  }

  const requestedMarket = market ? market.toLowerCase() : null;

  // ---- Registry v2 ----
  if (isRegistryV2(parsed)) {
    const ids = Object.keys(parsed.bundles);
    console.log(`📦 Registry v2: ${ids.length} bundle(s) — ${filePath}`);
    if (requestedMarket) console.log(`🔎 Chỉ kiểm tra market: ${requestedMarket}`);
    console.log("");

    const selected = requestedMarket ? ids.filter((id) => id.toLowerCase() === requestedMarket) : ids;
    if (selected.length === 0) {
      console.error(`❌ Không có bundle nào cho market ${requestedMarket} trong registry.`);
      return 1;
    }

    const summary = [];
    let failures = 0;
    for (const id of selected) {
      const bundle = parsed.bundles[id];
      const label = id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
      if (!bundle || !Array.isArray(bundle.withdrawals)) {
        console.error(`❌ ${label}: bundle không hợp lệ (thiếu withdrawals).`);
        summary.push({ market: label, status: bundle?.status ?? "?", tiers: 0, matched: 0, mismatched: 0, result: "INVALID" });
        failures++;
        continue;
      }
      if (bundle.withdrawals.length === 0) {
        console.log(`📄 ${label}: bundle rỗng (status=${bundle.status ?? "?"}) — không có gì để verify.`);
        summary.push({ market: label, status: bundle.status ?? "?", tiers: 0, matched: 0, mismatched: 0, result: "EMPTY" });
        failures++;
        continue;
      }
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`🔎 Market ${label}`);
      const counts = await verifyBundle(bundle, { marketId: id.toLowerCase(), filePath });
      const ok = counts.mismatched === 0 && counts.bundleOk;
      if (!ok) failures++;
      summary.push({
        market: label,
        status: bundle.status ?? "?",
        tiers: bundle.withdrawals.length,
        matched: counts.matched,
        mismatched: counts.mismatched + (counts.bundleOk ? 0 : 1),
        result: ok ? "OK" : "MISMATCH",
      });
    }

    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║   Tổng hợp theo market                                 ║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    for (const row of summary) {
      console.log(`  ${row.result.padEnd(9)} ${row.market}  status=${row.status} tiers=${row.tiers} matched=${row.matched} mismatch=${row.mismatched}`);
    }
    console.log("");
    if (failures > 0) {
      console.error(`❌ ${failures}/${selected.length} market(s) có vấn đề.`);
      return 1;
    }
    console.log(`✅ ${selected.length} market(s) hợp lệ.`);
    return 0;
  }

  // ---- Bare bundle (back-compat) ----
  if (!parsed || !Array.isArray(parsed.withdrawals) || parsed.withdrawals.length === 0) {
    console.log("📄 Bundle rỗng — không có withdrawal nào.");
    return 1;
  }

  const counts = await verifyBundle(parsed, { marketId: requestedMarket, filePath });
  if (counts.mismatched > 0 || !counts.bundleOk) {
    console.error(`❌ Bundle có ${counts.mismatched} mismatch.`);
    return 1;
  }
  console.log(`✅ Bundle hợp lệ (${counts.matched} tier).`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`❌ Lỗi verify: ${err.message}`);
    process.exit(1);
  });
