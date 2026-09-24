/**
 * Shared fixtures: signed Morpho withdraw tx THẬT (ECDSA thật, chainId 1) để
 * test chạy production `verifyPresignedBundle` KHÔNG stub — mọi sai lệch contract
 * marketId/registry-key sẽ fail ngay tại đây (audit 2026-09-24, P0).
 */
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MORPHO_WITHDRAW_ABI, computeMarketId } from "../../presign-verify.mjs";

export const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
export const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const lenderAccount = () => privateKeyToAccount(TEST_KEY);

export const MARKET_PARAMS_A = {
  loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  oracle: "0x3333333333333333333333333333333333333333",
  irm: "0x4444444444444444444444444444444444444444",
  lltv: 860000000000000000n,
};

export const MARKET_PARAMS_B = {
  ...MARKET_PARAMS_A,
  irm: "0x5555555555555555555555555555555555555555",
};

// marketId THẬT = keccak256(abi.encode(marketParams)) — verify so sánh với đây.
export const MARKET_ID_A = computeMarketId(MARKET_PARAMS_A);
export const MARKET_ID_B = computeMarketId(MARKET_PARAMS_B);

/** Ký THẬT một tx Morpho withdraw (EIP-1559) bằng tài khoản test. */
export async function signedWithdraw({
  marketParams = MARKET_PARAMS_A,
  assets = 50_000_000_000n,
  shares = 0n,
  nonce = 7,
  account = lenderAccount(),
} = {}) {
  return account.signTransaction({
    to: MORPHO_BLUE,
    data: encodeFunctionData({
      abi: MORPHO_WITHDRAW_ABI,
      functionName: "withdraw",
      args: [marketParams, assets, shares, account.address, account.address],
    }),
    nonce: Number(nonce),
    chainId: 1,
    gas: 200_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    type: "eip1559",
    value: 0n,
  });
}

/**
 * Bundle pending đúng shape registry v3 (key composite sinh qua bundleKey).
 * `nonce` giữ NGUYÊN type truyền vào (test type-mẫn cảm của merge dùng "7").
 */
export async function pendingBundle({
  marketId = MARKET_ID_A,
  marketParams = MARKET_PARAMS_A,
  nonce = 7,
  tiers = [{ amountWei: "50000000000", label: "t1" }],
  account = lenderAccount(),
} = {}) {
  const withdrawals = [];
  for (const tier of tiers) {
    const isAllShares = tier.type === "all-shares";
    const amountWei = tier.amountWei ?? "0";
    const sharesWei = tier.sharesWei ?? "0";
    const signedTx = await signedWithdraw({
      marketParams,
      assets: isAllShares ? 0n : BigInt(amountWei),
      shares: isAllShares ? BigInt(sharesWei) : 0n,
      nonce,
      account,
    });
    withdrawals.push({
      label: tier.label ?? amountWei,
      amountWei,
      amountFormatted: tier.amountFormatted ?? amountWei,
      signedTx,
      ...(isAllShares ? { type: "all-shares", sharesWei } : {}),
    });
  }
  return {
    version: 2,
    createdAt: "2026-09-24T00:00:00.000Z",
    chainId: 1,
    morphoBlueAddress: MORPHO_BLUE,
    marketId,
    lenderAddress: account.address,
    nonce,
    gas: "200000",
    status: "pending",
    withdrawals,
  };
}
