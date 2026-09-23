/**
 * Worker for the two-process race test. Runs standalone so the test spawns
 * two REAL Node processes importing the production modules.
 *
 * Usage: node two-process-worker.mjs <registryPath> <marketId> <signedTx>
 * Prints one JSON line: { sent: number, finalStatus: string, error?: string }
 */
import { broadcastEligible } from "../../presigned-broadcast.mjs";
import { updateRegistry } from "../../presigned-store.mjs";
import fs from "node:fs";

const [registryPath, marketId, signedTx] = process.argv.slice(2);
const snapshot = { market: { liquidity: 100n, totalSupplyAssets: 100n, totalSupplyShares: 100n }, position: { supplyAssets: 1000n } };

let sentCalls = 0;
const client = {
  getTransactionCount: async () => 7,
  sendRawTransaction: async () => { sentCalls++; return "hash"; },
  waitForTransactionReceipt: async () => ({ status: "success", blockHash: "0x" + "a".repeat(64), blockNumber: 1n, transactionHash: "0x" + "b".repeat(64) }),
};

try {
  await broadcastEligible({
    client,
    lenderAddress: "0x0000000000000000000000000000000000000000",
    filePath: registryPath,
    snapshots: new Map([[marketId, snapshot]]),
    updateRegistry,
    verifyBundle: async () => ({ ok: true }),
    isEligible: () => true,
  });
  // Re-read to report the terminal state observed by this process.
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const status = registry.bundles[marketId]?.status ?? "missing";
  console.log(JSON.stringify({ sent: sentCalls, finalStatus: status }));
} catch (err) {
  console.log(JSON.stringify({ sent: 0, finalStatus: "error", error: err.message }));
}
