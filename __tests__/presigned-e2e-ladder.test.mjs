/**
 * E2E drill (audit 2026-09-24): trọn flow production contract của presign
 * ladder v3 với verifyPresignedBundle THẬT và chữ ký THẬT (không stub):
 *   - registry key composite `marketId@nonce` (đúng như webapp ghi qua bundleKey)
 *   - snapshots key = marketId (đúng như market-reader trả về cho monitor)
 * → broadcaster phải claim/broadcast theo nonce tăng dần qua các chu kỳ;
 *   cùng-nonce race: market đứng trước theo thứ tự config thắng, sibling expired.
 * Test này FAIL trước Fix P0 (claim lookup trỏ registry.bundles[marketId]).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak256 } from "viem";
import { broadcastEligible } from "../presigned-broadcast.mjs";
import { updateRegistry, bundleKey } from "../presigned-store.mjs";
import { verifyPresignedBundle } from "../presign-verify.mjs";
import {
  MORPHO_BLUE,
  MARKET_ID_A,
  MARKET_ID_B,
  MARKET_PARAMS_A,
  MARKET_PARAMS_B,
  lenderAccount,
  pendingBundle,
} from "./helpers/signed-withdraw.mjs";

const account = lenderAccount();
const snap = () => ({
  market: { liquidity: 1_000_000_000_000n, totalSupplyAssets: 1_000_000_000_000n, totalSupplyShares: 1_000_000_000_000n },
});
const silent = { log: () => {}, warn: () => {}, error: () => {} };

// verifyBundle đúng contract của monitor.mjs — marketId là identity từ VALUE.
const verifyBundle = (bundle, marketId) =>
  verifyPresignedBundle(bundle, { morphoBlueAddress: MORPHO_BLUE, lenderAddress: account.address, marketId });

function tempRegistryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presign-e2e-"));
  return path.join(dir, "presigned.json");
}

function fakeClient(nonce) {
  const sends = [];
  return {
    sends,
    getTransactionCount: async () => nonce,
    sendRawTransaction: async ({ serializedTransaction }) => {
      sends.push(serializedTransaction);
      return "0xok";
    },
    waitForTransactionReceipt: async () => ({
      status: "success",
      blockHash: "0x" + "a".repeat(64),
      blockNumber: 1n,
      transactionHash: "0x" + "b".repeat(64),
    }),
  };
}

describe("presign ladder v3 — E2E production contract (verify + chữ ký thật)", () => {
  it("claim theo nonce tăng dần A@7 → A@8; B@8 đua cùng nonce bị expire khi nonce bị tiêu thụ", async () => {
    const filePath = tempRegistryPath();
    const keyA7 = bundleKey(MARKET_ID_A, 7);
    const keyA8 = bundleKey(MARKET_ID_A, 8);
    const keyB8 = bundleKey(MARKET_ID_B, 8);
    const bundleA7 = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 7,
      tiers: [{ amountWei: "50000000000", label: "50" }, { amountWei: "100000000000", label: "100" }],
    });
    const bundleA8 = await pendingBundle({
      marketId: MARKET_ID_A, marketParams: MARKET_PARAMS_A, nonce: 8,
      tiers: [{ amountWei: "30000000000", label: "30" }],
    });
    const bundleB8 = await pendingBundle({
      marketId: MARKET_ID_B, marketParams: MARKET_PARAMS_B, nonce: 8,
      tiers: [{ amountWei: "20000000000", label: "20" }],
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 3, bundles: { [keyA7]: bundleA7, [keyA8]: bundleA8, [keyB8]: bundleB8 } }));

    // Production contract: snapshots key theo MARKET ID.
    const snapshots = new Map([[MARKET_ID_A, snap()], [MARKET_ID_B, snap()]]);

    // ---- Chu kỳ 1 — on-chain pending = 7: chỉ A@7 claimable (tier 100 lớn nhất còn <= liquidity).
    const c1 = fakeClient(7);
    const claim1 = await broadcastEligible({
      client: c1, lenderAddress: account.address, filePath, snapshots,
      updateRegistry, verifyBundle, isEligible: () => true, logger: silent,
    });
    expect(claim1.id).toBe(keyA7); // registry key (opaque)
    expect(claim1.marketId).toBe(MARKET_ID_A); // marketId từ VALUE
    expect(claim1.bundle.txHash).toBe(keccak256(bundleA7.withdrawals[1].signedTx));
    expect(c1.sends).toEqual([bundleA7.withdrawals[1].signedTx]);
    let stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles[keyA7].status).toBe("submitted");
    expect(stored.bundles[keyA7].rawTx).toBeUndefined();
    expect(stored.bundles[keyA8].status).toBe("pending");
    expect(stored.bundles[keyB8].status).toBe("pending");

    // ---- Chu kỳ 2 — pending = 8: A@8 đứng trước B@8 theo thứ tự config → A@8 claim.
    const c2 = fakeClient(8);
    const claim2 = await broadcastEligible({
      client: c2, lenderAddress: account.address, filePath, snapshots,
      updateRegistry, verifyBundle, isEligible: () => true, logger: silent,
    });
    expect(claim2.id).toBe(keyA8);
    expect(c2.sends).toEqual([bundleA8.withdrawals[0].signedTx]);
    stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.bundles[keyA8].status).toBe("submitted");
    // Receipt mined tiêu thụ nonce 8 → sibling cùng nonce B@8 expired ngay.
    expect(stored.bundles[keyB8].status).toBe("expired");
  });

  it("P0 part 2: verify thật từ chối composite key làm marketId, chấp nhận marketId từ VALUE", async () => {
    const key = bundleKey(MARKET_ID_A, 7);
    const bundle = await pendingBundle({ marketId: MARKET_ID_A, nonce: 7 });

    // Contract SAI (id = registry key) — đây là lỗi trước Fix P0.
    const wrong = await verifyPresignedBundle(bundle, {
      morphoBlueAddress: MORPHO_BLUE, lenderAddress: account.address, marketId: key,
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain("bundle.marketId !== config market");

    // Contract ĐÚNG (marketId từ VALUE) — broadcaster sau Fix dùng contract này.
    const right = await verifyBundle(bundle, MARKET_ID_A);
    expect(right.ok).toBe(true);
  });
});
