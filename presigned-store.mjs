import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./shared.mjs";

export function emptyRegistry() {
  return { version: 2, bundles: {} };
}

export function readRegistry(filePath) {
  if (!fs.existsSync(filePath)) return emptyRegistry();
  const registry = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!registry || registry.version !== 2 || !registry.bundles || Array.isArray(registry.bundles)) {
    throw new Error("Presigned registry must use version 2 with a bundles object");
  }
  return registry;
}

export function writeRegistry(filePath, registry) {
  if (registry?.version !== 2 || !registry.bundles || Array.isArray(registry.bundles)) {
    throw new Error("Refusing to write invalid presigned registry");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

/** Serialize all mutations across webapp and monitor processes. */
export async function updateRegistry(filePath, mutate) {
  return withFileLock(`${filePath}.lock`, async () => {
    const registry = readRegistry(filePath);
    const result = await mutate(registry);
    writeRegistry(filePath, registry);
    return result;
  });
}

export function registrySummary(bundle) {
  if (!bundle) return { exists: false };
  return {
    exists: true,
    status: bundle.status || "pending",
    nonce: bundle.nonce,
    createdAt: bundle.createdAt,
    tiers: (bundle.withdrawals || []).map((w) => ({
      label: w.label,
      amountFormatted: w.amountFormatted,
      amountWei: w.amountWei,
      ...(w.type === "all-shares" ? { type: w.type, sharesWei: w.sharesWei } : {}),
    })),
  };
}
