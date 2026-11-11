/**
 * Helper render/DOM thuần của webapp (audit P2.7).
 *
 * File này chạy **nguyên văn** trong browser: `webapp-app.mjs` import
 * `./webapp-render.mjs` và `webapp-handler.mjs` phục vụ nó ở cùng gốc (route map).
 * Các hàm chỉ nhận tham số và trả chuỗi — không chạm state của app — nên tách
 * được mà không cần một state container.
 */
import { formatUnits } from "viem";

/** Escape HTML cho nội dung động (token symbol, địa chỉ...). */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Một hàng label/value trong card. */
export function row(label, value) {
  return `<div class="row"><span class="label">${label}</span><span class="value">${value}</span></div>`;
}

/**
 * Chèn dấu phẩy phân cách hàng nghìn vào PHẦN NGUYÊN của một chuỗi số thập phân.
 * "2450000.5" → "2,450,000.5"; "0.000001" giữ nguyên.
 * Bản cục bộ có chủ ý: browser không import được `shared.mjs` (file đó đọc process.env),
 * nên phép format này phải khớp `shared.formatTokenAmount` (test parity giữ hai bản đồng bộ).
 */
function groupThousands(value) {
  const text = String(value);
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dot === -1 ? "" : text.slice(dot));
}

/** Format số token theo decimals/symbol của token (phần nguyên có dấu phẩy hàng nghìn). */
export function formatToken(amount, token) {
  return `${groupThousands(formatUnits(amount, token.decimals))} ${token.symbol}`;
}
