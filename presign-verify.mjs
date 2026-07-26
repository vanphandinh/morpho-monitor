/**
 * Shared Morpho withdraw calldata verification for presigned bundles.
 * Used by proxy (pre-save), webapp-server (POST /api/presign), and monitor (pre-broadcast).
 */
import {
  parseTransaction,
  decodeFunctionData,
  keccak256,
  encodeAbiParameters,
  recoverTransactionAddress,
} from "viem";

export const MORPHO_WITHDRAW_ABI = [{
  type: "function",
  name: "withdraw",
  inputs: [
    {
      name: "marketParams",
      type: "tuple",
      internalType: "MarketParams",
      components: [
        { name: "loanToken", type: "address" },
        { name: "collateralToken", type: "address" },
        { name: "oracle", type: "address" },
        { name: "irm", type: "address" },
        { name: "lltv", type: "uint256" },
      ],
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

const MARKET_PARAMS_TYPES = [
  { type: "address" },
  { type: "address" },
  { type: "address" },
  { type: "address" },
  { type: "uint256" },
];

/** Compute Morpho Blue market Id from MarketParams (abi.encode + keccak256). */
export function computeMarketId(marketParams) {
  const p = marketParams;
  return keccak256(
    encodeAbiParameters(MARKET_PARAMS_TYPES, [
      p.loanToken,
      p.collateralToken,
      p.oracle,
      p.irm,
      p.lltv,
    ])
  );
}

/**
 * Decode + verify one signed Morpho withdraw tx against expected labels/config.
 * Fail-closed: any mismatch returns { ok: false, error }.
 * Also recovers ECDSA sender and requires from === lenderAddress.
 *
 * @param {string} signedTx - raw signed tx hex
 * @param {object} expected
 * @param {string} expected.morphoBlueAddress
 * @param {string} expected.lenderAddress
 * @param {string} expected.marketId
 * @param {string|number|bigint|null} [expected.nonce]
 * @param {string} [expected.amountWei] - for fixed-amount tiers
 * @param {string} [expected.sharesWei] - for all-shares tiers
 * @param {boolean} [expected.isAllShares]
 * @param {boolean} [expected.skipAmountChecks] - capture-time: only to/fn/onBehalf/receiver/market/from
 * @returns {Promise<{ ok: true, decoded: object } | { ok: false, error: string }>}
 */
export async function verifyWithdrawCalldata(signedTx, expected) {
  if (!signedTx || typeof signedTx !== "string") {
    return { ok: false, error: "missing signedTx" };
  }

  let tx;
  try {
    tx = parseTransaction(signedTx);
  } catch (err) {
    return { ok: false, error: `parse signedTx: ${err.message}` };
  }

  const morpho = expected.morphoBlueAddress?.toLowerCase();
  if (!morpho || tx.to?.toLowerCase() !== morpho) {
    return {
      ok: false,
      error: `tx.to ${tx.to} !== Morpho Blue ${expected.morphoBlueAddress}`,
    };
  }

  if (tx.chainId != null && Number(tx.chainId) !== 1) {
    return { ok: false, error: `chainId ${tx.chainId} !== 1` };
  }

  if (expected.nonce != null && expected.nonce !== "" && Number(tx.nonce) !== Number(expected.nonce)) {
    return {
      ok: false,
      error: `tx nonce ${tx.nonce} !== bundle nonce ${expected.nonce}`,
    };
  }

  if (!tx.data || tx.data === "0x") {
    return { ok: false, error: "missing calldata" };
  }

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: MORPHO_WITHDRAW_ABI, data: tx.data });
  } catch (err) {
    return { ok: false, error: `decode calldata: ${err.message}` };
  }

  if (decoded.functionName !== "withdraw") {
    return { ok: false, error: `function ${decoded.functionName} !== withdraw` };
  }

  const [marketParams, assets, shares, onBehalf, receiver] = decoded.args;
  const lender = expected.lenderAddress?.toLowerCase();
  if (!lender) {
    return { ok: false, error: "missing expected lenderAddress" };
  }
  if (onBehalf?.toLowerCase() !== lender) {
    return { ok: false, error: `onBehalf ${onBehalf} !== lender ${expected.lenderAddress}` };
  }
  if (receiver?.toLowerCase() !== lender) {
    return { ok: false, error: `receiver ${receiver} !== lender ${expected.lenderAddress}` };
  }

  let from;
  try {
    from = await recoverTransactionAddress({ serializedTransaction: signedTx });
  } catch (err) {
    return { ok: false, error: `recover sender: ${err.message}` };
  }
  if (from.toLowerCase() !== lender) {
    return {
      ok: false,
      error: `sender ${from} !== lender ${expected.lenderAddress}`,
    };
  }

  if (expected.marketId) {
    const computedId = computeMarketId(marketParams);
    if (computedId.toLowerCase() !== expected.marketId.toLowerCase()) {
      return {
        ok: false,
        error: `marketId ${computedId} !== expected ${expected.marketId}`,
      };
    }
  }

  if (!expected.skipAmountChecks) {
    const isAllShares = expected.isAllShares || expected.type === "all-shares";
    if (isAllShares) {
      if (expected.sharesWei == null || expected.sharesWei === "") {
        return { ok: false, error: "all-shares missing sharesWei label" };
      }
      if (BigInt(shares) !== BigInt(expected.sharesWei)) {
        return {
          ok: false,
          error: `shares ${shares} !== sharesWei ${expected.sharesWei}`,
        };
      }
      // assets should be 0 for shares-based withdraw
      if (assets != null && BigInt(assets) !== 0n) {
        return { ok: false, error: `all-shares assets should be 0, got ${assets}` };
      }
    } else {
      if (expected.amountWei == null || expected.amountWei === "") {
        return { ok: false, error: "missing amountWei label" };
      }
      if (BigInt(assets) !== BigInt(expected.amountWei)) {
        return {
          ok: false,
          error: `assets ${assets} !== amountWei ${expected.amountWei}`,
        };
      }
      // fixed-amount: shares must be 0
      if (shares != null && BigInt(shares) !== 0n) {
        return { ok: false, error: `fixed-amount shares should be 0, got ${shares}` };
      }
    }
  }

  return {
    ok: true,
    decoded: {
      marketParams,
      assets,
      shares,
      onBehalf,
      receiver,
      nonce: tx.nonce,
      to: tx.to,
      from,
    },
  };
}

/**
 * Gate eth_sendRawTransaction capture: sender must be lender + Morpho withdraw shape.
 * Does not require amountWei/sharesWei labels (unknown until /bundle metadata).
 * Reuses verifyWithdrawCalldata (single ECDSA recover).
 *
 * @returns {Promise<{ ok: true, from: string, decoded: object } | { ok: false, error: string }>}
 */
export async function assertCaptureTx(signedTx, expected) {
  const shape = await verifyWithdrawCalldata(signedTx, {
    ...expected,
    skipAmountChecks: true,
  });
  if (!shape.ok) return shape;
  return { ok: true, from: shape.decoded.from, decoded: shape.decoded };
}

/**
 * Verify every withdrawal in a bundle against config + per-tier labels.
 * @returns {Promise<{ ok: true } | { ok: false, error: string, index?: number }>}
 */
export async function verifyPresignedBundle(bundle, config = {}) {
  if (!bundle || typeof bundle !== "object") {
    return { ok: false, error: "bundle must be an object" };
  }
  if (!Array.isArray(bundle.withdrawals) || bundle.withdrawals.length === 0) {
    return { ok: false, error: "withdrawals empty" };
  }

  const morphoBlueAddress = config.morphoBlueAddress || bundle.morphoBlueAddress;
  const lenderAddress = config.lenderAddress || bundle.lenderAddress;
  const marketId = config.marketId || bundle.marketId;

  if (!morphoBlueAddress) return { ok: false, error: "missing morphoBlueAddress" };
  if (!lenderAddress) return { ok: false, error: "missing lenderAddress" };
  if (!marketId) return { ok: false, error: "missing marketId" };

  if (config.lenderAddress && bundle.lenderAddress &&
      config.lenderAddress.toLowerCase() !== bundle.lenderAddress.toLowerCase()) {
    return { ok: false, error: "bundle.lenderAddress !== config lender" };
  }
  if (config.marketId && bundle.marketId &&
      config.marketId.toLowerCase() !== bundle.marketId.toLowerCase()) {
    return { ok: false, error: "bundle.marketId !== config market" };
  }
  if (config.morphoBlueAddress && bundle.morphoBlueAddress &&
      config.morphoBlueAddress.toLowerCase() !== bundle.morphoBlueAddress.toLowerCase()) {
    return { ok: false, error: "bundle.morphoBlueAddress !== config Morpho" };
  }

  const txNonces = [];
  for (let i = 0; i < bundle.withdrawals.length; i++) {
    const w = bundle.withdrawals[i];
    const result = await verifyWithdrawCalldata(w.signedTx, {
      morphoBlueAddress,
      lenderAddress,
      marketId,
      nonce: bundle.nonce,
      amountWei: w.amountWei,
      sharesWei: w.sharesWei,
      isAllShares: w.type === "all-shares",
    });
    if (!result.ok) {
      return { ok: false, error: `withdrawals[${i}]: ${result.error}`, index: i };
    }
    txNonces.push(result.decoded.nonce);
  }

  const unique = [...new Set(txNonces.map(Number))];
  if (unique.length > 1) {
    return { ok: false, error: `inconsistent tx nonces: ${unique.join(", ")}` };
  }

  return { ok: true };
}

/**
 * Match tier metadata to captured txs by txHash (case-insensitive).
 * Fail closed on any unmatched tier (no partial bundles).
 */
export function matchTiersToCaptured(tiers, capturedTxs) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { ok: false, error: "tiers empty" };
  }
  if (!Array.isArray(capturedTxs) || capturedTxs.length === 0) {
    return { ok: false, error: "No captured transactions" };
  }

  const txMap = new Map(
    capturedTxs.map((tx) => [tx.hash?.toLowerCase(), tx.signedTx])
  );
  const matchedHashes = [];
  const withdrawals = [];

  for (const tier of tiers) {
    const key = tier.txHash?.toLowerCase();
    const signedTx = key ? txMap.get(key) : null;
    if (!signedTx) {
      return {
        ok: false,
        error: "Tier txHash không match captured txs (partial match rejected)",
        unmatched: tier.txHash || null,
      };
    }
    matchedHashes.push(tier.txHash);
    const entry = {
      label: tier.label,
      amountWei: tier.amountWei,
      amountFormatted: tier.amountFormatted,
      signedTx,
    };
    if (tier.type === "all-shares") {
      entry.type = "all-shares";
      entry.sharesWei = tier.sharesWei;
    }
    withdrawals.push(entry);
  }

  if (withdrawals.length !== tiers.length) {
    return { ok: false, error: "Partial tier match rejected" };
  }

  return { ok: true, withdrawals, matchedHashes };
}

/**
 * Always use configured WEBAPP_URL — never trust client meta.serverUrl (SSRF).
 */
export function resolveBundleServerUrl(_meta, webappUrl) {
  return (webappUrl || "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Remove only matched hashes from captured buffer (keep unmatched).
 */
export function clearMatchedCaptured(capturedTxs, matchedHashes) {
  const matchedSet = new Set(matchedHashes.map((h) => h?.toLowerCase()));
  for (let i = capturedTxs.length - 1; i >= 0; i--) {
    if (matchedSet.has(capturedTxs[i].hash?.toLowerCase())) {
      capturedTxs.splice(i, 1);
    }
  }
  return capturedTxs;
}
