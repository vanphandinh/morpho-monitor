/**
 * Đọc/xoá bundle đã ký sẵn + các thẻ market/position của tab ký sẵn (audit P5).
 *
 * NỬA DƯỚI của tính năng presign: đọc/xoá bundle trên server nhưng KHÔNG ký. Nửa trên
 * (nonce/gas/mốc/ký/lưu) ở `webapp-presign.mjs` và import module này — chiều ngược lại
 * không tồn tại nên không có vòng import.
 */

import { broadcastingAgeMinutes, isClaimOverdue, shortenAddr, wadToPercent } from "./webapp-logic.mjs";
import { esc, formatToken, row } from "./webapp-render.mjs";
import { CLAIM_RECOVERY_MS, state } from "./webapp-state.mjs";
import { clearSession, getAuthHeaders, isAuthenticated, showPresignError, showPresignSuccess, updateAuthUI } from "./webapp-shell.mjs";

// ============================================================
// PRESIGN OVERVIEW (mọi market)
// ============================================================
export async function refreshPresignOverview() {
  const section = document.getElementById("presign-overview");
  const info = document.getElementById("presign-overview-info");
  if (!section || !info) return;
  if (!isAuthenticated()) { section.style.display = "none"; return; }
  section.style.display = "block";
  try {
    const resp = await fetch("/api/overview", { headers: { ...getAuthHeaders() } });
    if (resp.status === 401) { section.style.display = "none"; return; }
    if (!resp.ok) { info.textContent = "Không tải được tổng quan presign."; return; }
    const data = await resp.json();
    if (!data.ok) { info.textContent = "Không tải được tổng quan presign."; return; }
    renderPresignOverview(data.markets || [], data.rounds || []);
  } catch { info.textContent = "Lỗi mạng khi tải tổng quan presign."; }
}

function renderPresignOverview(markets, rounds) {
  const info = document.getElementById("presign-overview-info");
  const short = (id) => `${String(id).slice(0, 10)}…${String(id).slice(-4)}`;
  const badge = (s) => {
    const cls = s === "broadcasting" ? "banner error" : s === "pending" ? "banner info" : s === "submitted" ? "banner success" : "banner warn";
    return `<span class="${cls}" style="padding:1px 8px">${esc(s)}</span>`;
  };
  // Ladder view: mỗi market một hàng, các rung nonce tăng dần.
  const body = (markets || []).map((m) => {
    const rungs = (m.ladder || []).map((r) => `${badge(r.status)} @${r.nonce} (${(r.tiers || []).length}t)`).join(" ") || "—";
    return `<tr><td><code>${short(m.id)}</code></td><td>${rungs}</td></tr>`;
  }).join("");
  // Rounds: các bundle hoạt động (pending/broadcasting) cùng nonce = race —
  // market nào trigger trước được broadcast, còn lại expired khi nonce tiêu thụ.
  const activeRounds = (rounds || []).filter((rd) =>
    rd.markets.some((e) => e.status === "pending" || e.status === "broadcasting"));
  const raceRounds = activeRounds.filter((rd) => rd.markets.filter((e) => e.status === "pending" || e.status === "broadcasting").length > 1);
  const raceBanner = raceRounds.length
    ? `<div class="banner error" style="margin-top:8px">⚠️ Nonce ${raceRounds.map((rd) => rd.nonce).join(", ")} đang được dùng bởi nhiều market cùng lúc — market nào <b>trigger trước</b> được broadcast, các bundle còn lại sẽ <b>expired</b> ngay khi nonce đó được tiêu thụ.</div>`
    : "";
  const ladderNote = activeRounds.length > 1
    ? `<div class="banner info" style="margin-top:8px">ℹ️ Bậc thang nonce: ${activeRounds.map((rd) => rd.nonce).join(" → ")}. Broadcast luôn theo nonce tăng dần — rung nonce thấp hơn phải mine (hoặc hết hạn) trước, rung cao hơn mới có cơ hội.</div>`
    : "";
  info.innerHTML =
    `<table style="width:100%;border-collapse:collapse;font-size:0.9rem"><tr style="text-align:left;color:var(--text-dim,#888)"><th>Market</th><th>Bundle ladder (trạng thái @nonce (số tier))</th></tr>${body}</table>` +
    raceBanner + ladderNote;
}

export function renderPresignMarketInfo() {
  const liquidity = state.marketData.liquidity;
  const liquidityClass = liquidity > 0n ? "green" : "red";
  document.getElementById("presign-market-info").innerHTML = [
    row("Collateral", `${shortenAddr(state.marketParams.collateralToken)} (${state.collateralToken.symbol})`),
    row("Loan Token", `${shortenAddr(state.marketParams.loanToken)} (${state.loanToken.symbol})`),
    row("Liquidity", `<span class="value ${liquidityClass}">${formatToken(liquidity, state.loanToken)}</span>`),
    row("Utilization", wadToPercent(state.marketData.utilization)),
    row("Total Supply", formatToken(state.marketData.totalSupplyAssets, state.loanToken)),
  ].join("");
  document.getElementById("presign-market-section").style.display = "block";
}

export function renderPresignPosition() {
  const supplyAssets = state.marketData.supplyAssets;
  document.getElementById("presign-position-info").innerHTML = [
    row("Supply Assets", formatToken(supplyAssets, state.loanToken)),
    row("Supply Shares", state.positionData.supplyShares.toString()),
  ].join("");
  document.getElementById("presign-position-section").style.display = "block";
}

export function renderPresignWithdrawAllInfo() {
  const sharesEl = document.getElementById("presign-supply-shares");
  const assetsEl = document.getElementById("presign-supply-assets");
  if (sharesEl && state.positionData.supplyShares != null) {
    sharesEl.textContent = state.positionData.supplyShares.toString();
  }
  if (assetsEl && state.marketData.supplyAssets != null) {
    assetsEl.textContent = formatToken(state.marketData.supplyAssets, state.loanToken);
  }
}

// ============================================================
// PRESIGN: FETCH EXISTING BUNDLE
// ============================================================
export async function fetchExistingBundle() {
  if (!isAuthenticated()) {
    document.getElementById("presign-existing").style.display = "none";
    return;
  }
  try {
    const resp = await fetch(`/api/presign?market=${encodeURIComponent(state.marketId)}`, {
      headers: { ...getAuthHeaders() },
    });
    if (resp.status === 401) {
      clearSession();
      updateAuthUI();
      document.getElementById("presign-existing").style.display = "none";
      return;
    }
    if (!resp.ok) return;
    const data = await resp.json();
    const ladder = Array.isArray(data.ladder) ? data.ladder : (data.exists ? [data] : []);
    if (!data.ok || ladder.length === 0) {
      document.getElementById("presign-existing").style.display = "none";
      return;
    }

    const section = document.getElementById("presign-existing");
    section.style.display = "block";

    // Multi-nonce ladder: mỗi rung là một bundle `marketId@nonce` riêng.
    // Rung head = nonce thấp nhất của market này (rùng kế tiếp được broadcast).
    const head = ladder[0];

    const rungHtml = (r, isHead) => {
      const badge = r.status === "pending"
        ? '<span style="color:var(--green)">' + esc(r.status) + '</span>'
        : r.status === "broadcasting"
          ? '<span style="color:var(--yellow)">' + esc(r.status) + '</span>'
          : r.status === "submitted"
            ? '<span style="color:var(--green)">' + esc(r.status) + '</span>'
            : r.status === "superseded"
              ? '<span style="color:var(--red)" title="Nonce đã bị một giao dịch khác tiêu thụ — chữ ký này không thể lên bảng">bị thay thế</span>'
              : '<span style="color:var(--text-dim)">' + esc(r.status) + '</span>';
      // Tuổi claim: claim không mine được sẽ chặn cả bậc thang (audit R1).
      const overdue = isClaimOverdue(r, Date.now(), CLAIM_RECOVERY_MS);
      const ageMinutes = r.status === "broadcasting" ? broadcastingAgeMinutes(r.broadcastingAt) : null;
      const ageLabel = ageMinutes === null
        ? ""
        : ` <span style="font-size:0.8rem;color:${overdue ? "var(--red)" : "var(--text-dim)"}">(đang broadcast ${ageMinutes} phút${overdue ? " — QUÁ HẠN" : ""})</span>`;
      // R2: xoá được TỪNG tier của rung. Không có đường này thì tier tiền cũ
      // (merge cố ý giữ tier ở các đợt ký trước) vẫn broadcastable mà chỉ có
      // thể xoá bằng cách xoá cả market rồi ký lại hết.
      // Rung đang broadcasting bị API từ chối (409) nên không hiện nút.
      const rungEditable = r.status !== "broadcasting" && Number.isFinite(Number(r.nonce));
      const tierList = (r.tiers || []).map((t, tierIdx) => {
        const label = t.type === "all-shares"
          ? `🔄 Rút toàn bộ shares (${t.sharesWei || "?"} shares)`
          : (t.label || t.amountFormatted);
        const display = t.type === "all-shares" ? "Toàn bộ shares" : t.amountFormatted;
        const remove = rungEditable
          ? `<button class="btn-outline btn-remove" title="Xóa tier này khỏi rung nonce ${esc(r.nonce)}" onclick="deleteTierFromBundle(${Number(r.nonce)}, ${tierIdx})">✕</button>`
          : `<span title="Rung đang được broadcast — không sửa được" style="color:var(--text-dim)">🔒</span>`;
        return `<div class="row"><span class="label">${esc(label)}</span><span class="value">${esc(display)}</span>${remove}</div>`;
      }).join("") || '<p style="color:var(--text-dim);font-size:0.85rem">Không có tier nào</p>';
      return `<div style="margin:6px 0;padding:6px 8px;border:1px solid var(--border);border-radius:6px">` +
        `<div class="row"><span class="label">Nonce:</span><span class="value nonce-display">${r.nonce ?? "—"}</span>` +
        `<span class="label" style="margin-left:12px">Trạng thái:</span>${badge}` +
        (isHead ? ' <span style="color:var(--text-dim);font-size:0.8rem">(nonce kế tiếp sẽ broadcast)</span>' : "") +
        ageLabel +
        `</div>${tierList}</div>`;
    };

    const ladderHtml = ladder.map((r, i) => rungHtml(r, i === 0)).join("");

    document.getElementById("presign-existing-info").innerHTML = [
      `<div class="row"><span class="label">Bundle trên server (nonce tăng dần):</span></div>`,
      ladderHtml,
    ].join("");

    if (head.status === "pending") {
      document.getElementById("presign-existing-info").innerHTML +=
        `<div class="banner warn" style="margin-top:8px">⚠️ Bundle head đang pending (nonce ${head.nonce}). Ký thêm tier cùng nonce sẽ merge vào rung này; lấy nonce mới sẽ thêm rung mới vào bậc thang.</div>`;
    }
    if (ladder.some((r) => r.status === "expired")) {
      document.getElementById("presign-existing-info").innerHTML +=
        `<div class="banner warn" style="margin-top:8px">♻️ Có bundle đã <b>expired</b>: on-chain nonce đã đi qua nonce của bundle đó (bị market khác/tự nhận tiêu thụ) — bundle cũ không thể broadcast nữa. Ký lại với nonce mới nếu vẫn muốn rút.</div>`;
    }
    if (ladder.some((r) => r.status === "superseded")) {
      document.getElementById("presign-existing-info").innerHTML +=
        `<div class="banner warn" style="margin-top:8px">♻️ Có bundle <b>superseded</b>: nonce của nó đã bị một giao dịch KHÁC tiêu thụ, nên on-chain nonce đã đi qua và chữ ký cũ không thể lên bảng. Lấy nonce mới rồi ký lại nếu vẫn muốn rút; bản ghi này chỉ là lịch sử (xoá được).</div>`;
    }
    const overdueRungs = ladder.filter((r) => isClaimOverdue(r, Date.now(), CLAIM_RECOVERY_MS));
    if (overdueRungs.length > 0) {
      document.getElementById("presign-existing-info").innerHTML +=
        `<div class="banner error" style="margin-top:8px">⚠️ Bundle nonce ${overdueRungs.map((r) => r.nonce).join(", ")} đang <b>broadcasting quá ${Math.round(CLAIM_RECOVERY_MS / 60000)} phút</b> — có thể giao dịch đã bị ví thay thế hoặc kẹt (fee thấp). Kiểm tra nonce trên Etherscan: nếu nonce đó đã bị tx khác dùng, monitor sẽ tự nhả sang <b>superseded</b> rồi rung kế tiếp được broadcast; nếu chưa, đối soát txHash trước khi sửa registry.</div>`;
    }
    if (ladder.some((r) => r.status === "submitted" || r.status === "failed" || r.status === "superseded")) {
      document.getElementById("presign-existing-info").innerHTML +=
        `<div class="banner info" style="margin-top:8px">📜 Có record terminal (<b>submitted/failed/superseded</b>) — chỉ là lịch sử, có thể xóa để registry gọn.</div>`;
    }
    document.getElementById("presign-existing-info").innerHTML +=
      `<button class="btn-danger" onclick="deleteBundle()" style="margin-top:8px">🗑️ Xóa Mọi Bundle Của Market Này</button>`;
  } catch {
    // Server không reachable hoặc lỗi — bỏ qua
    document.getElementById("presign-existing").style.display = "none";
  }
}

export async function deleteTierFromBundle(nonce, index) {
  if (!confirm(`Xóa tier #${index + 1} khỏi rung nonce ${nonce}?`)) return;

  try {
    // Bắt buộc kèm nonce: API từ chối (400) khi market có nhiều rung mà thiếu
    // nonce — nếu không, nó sửa rung nonce thấp nhất, có thể khác rung đang xem (F3/R2).
    const resp = await fetch(`/api/presign?market=${encodeURIComponent(state.marketId)}&nonce=${encodeURIComponent(nonce)}&tier=${index}`, {
      method: "DELETE",
      headers: { ...getAuthHeaders() },
    });
    if (resp.status === 401) {
      clearSession();
      updateAuthUI();
      showPresignError("Phiên đăng nhập hết hạn. Vui lòng xác thực lại.");
      return;
    }
    const result = await resp.json();
    if (resp.status === 409) {
      showPresignError("Rung này đang được broadcast (claim đang mở) nên không sửa được. Chờ receipt rồi thử lại.");
      return;
    }
    if (result.ok) {
      showPresignSuccess(
        `✅ Đã xóa tier "${result.removed}" khỏi rung nonce ${nonce} (còn ${result.remaining} tier).` +
        (result.remaining === 0 ? "<br><small>Rung này giờ không còn tier nào — nên xoá rung để bậc thang gọn.</small>" : "")
      );
      fetchExistingBundle(); // Refresh display
      refreshPresignOverview();
    } else {
      showPresignError("Lỗi xóa tier: " + (result.error || "Unknown"));
    }
  } catch (err) {
    showPresignError("Không thể kết nối server: " + err.message);
  }
};

export async function deleteBundle() {
  if (!confirm("Bạn có chắc muốn xóa toàn bộ bundle đã ký trên server?\n\nHành động này không thể hoàn tác.")) return;

  try {
    const resp = await fetch(`/api/presign?market=${encodeURIComponent(state.marketId)}`, {
      method: "DELETE",
      headers: { ...getAuthHeaders() },
    });
    if (resp.status === 401) {
      clearSession();
      updateAuthUI();
      showPresignError("Phiên đăng nhập hết hạn. Vui lòng xác thực lại.");
      return;
    }
    const result = await resp.json();
    if (result.ok) {
      showPresignSuccess(`✅ Đã xóa ${result.deleted} bundles.`);
      document.getElementById("presign-existing").style.display = "none";
      refreshPresignOverview();
    } else {
      showPresignError("Lỗi xóa bundle: " + (result.error || "Unknown"));
    }
  } catch (err) {
    showPresignError("Không thể kết nối server: " + err.message);
  }
};
