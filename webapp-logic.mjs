/**
 * Logic thuần của webapp — dùng chung giữa browser và test (audit A.1b).
 *
 * File này chạy **nguyên văn** trong trình duyệt: `webapp-app.mjs` (module được
 * phục vụ tại `/webapp-app.mjs`) import `./webapp-logic.mjs`, và handler phục vụ
 * nó ở cùng gốc. Nhờ vậy không còn bản sao "mirror" trong test: test import đúng
 * đoạn code đang chạy thật, nên không thể xanh trong khi UI đã khác.
 *
 * Hai bất biến của file (được ghim bằng test + scripts/check-syntax.mjs):
 *   1. KHÔNG chạm tới DOM: không đọc/ghi bất cứ thứ gì của trang (biến toàn cục,
 *      bộ nhớ trình duyệt) — nếu chạm, nó không còn import được trong Node và
 *      lại phải nhân bản trong test. Test ghim bất biến này bằng cách quét chính
 *      file bạn đang đọc (xem __tests__/webapp.test.mjs).
 *   2. KHÔNG giữ state: mọi hàm là hàm thuần (tham số vào ⇒ giá trị ra), trừ
 *      `txVisibleOnChain` chỉ nhận client qua tham số.
 *
 * Ngân sách xác minh tx của tab "Rút Tiền" (audit R4): 4 lần × 3s — đủ để tx vừa
 * gửi lan truyền tới RPC công khai, mà người dùng vẫn không phải chờ lâu.
 */
export const TX_VERIFY_ATTEMPTS = 4;
export const TX_VERIFY_DELAY_MS = 3000;

/**
 * Ngưỡng recovery mặc định của presigned-broadcast.mjs. Server inject giá trị
 * thật qua `MORPHO_CONFIG.claimRecoveryMs` (server inject); đây chỉ là fallback khi thiếu
 * config nên phải khớp hằng số trong presigned-broadcast.mjs.
 */
export const CLAIM_RECOVERY_MS_FALLBACK = 180_000;

/**
 * Format một giá trị WAD (1e18) thành chuỗi phần trăm.
 */
export function wadToPercent(wad) {
  return (Number(wad) / 1e16).toFixed(2) + "%";
}

/**
 * Rút gọn địa chỉ Ethereum để hiển thị.
 *
 * Có guard cho giá trị rỗng: hàm này được gọi cho marketParams/oracle/irm và
 * lender — một field thiếu (config sai, decode lỗi) trước đây sẽ ném ngay giữa
 * `renderMarketInfo()` và làm chết cả phần render market, thay vì chỉ hiện "N/A".
 */
export function shortenAddr(addr) {
  if (!addr) return "N/A";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Số phút một claim đang broadcasting (null nếu thiếu/không hợp lệ mốc thời
 * gian). Server trả `broadcastingAt` trong ladder (audit R1): claim không mine
 * được sẽ chặn CẢ bậc thang, nên tuổi claim phải nhìn thấy được trong UI.
 */
export function broadcastingAgeMinutes(broadcastingAt, nowMs = Date.now()) {
  const started = Date.parse(broadcastingAt ?? "");
  if (!Number.isFinite(started)) return null;
  return Math.floor(Math.max(0, nowMs - started) / 60000);
}

/**
 * Claim đang broadcasting đã quá ngưỡng recovery (presigned-broadcast.mjs,
 * server inject qua `MORPHO_CONFIG.claimRecoveryMs`): có thể đã bị một tx khác
 * thay thế hoặc kẹt vì fee thấp.
 */
export function isClaimOverdue(r, nowMs = Date.now(), recoveryMs = CLAIM_RECOVERY_MS_FALLBACK) {
  if (!r || r.status !== "broadcasting") return false;
  const started = Date.parse(r.broadcastingAt ?? "");
  return Number.isFinite(started) && nowMs - started > recoveryMs;
}

/**
 * R4: giao dịch mà ví trả về hash có thật sự nằm trên chain?
 *
 * Tab "Rút Tiền" gửi tx qua `walletClient.writeContract` → RPC do VÍ cấu hình
 * quyết định đường đi. Nếu ví đang trỏ vào proxy (port 8545), tx chỉ bị CAPTURE
 * chứ không broadcast, nhưng UI vẫn báo thành công cho một giao dịch chưa từng
 * lên chain. Ta không đọc được RPC của ví, nhưng kiểm tra được điều ngược lại:
 * hash có xuất hiện trên RPC công khai (CFG.rpcUrls) hay không.
 *
 * Chỉ dùng để CẢNH BÁO: `false` cũng là kết quả đúng khi tx chưa lan truyền kịp,
 * nên tuyệt đối không chặn UI và không kết luận tx thất bại (H5 preflight đã bị
 * gỡ vì lý do tương tự — không có cách chắc chắn để hỏi ví).
 */
export async function txVisibleOnChain(client, hash, {
  attempts = TX_VERIFY_ATTEMPTS,
  delayMs = TX_VERIFY_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (await client.getTransaction({ hash })) return true;
    } catch {
      // Chưa thấy, hoặc RPC lỗi tạm thời → thử lại.
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/**
 * assets = shares * totalSupplyAssets / totalSupplyShares (chia nguyên, như Solidity).
 * totalSupplyShares = 0 ⇒ pool chưa có gì ⇒ 0.
 */
export function computeSupplyAssets(shares, totalSupplyAssets, totalSupplyShares) {
  if (totalSupplyShares === 0n) return 0n;
  return (shares * totalSupplyAssets) / totalSupplyShares;
}

/**
 * assets = shares * totalBorrowAssets / totalBorrowShares (chia nguyên).
 */
export function computeBorrowAssets(shares, totalBorrowAssets, totalBorrowShares) {
  if (totalBorrowShares === 0n) return 0n;
  return (shares * totalBorrowAssets) / totalBorrowShares;
}

/**
 * Thanh khoản khả dụng của market (không âm).
 */
export function computeLiquidity(totalSupplyAssets, totalBorrowAssets) {
  const liquidity = totalSupplyAssets - totalBorrowAssets;
  return liquidity < 0n ? 0n : liquidity;
}

/**
 * Utilization dạng WAD (1e18 = 100%).
 */
export function computeUtilization(totalBorrowAssets, totalSupplyAssets) {
  if (totalSupplyAssets === 0n) return 0n;
  return (totalBorrowAssets * BigInt(1e18)) / totalSupplyAssets;
}

/**
 * Số rút tối đa = min(số dư có thể rút, thanh khoản của market).
 */
export function computeMaxWithdraw(supplyAssets, liquidity) {
  return supplyAssets < liquidity ? supplyAssets : liquidity;
}

/**
 * Kiểm tra số lượng rút ở client trước khi gửi giao dịch on-chain.
 *
 * Trả `reason` (không trả câu chữ) để nơi gọi tự render thông báo kèm số tiền đã
 * format — cùng một phép kiểm tra vừa chặn sớm lỗi rõ ràng, vừa không trùng lặp
 * phần hiển thị.
 *
 * reason: "zero" | "over_balance" | "over_liquidity" | null
 */
export function validateWithdraw({ assets, supplyAssets, liquidity }) {
  if (assets === 0n) return { valid: false, reason: "zero" };
  if (assets > supplyAssets) return { valid: false, reason: "over_balance" };
  if (assets > liquidity) return { valid: false, reason: "over_liquidity" };
  return { valid: true, reason: null };
}
