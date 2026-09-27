/**
 * Lớp dùng chung: banner DOM, URL proxy, phiên đăng nhập, UI tài khoản (audit P5).
 *
 * Nằm DƯỚI mọi module luồng (overview/presign/withdraw đều import nó) nên không tạo vòng.
 * Đây là chỗ duy nhất biết vẽ banner lỗi/kết quả và nói chuyện với sessionStorage.
 */

import { getCompatibilityMessage } from "./webapp-wallet.mjs";
import { SERVER_PROXY_RPC_URL, RPC_VERIFIED_AT, RPC_REFRESH_HOURS, state } from "./webapp-state.mjs";

// Auth state
let sessionToken = sessionStorage.getItem("morpho-session-token") || null;

let sessionExpiresAt = sessionStorage.getItem("morpho-session-expires") || null;

// ============================================================
// BANNER (lỗi / kết quả) — dùng chung cho cả 3 tab
// ============================================================
export function showError(msg) {
  const el = document.getElementById("error-banner");
  el.textContent = "❌ " + msg;
  el.style.display = "block";
}

export function hideError() {
  document.getElementById("error-banner").style.display = "none";
}

export function showTxResult(type, msg) {
  const el = document.getElementById("tx-result");
  el.style.display = "block";
  el.innerHTML = `<div class="banner ${type}">${msg}</div>`;
}

// ============================================================
// AUTH HELPERS (wallet signature)
// ============================================================
export function isAuthenticated() {
  if (!sessionToken || !sessionExpiresAt) return false;
  if (Date.now() > parseInt(sessionExpiresAt, 10)) {
    clearSession();
    return false;
  }
  return true;
}

export function getAuthHeaders() {
  if (!sessionToken) return {};
  return { "Authorization": "Bearer " + sessionToken };
}

export function saveSession(token, expiresAt) {
  sessionToken = token;
  sessionExpiresAt = new Date(expiresAt).getTime().toString();
  sessionStorage.setItem("morpho-session-token", token);
  sessionStorage.setItem("morpho-session-expires", sessionExpiresAt);
}

export function clearSession() {
  sessionToken = null;
  sessionExpiresAt = null;
  sessionStorage.removeItem("morpho-session-token");
  sessionStorage.removeItem("morpho-session-expires");
  updateAuthUI();
}

export function updateAuthUI() {
  const authed = isAuthenticated();
  // Sign-in button
  const btnSignIn = document.getElementById("btn-sign-in");
  if (btnSignIn) {
    if (authed) {
      btnSignIn.textContent = "✅ Đã Xác Thực";
      btnSignIn.disabled = true;
      btnSignIn.className = "btn-outline";
    } else if (state.currentAccount && state.currentAccount.toLowerCase() === state.lenderAddress?.toLowerCase()) {
      btnSignIn.textContent = "🔏 Xác Thực Bằng Ví";
      btnSignIn.disabled = false;
      btnSignIn.className = "btn-primary";
    } else if (state.currentAccount) {
      btnSignIn.textContent = "⚠️ Ví Không Khớp Với Lender";
      btnSignIn.disabled = true;
      btnSignIn.className = "btn-outline";
    } else {
      btnSignIn.textContent = "🔏 Xác Thực Bằng Ví";
      btnSignIn.disabled = true;
      btnSignIn.className = "btn-outline";
    }
  }
  // Sign-out button
  const btnSignOut = document.getElementById("btn-sign-out");
  if (btnSignOut) {
    btnSignOut.style.display = authed ? "" : "none";
  }
}

export function getProxyUrl() {
  return SERVER_PROXY_RPC_URL;
}

// ============================================================
// RPC VERIFIED NOTE (lớp hybrid, 2026-09-27)
// ============================================================
// Server probe định kỳ danh sách RPC cho browser (public-rpc-health.mjs) và
// inject timestamp "lần kiểm chứng gần nhất" vào config. Hiển thị 1 dòng nhỏ;
// không có timestamp (lớp động tắt / fallback tĩnh) ⇒ ẩn dòng đó, KHÔNG lỗi.
export function renderRpcVerifiedNote() {
  const wrap = document.getElementById("rpc-verified-note");
  if (!wrap) return;
  const textEl = document.getElementById("rpc-verified-text");
  if (!RPC_VERIFIED_AT) {
    wrap.style.display = "none";
    return;
  }
  const when = new Date(RPC_VERIFIED_AT);
  const whenText = Number.isFinite(when.getTime())
    ? when.toLocaleString("vi-VN", { hour12: false })
    : RPC_VERIFIED_AT;
  if (textEl) textEl.textContent = `🩺 Danh sách RPC cho trình duyệt đã được server kiểm chứng lúc ${whenText} (tự cập nhật ${RPC_REFRESH_HOURS > 0 ? "mỗi " + RPC_REFRESH_HOURS + " giờ" : "theo chu kỳ"}).`;
  wrap.style.display = "block";
}

// ============================================================
// PRESIGN: WALLET COMPATIBILITY
// ============================================================
export function renderWalletCompatibility() {
  const banner = document.getElementById("presign-wallet-banner");
  const compat = getCompatibilityMessage();
  banner.style.display = "block";
  banner.innerHTML = compat.msg;
  banner.className = "banner info";
}

// ============================================================
// PRESIGN: UI HELPERS
// ============================================================
export function showPresignError(msg) {
  const el = document.getElementById("presign-result");
  el.style.display = "block";
  el.innerHTML = `<div class="banner error">❌ ${msg}</div>`;
}

export function showPresignSuccess(msg) {
  const el = document.getElementById("presign-result");
  el.style.display = "block";
  el.innerHTML = `<div class="banner success">${msg}</div>`;
}
