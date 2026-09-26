import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./file-lock.mjs";

/**
 * Registry v3 (multi-nonce presign ladder, 2026-09-24):
 * bundles được khóa phức hợp `marketId@nonce` thay vì chỉ marketId, nên MỌI
 * market có thể giữ bundle ở NHIỀU nonce liên tiếp cùng lúc (ký trước, chờ
 * on-chain nonce đi qua). Mỗi bundle mang field `marketId` (authoritative khi
 * key bị mâu thuẫn). Broadcast vẫn chỉ claim bundle ở nonce == on-chain
 * pending; bundle nonce thấp hơn pending/đã tiêu thụ → expired.
 */
export const REGISTRY_VERSION = 3;

/**
 * Trạng thái terminal: nonce của record đã bị tiêu thụ VĨNH VIỄN (kể cả sau khi
 * rawTx bị xoá). Đây là nguồn sự thật duy nhất — vừa cho lifecycle broadcast,
 * vừa cho watermark `consumedNonce` bên dưới.
 */
export const TERMINAL_STATUSES = new Set(["submitted", "failed", "superseded"]);

export function emptyRegistry() {
  return { version: REGISTRY_VERSION, bundles: {}, consumedNonce: -1 };
}

/** Composite registry key: `marketId@nonce` (marketId lowercase). */
export function bundleKey(marketId, nonce) {
  return `${String(marketId).toLowerCase()}@${Number(nonce)}`;
}

/** Split a composite key; plain legacy keys → marketId = key, nonce = NaN. */
export function parseBundleKey(key) {
  const idx = String(key).lastIndexOf("@");
  if (idx <= 0) return { marketId: String(key), nonce: NaN };
  return { marketId: String(key).slice(0, idx), nonce: Number(String(key).slice(idx + 1)) };
}

/** Nonce terminal cao nhất còn thấy trong record — có thể MẤT khi user xoá record. */
function maxTerminalNonce(bundles) {
  let max = -1;
  for (const bundle of Object.values(bundles ?? {})) {
    if (!TERMINAL_STATUSES.has(bundle?.status)) continue;
    const value = Number(bundle.nonce);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

/**
 * Sàn "nonce đã tiêu thụ" của registry (audit A.2). Vì nonce là đơn điệu theo
 * tài khoản, MỌI nonce ≤ sàn chắc chắn đã bị tiêu thụ ⇒ bất kỳ chữ ký nào ở
 * nonce đó vĩnh viễn không thể mine, dù nó còn nằm trong registry hay không.
 *
 * Sàn = MAX của hai nguồn:
 *  - field `consumedNonce` (đơn điệu — `updateRegistry` không cho nó lùi);
 *  - record terminal còn trên đĩa, để registry cũ / file bị process bản cũ ghi
 *    đè vẫn được bảo vệ mà không cần migrate tay.
 *
 * Vì sao phải có field: trước đây ký ức này CHỈ tồn tại dưới dạng record, mà
 * `PROTECTED_STATUSES` cố ý cho user xoá record terminal/expired (dọn lịch sử).
 * Xoá record là mất mốc ⇒ một rung `pending` ở nonce đã tiêu thụ có thể được
 * claim lại, gửi lại chữ ký đã chết, rồi fail `nonce too low` và thành claim
 * kẹt ~180s — đúng lớp triệu chứng R1.
 */
export function consumedWatermark(registry) {
  const field = Number(registry?.consumedNonce);
  return Math.max(Number.isFinite(field) ? field : -1, maxTerminalNonce(registry?.bundles));
}

/**
 * Coerce an on-disk registry to v3 shape. v2 (one bundle per marketId) is
 * migrated in-memory: bundles KEEP their original keys (opaque identifiers —
 * nothing parses them for identity) and gain a `marketId` field. New saves
 * via the webapp API write composite keys `marketId@nonce`. Identity of a
 * bundle is (bundle.marketId ?? key, bundle.nonce) — always read from VALUES,
 * never from the key. Anything else fails closed (v1 or garbage must never
 * be silently accepted).
 */
function migrateRegistry(parsed) {
  if (parsed && (parsed.version === REGISTRY_VERSION || parsed.version === 2) && parsed.bundles && typeof parsed.bundles === "object" && !Array.isArray(parsed.bundles)) {
    const bundles = {};
    for (const [key, bundle] of Object.entries(parsed.bundles)) {
      if (!bundle || typeof bundle !== "object") continue;
      bundles[key] = bundle.marketId != null ? bundle : { ...bundle, marketId: String(parseBundleKey(key).marketId).toLowerCase() };
    }
    // `consumedNonce` là additive: KHÔNG bump version (một process bản cũ đang
    // chạy phải đọc được file này trong lúc rolling deploy). Thiếu field ⇒ suy
    // ra từ record terminal, và lần write kế tiếp sẽ ghi lại mốc đã chuẩn hoá.
    const registry = { version: REGISTRY_VERSION, bundles };
    registry.consumedNonce = consumedWatermark({ consumedNonce: parsed.consumedNonce, bundles });
    return registry;
  }
  throw new Error("Presigned registry must use version 3 (or legacy version 2) with a bundles object");
}

export function readRegistry(filePath) {
  if (!fs.existsSync(filePath)) return emptyRegistry();
  const registry = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return migrateRegistry(registry);
}

/**
 * Mã lỗi khi `rename()` đè lên file đích đang được tiến trình KHÁC mở/đọc. Trên Windows, share mode
 * của `fs.readFileSync` KHÔNG cho phép rename/delete ⇒ `renameSync(tmp, file)` ném `EPERM` (hoặc
 * `EBUSY`/`EACCES` tuỳ thứ đang giữ file) trong khi reader chỉ sống vài ms. Trên POSIX điều này không
 * tồn tại (rename không quan tâm ai đang mở file).
 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
/**
 * Ngân sách thử lại CỐ Ý nhỏ (5 × 20ms = ≤100ms): `writeRegistry` chạy BÊN TRONG lock file, mà lock
 * chỉ kiên nhẫn 50 × 20ms (~1s) — thử lại quá lâu sẽ biến một rename lỗi tạm thời thành
 * `LOCK_STALE` cho tiến trình khác. Cửa sổ thật cần che chỉ là vài ms (`readRegistry` mở, đọc, đóng).
 */
const RENAME_ATTEMPTS = 5;
const RENAME_DELAY_MS = 20;

/** Ngủ ĐỒNG BỘ (writeRegistry là hàm sync) mà không bận CPU. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `rename` có thử lại cho lỗi TẠM THỜI của Windows; lỗi khác ném ngay (không che lỗi thật). */
function renameWithTransientRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(err.code)) throw err;
      sleepSync(RENAME_DELAY_MS);
    }
  }
}

export function writeRegistry(filePath, registry) {
  if (registry?.version !== REGISTRY_VERSION || !registry.bundles || Array.isArray(registry.bundles)) {
    throw new Error("Refusing to write invalid presigned registry");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  try {
    renameWithTransientRetry(tmp, filePath);
  } catch (err) {
    // Không để lại rác `.tmp` phía sau một lần ghi thất bại (lần ghi sau sẽ ghi lại từ đầu).
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

/**
 * Statuses that represent an active nonce claim no user request may touch.
 *
 * ONLY an unmined `broadcasting` record is untouchable. Terminal records
 * (`submitted`/`failed`) are history: their nonce is already consumed and
 * their rawTx deleted, so the user must be able to delete or replace them
 * (otherwise the registry grows forever with no retention policy — M1).
 *
 * Audit A.2: việc xoá record giờ KHÔNG còn làm mất ký ức "nonce đã tiêu thụ" —
 * mốc đó nằm ở field `consumedNonce` đơn điệu (xem consumedWatermark).
 */
const PROTECTED_STATUSES = new Set(["broadcasting"]);
export const ACTIVE_CLAIM_CONFLICT = "ACTIVE_CLAIM_CONFLICT";

/** Snapshot the identity of every active claim for post-mutation comparison. */
function activeClaimSignature(registry) {
  const claims = [];
  for (const [id, bundle] of Object.entries(registry.bundles)) {
    if (!PROTECTED_STATUSES.has(bundle.status)) continue;
    claims.push({
      id,
      status: bundle.status,
      nonce: bundle.nonce,
      txHash: bundle.txHash ?? null,
      broadcastingTier: bundle.broadcastingTier ?? null,
      // Any tier add/remove/edit on an active bundle is a conflict.
      withdrawalsDigest: JSON.stringify(bundle.withdrawals ?? null),
    });
  }
  // Deterministic order so signatures compare structurally.
  claims.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return claims;
}

function sameClaims(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id !== y.id || x.status !== y.status || x.nonce !== y.nonce) return false;
    if ((x.txHash ?? null) !== (y.txHash ?? null)) return false;
    if ((x.broadcastingTier ?? null) !== (y.broadcastingTier ?? null)) return false;
    if (x.withdrawalsDigest !== y.withdrawalsDigest) return false;
  }
  return true;
}

/**
 * Serialize all mutations across webapp and monitor processes.
 *
 * opts.origin — "user" (webapp HTTP API) or "monitor" (default). A user-origin
 * mutation is rejected when it would delete or alter any active claim
 * (broadcasting/submitted bundle, its nonce, tier or tx identity). The error
 * carries code ACTIVE_CLAIM_CONFLICT so HTTP layers can answer 409. The
 * monitor's own terminal transitions use the default origin and are unaffected.
 */
export async function updateRegistry(filePath, mutate, opts = {}) {
  const origin = opts.origin === "user" ? "user" : "monitor";
  // Thư mục chứa registry phải tồn tại TRƯỚC khi lấy lock: `withFileLock` dùng
  // openSync(lockPath, "wx") nên thư mục cha thiếu ⇒ ENOENT ngay ở request đầu
  // tiên trên host chưa có `data/` (Docker che bằng named volume + `RUN mkdir`,
  // local dev thì không). `writeRegistry` đã tự mkdir, nhưng nó chạy SAU lock —
  // quá muộn. Test ghim: __tests__/presigned-store-init.test.mjs.
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return withFileLock(`${filePath}.lock`, async () => {
    const registry = readRegistry(filePath);
    // A.2 — sàn bất biến, lấy TRƯỚC khi mutate: mọi nonce ≤ sàn đã tiêu thụ và
    // không mutation nào (kể cả xoá record của user) được phép hạ nó xuống.
    const consumedFloor = consumedWatermark(registry);
    if (origin === "user") {
      const before = activeClaimSignature(registry);
      try {
        const result = await mutate(registry);
        if (!sameClaims(before, activeClaimSignature(registry))) {
          const err = new Error("Conflict: the presigned transaction is actively claimed (broadcasting) and cannot be modified from the web interface");
          err.code = ACTIVE_CLAIM_CONFLICT;
          throw err;
        }
        // Tự TIẾN khi mutation đánh dấu terminal, tự CHẶN LÙI khi xoá record:
        // một dòng này đủ cho cả hai, vì `consumedFloor` lấy từ trạng thái trước
        // khi mutate.
        registry.consumedNonce = Math.max(consumedFloor, consumedWatermark(registry));
        writeRegistry(filePath, registry);
        return result;
      } catch (err) {
        // Signature mismatch muộn hơn (mutate đã đổi registry rồi mới throw):
        // ưu tiên giữ code ACTIVE_CLAIM_CONFLICT; lỗi khác giữ nguyên.
        if (err?.code === ACTIVE_CLAIM_CONFLICT) throw err;
        if (!sameClaims(before, activeClaimSignature(registry))) {
          err.code = ACTIVE_CLAIM_CONFLICT;
          throw err;
        }
        throw err;
      }
    }
    const result = await mutate(registry);
    registry.consumedNonce = Math.max(consumedFloor, consumedWatermark(registry));
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
    // Terminal retention/display timestamp (null while not terminal).
    terminalAt: bundle.terminalAt ?? null,
    // Age of an unmined claim + the R1 release reason. The webapp renders the
    // age so a claim that can never mine is visible instead of silently
    // blocking the ladder.
    broadcastingAt: bundle.broadcastingAt ?? null,
    reason: bundle.reason ?? null,
    tiers: (bundle.withdrawals || []).map((w) => ({
      label: w.label,
      amountFormatted: w.amountFormatted,
      amountWei: w.amountWei,
      ...(w.type === "all-shares" ? { type: w.type, sharesWei: w.sharesWei } : {}),
    })),
  };
}

/** Every bundle of one market, ascending nonce. Identity comes from bundle VALUES (marketId field, nonce); the key is opaque. */
export function marketBundles(registryOrBundles, marketId) {
  const bundles = registryOrBundles?.bundles ?? registryOrBundles ?? {};
  const id = String(marketId).toLowerCase();
  return Object.entries(bundles)
    .map(([key, bundle]) => ({
      key,
      bundle,
      // Identity từ VALUE (fallback parse key) — callers như broadcaster cần
      // marketId để verify, KHÔNG được dùng registry key (composite) thay thế.
      marketId: String(bundle?.marketId ?? parseBundleKey(key).marketId).toLowerCase(),
    }))
    .filter((entry) => entry.marketId === id)
    .sort((a, b) => Number(a.bundle?.nonce) - Number(b.bundle?.nonce));
}

/**
 * Group bundles by nonce ascending. Each round: { nonce, entries: [{ key,
 * marketId, bundle }] } — the webapp overview renders one row per round and
 * the broadcaster resolves same-nonce races by trigger order.
 */
export function nonceRounds(registryOrBundles) {
  const bundles = registryOrBundles?.bundles ?? registryOrBundles ?? {};
  const rounds = new Map();
  for (const [key, bundle] of Object.entries(bundles)) {
    const marketId = String(bundle?.marketId ?? parseBundleKey(key).marketId).toLowerCase();
    const n = Number(bundle?.nonce);
    if (!Number.isFinite(n)) continue;
    if (!rounds.has(n)) rounds.set(n, []);
    rounds.get(n).push({ key, marketId, bundle });
  }
  return [...rounds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([nonce, entries]) => ({ nonce, entries }));
}
