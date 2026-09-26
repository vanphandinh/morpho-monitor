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

/** Format số token theo decimals/symbol của token. */
export function formatToken(amount, token) {
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
}
