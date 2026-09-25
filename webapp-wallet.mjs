/**
 * Nhận diện ví EIP-1193 + thông báo tương thích (audit P2.7).
 *
 * Đây là phần tự chứa nhất của webapp-app.mjs: chỉ đọc cờ provider trên
 * `window.ethereum`, không chạm state của app. Tách ra để UI và test dùng chung
 * một bản (chạy nguyên văn trong browser, phục vụ qua route map của handler).
 */

/** Tên ví theo cờ EIP-1193; null nếu chưa có provider. */
export function getWalletProviderName() {
  const e = window.ethereum;
  if (!e) return null;
  if (e.isRabby) return "rabby";
  if (e.isAmbire) return "ambire";
  if (e.isFrame) return "frame";
  if (e.isCoinbaseWallet) return "coinbase";
  if (e.isMetaMask) return "metamask";
  if (e.isTrust) return "trust";
  return "unknown";
}

/**
 * Thông báo tương thích ví (brand-only). `ok: true` cho MỌI ví — cổng preflight
 * H5 đã bị gỡ theo quyết định user 2026-09-24 (xem CLAUDE.md).
 */
export function getCompatibilityMessage() {
  const wallet = getWalletProviderName();
  switch (wallet) {
    case "rabby": return { ok: true, msg: "✅ Rabby được phát hiện. Sẵn sàng ký giao dịch qua proxy RPC." };
    case "metamask": return { ok: true, msg: "✅ MetaMask được phát hiện. Sẵn sàng ký giao dịch qua proxy RPC." };
    case "ambire": return { ok: true, msg: "✅ Ambire được phát hiện. Sẵn sàng ký giao dịch qua proxy RPC." };
    case "frame": return { ok: true, msg: "✅ Frame được phát hiện. Sẵn sàng ký giao dịch qua proxy RPC." };
    case "coinbase": return { ok: true, msg: "✅ Coinbase Wallet được phát hiện. Sẵn sàng ký giao dịch qua proxy RPC." };
    case "trust": return { ok: true, msg: "✅ Trust Wallet được phát hiện. Sẵn sàng ký giao dịch qua proxy RPC." };
    default: return { ok: true, msg: "✅ Ví đã kết nối. Sẵn sàng ký giao dịch qua proxy RPC." };
  }
}
