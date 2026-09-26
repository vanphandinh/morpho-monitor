/**
 * Tab "Ký sẵn": nonce, gas, mốc rút, ký và lưu bundle (audit P5).
 *
 * NỬA TRÊN của tính năng presign (nửa dưới: `webapp-presign-bundles.mjs`). Đây là module
 * duy nhất gọi `signTransaction` — tức chỗ duy nhất chạm khoá ký; phần còn lại chỉ đọc
 * bundle đã ký.
 */

import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { mainnet } from "viem/chains";
import { stepNonce } from "./webapp-logic.mjs";
import { MORPHO_ABI, MORPHO_BLUE, state } from "./webapp-state.mjs";
import { clearSession, getAuthHeaders, getProxyUrl, isAuthenticated, showPresignError, showPresignSuccess, updateAuthUI } from "./webapp-shell.mjs";
import { fetchExistingBundle, refreshPresignOverview, renderPresignWithdrawAllInfo } from "./webapp-presign-bundles.mjs";

let presignedGas = { maxFeePerGas: null, maxPriorityFeePerGas: null };

let isSigningInProgress = false;

export function updatePresignWalletUI() {
  const statusEl = document.getElementById("presign-wallet-status");
  const connectedEl = document.getElementById("presign-wallet-connected");
  if (state.currentAccount) {
    statusEl.style.display = "none";
    connectedEl.style.display = "block";
    document.getElementById("presign-wallet-address").textContent = state.currentAccount;
    document.getElementById("btn-fetch-nonce").disabled = false;
    document.getElementById("btn-auto-gas").disabled = false;
    if (state.presignedTiers.length > 0 && state.presignedNonce !== null && presignedGas.maxFeePerGas) {
      document.getElementById("btn-sign-all").disabled = false;
    }
    updateAuthUI();
    // Show rút toàn bộ shares section
    const withdrawAllSec = document.getElementById("presign-withdraw-all-section");
    if (withdrawAllSec) withdrawAllSec.style.display = "block";
    renderPresignWithdrawAllInfo();
  } else {
    statusEl.style.display = "block";
    connectedEl.style.display = "none";
    document.getElementById("btn-sign-all").disabled = true;
    const withdrawAllSec = document.getElementById("presign-withdraw-all-section");
    if (withdrawAllSec) withdrawAllSec.style.display = "none";
  }
}

/**
 * Nonce hoặc gas đổi ⇒ MỌI chữ ký đã ký ở giá trị cũ vô nghĩa: reset các tier
 * đã ký về pending, tắt nút lưu và báo người dùng ký lại. (audit P2.8: gộp 3
 * bản sao ở fetchNonce / onNonceStep / onGasInputChange.)
 * @returns {boolean} true nếu có chữ ký bị vô hiệu
 */
function invalidateSignatures(message) {
  let invalidated = false;
  for (const tier of state.presignedTiers) {
    if (tier.status === "signed") {
      tier.status = "pending";
      tier.txHash = null;
      tier.amountWei = null;
      invalidated = true;
    }
  }
  if (state.presignedWithdrawAll && state.presignedWithdrawAll.status === "signed") {
    state.presignedWithdrawAll.status = "pending";
    state.presignedWithdrawAll.txHash = null;
    invalidated = true;
  }
  if (invalidated) {
    document.getElementById("btn-save-server").disabled = true;
    showPresignError(message);
    renderTierList();
  }
  return invalidated;
}

/** Còn chữ ký nào dùng lại được không (tier hoặc rút-toàn-bộ đang `signed`)? */
function hasLiveSignatures() {
  return state.presignedTiers.some((tier) => tier.status === "signed") ||
    state.presignedWithdrawAll?.status === "signed";
}

export async function fetchNonce() {
  if (!state.currentAccount) {
    showPresignError("Vui lòng kết nối ví trước.");
    return;
  }
  try {
    document.getElementById("btn-fetch-nonce").disabled = true;
    document.getElementById("btn-fetch-nonce").textContent = "⏳ Đang lấy...";
    const prevNonce = state.presignedNonce;
    state.presignedNonce = await state.publicClient.getTransactionCount({
      address: state.currentAccount,
      blockTag: "pending",
    });
    document.getElementById("presign-nonce").textContent = state.presignedNonce;
    document.getElementById("btn-fetch-nonce").textContent = "✅ Đã lấy Nonce";
    // Stepper: có sàn rồi ⇒ cho chỉnh nonce bằng ± (không bao giờ xuống
    // dưới sàn — xem stepNonce trong webapp-logic.mjs).
    state.onChainPendingNonce = state.presignedNonce;
    setNonceStepperEnabled(true);
    // Nonce mới → chữ ký cũ (cùng nonce cũ) không còn hợp lệ
    if (prevNonce !== null && prevNonce !== state.presignedNonce) {
      invalidateSignatures("Nonce đã thay đổi. Vui lòng ký lại các giao dịch.");
    }
    updateSignButton();
  } catch (err) {
    showPresignError("Lỗi lấy nonce: " + err.message);
    document.getElementById("btn-fetch-nonce").disabled = false;
    document.getElementById("btn-fetch-nonce").textContent = "🔢 Lấy Nonce";
  }
};

// ============================================================
// PRESIGN: NONCE STEPPER (2026-09-25)
// Nút ± thay cho nhập tay. Sàn = nonce on-chain; [−] khoá khi đang đứng
// đúng sàn (stepNonce kẹp sàn độc lập với UI — 2 lớp). Đổi nonce sau khi
// đã ký ⇒ chữ ký cũ vô nghĩa, invalidate đúng cơ chế của fetchNonce.
// ============================================================
export function setNonceStepperEnabled(enabled) {
  document.getElementById("btn-nonce-dec").disabled = !enabled;
  document.getElementById("btn-nonce-inc").disabled = !enabled;
  updateNonceStepperButtons();
}

function updateNonceStepperButtons() {
  if (state.onChainPendingNonce === null || state.presignedNonce === null) return;
  document.getElementById("btn-nonce-dec").disabled = state.presignedNonce <= state.onChainPendingNonce;
}

export function onNonceStep(delta) {
  const next = stepNonce(state.presignedNonce, state.onChainPendingNonce, delta);
  if (next === null || next === state.presignedNonce) return;
  state.presignedNonce = next;
  document.getElementById("presign-nonce").textContent = state.presignedNonce;
  // Nonce mới → chữ ký cũ (ký ở nonce cũ) không còn hợp lệ.
  invalidateSignatures("Nonce đã thay đổi. Vui lòng ký lại các giao dịch.");
  updateNonceStepperButtons();
  updateSignButton();
};

export async function autoFillGas() {
  try {
    document.getElementById("btn-auto-gas").disabled = true;
    document.getElementById("btn-auto-gas").textContent = "⏳ Đang lấy...";
    const [priorityFee, block] = await Promise.all([
      state.publicClient.estimateMaxPriorityFeePerGas(),
      state.publicClient.getBlock({ blockTag: "latest" }),
    ]);
    const baseFee = block.baseFeePerGas ?? 10_000_000_000n;
    // 2x multiplier để đảm bảo inclusion sau này
    const nextPriority = priorityFee * 2n;
    const nextMaxFee = (baseFee * 2n) + nextPriority;
    // So TRƯỚC khi gán — cùng nguyên tắc với `gasValuesChanged()` ở onGasInputChange.
    //
    // Audit 2026-09-26 (D14): đây từng là đường DUY NHẤT ghi `presignedGas` mà không đi qua
    // cổng vô hiệu chữ ký. Bấm "Tự Động Gas" lần nữa sau khi đã ký ⇒ phí trong ô nhập đổi,
    // nhưng byte đã ký vẫn mang phí cũ và UI không nói gì — bundle lưu lên trộn nhiều mức phí,
    // và tier chọn để broadcast (lớn nhất ≤ thanh khoản) có thể là tier phí cũ ⇒ tx không vào
    // bảng ⇒ claim kẹt hết cửa sổ recovery. Phí KHÔNG đổi thì vẫn giữ chữ ký (không sửa quá tay).
    const changed = presignedGas.maxFeePerGas !== nextMaxFee ||
      presignedGas.maxPriorityFeePerGas !== nextPriority;
    presignedGas.maxFeePerGas = nextMaxFee;
    presignedGas.maxPriorityFeePerGas = nextPriority;
    // Fill input fields (user có thể chỉnh sửa sau)
    document.getElementById("presign-gas-maxfee").value =
      formatUnits(presignedGas.maxFeePerGas, 9);
    document.getElementById("presign-gas-priority").value =
      formatUnits(presignedGas.maxPriorityFeePerGas, 9);
    document.getElementById("btn-auto-gas").textContent = "✅ Đã lấy Gas";
    // Sau khi ghi ra ô nhập, để thông báo của invalidate là thứ người dùng đọc cuối cùng.
    if (changed) invalidateSignatures("Gas đã thay đổi. Vui lòng ký lại các giao dịch.");
    updateSignButton();
  } catch (err) {
    showPresignError("Lỗi lấy gas: " + err.message);
    document.getElementById("btn-auto-gas").disabled = false;
    document.getElementById("btn-auto-gas").textContent = "⛽ Tự Động Gas";
  }
};

// Audit A.1: khai báo CỤC BỘ rồi mới gắn lên `window`. Cách viết cũ
// (`window.readGasInputs = function(){}` rồi gọi trần `readGasInputs()` ở
// nơi khác) vẫn chạy — tham chiếu trần resolve được qua thuộc tính của
// globalThis trong ES module — nhưng nó làm oxlint báo `no-undef` (false
// positive, rule không thấy phép gán `window.x` là một khai báo) và che mất
// ca LỖI THẬT cùng hình dạng: gõ sai tên hàm. Khai báo tường minh giữ được
// cả hai: inline `onchange=` vẫn tìm thấy qua `window`, còn `no-undef` lại
// thành công cụ bắt typo thật.
/**
 * Đọc một ô gas Gwei (chuỗi thô) thành wei — KHÔNG đi qua `Number`.
 *
 * Vì sao không dùng `parseFloat` + `parseUnits(String(...))` (đỏ-trước 2026-09-26,
 * `__tests__/webapp-gas-decimals.test.mjs`): JS đổi số < 1e-6 sang ký hiệu khoa học
 * (`String(parseFloat("0.00000026"))` = `"2.6e-7"`) và `parseUnits` từ chối ký hiệu đó ⇒ MỌI
 * phí nhỏ hơn 0,000001 Gwei đều ném `InvalidDecimalNumberError` — kể cả giá trị do chính
 * `autoFillGas` ghi ra (`formatUnits(260n, 9)` = `"0.00000026"`). Dấu phẩy thập phân kiểu VN
 * (`0,00000026`) thì `parseFloat` cắt tại `,` thành `0` ⇒ ô bị coi như rỗng, im lặng.
 *
 * @param {string} raw giá trị thô trong ô nhập
 * @returns {{ wei: bigint|null, error: string|null }} `wei = null` khi ô rỗng/0 (chưa thiết lập)
 *   hoặc khi `error` khác null — không bao giờ trả về giá trị dở dang.
 */
export function parseGasInput(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { wei: null, error: null };
  // Dấu phẩy thập phân kiểu VN: chỉ đổi khi chuỗi KHÔNG có dấu chấm (tránh "1,000.5").
  const normalized = text.includes(".") ? text : text.replace(",", ".");
  const match = /^\d+(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    return { wei: null, error: `"${text}" không phải số Gwei hợp lệ — dùng dấu . hoặc , thập phân (không dùng số mũ).` };
  }
  if ((match[1] || "").length > 9) {
    return { wei: null, error: `"${text}" có quá 9 chữ số thập phân (wei là đơn vị nhỏ nhất).` };
  }
  const wei = parseUnits(normalized, 9);
  return { wei: wei > 0n ? wei : null, error: null }; // 0 = chưa thiết lập (hành vi cũ)
}

function readGasField(id) {
  return parseGasInput(document.getElementById(id).value);
}

/**
 * Đọc cả hai ô gas vào `presignedGas`.
 * @returns {string|null} thông báo lỗi định dạng (đã hiện banner) hoặc null.
 */
export function readGasInputs() {
  const maxFee = readGasField("presign-gas-maxfee");
  const priority = readGasField("presign-gas-priority");
  presignedGas.maxFeePerGas = maxFee.wei;
  presignedGas.maxPriorityFeePerGas = priority.wei;
  const error = maxFee.error || priority.error;
  if (error) showPresignError("Gas không hợp lệ: " + error);
  return error;
}

/**
 * `onchange` của hai ô gas: đọc giá trị mới, cập nhật `presignedGas`, và vô hiệu chữ ký
 * nếu phí THỰC SỰ đổi.
 * @returns {string|null} thông báo lỗi định dạng (đã hiện banner) hoặc null.
 */
export function onGasInputChange() {
  const maxFee = readGasField("presign-gas-maxfee");
  const priority = readGasField("presign-gas-priority");
  // So TRƯỚC khi gán: so giá trị ĐÃ CHUẨN HOÁ (wei) với giá trị ĐANG GIỮ. So SAU khi gán là so giá
  // trị mới với chính nó ⇒ luôn false ⇒ bảo vệ vô hiệu (lỗi đã đỏ-trước trong quá trình sửa D12).
  const gasChanged = gasValuesChanged(maxFee.wei, priority.wei);
  presignedGas.maxFeePerGas = maxFee.wei;
  presignedGas.maxPriorityFeePerGas = priority.wei;
  // Reset signed state CHỈ khi gas thực sự đổi (D12: trước đây invalidate vô điều kiện, nên
  // `signWithdrawAll()` — gọi hàm này chỉ để đọc lại gas — tự xoá chữ ký vừa ký dù gas không đổi).
  if (gasChanged) {
    invalidateSignatures("Gas đã thay đổi. Vui lòng ký lại các giao dịch.");
  }
  const error = maxFee.error || priority.error;
  // Hiện lỗi định dạng SAU invalidate để đây là thứ người dùng đọc cuối cùng (invalidate cũng ghi banner).
  if (error) showPresignError("Gas không hợp lệ: " + error);
  updateSignButton();
  return error;
}

/**
 * So giá trị gas trong ô nhập với giá trị ĐANG GIỮ trong `presignedGas` (cùng đơn vị wei, gwei).
 * `onGasInputChange` chỉ gọi `invalidateSignatures()` khi HÀM này trả true — sửa D12 (vòng 6):
 * trước đây invalidate là vô điều kiện, nên `signWithdrawAll()` (gọi `onGasInputChange()` chỉ để
 * đọc lại gas) tự xoá chữ ký các mốc vừa ký kèm báo "Gas đã thay đổi" dù gas không đổi.
 *
 * Ba trạng thái phải phân biệt được cho TỪNG ô: null (chưa có) ↔ có-giá-trị (khác giá trị cũ) ↔
 * có-giá-trị (bằng giá trị cũ). `!==` trên `bigint|null` phân biệt đủ ba — giá trị đã được
 * `parseGasInput` chuẩn hoá về wei TRƯỚC khi so, nên hàm này không còn `parseFloat`/`parseUnits`
 * (đường gây lỗi `2.6e-7`).
 */
function gasValuesChanged(nextMaxFee, nextPriority) {
  return presignedGas.maxFeePerGas !== nextMaxFee || presignedGas.maxPriorityFeePerGas !== nextPriority;
}

/**
 * Chốt chặn TRƯỚC KHI KÝ: nonce sắp ký có còn là nonce on-chain sắp tới không?
 *
 * Vì sao cần (chẩn đoán 2026-09-26, triệu chứng "tier mới với nonce cao hơn tự động bị thêm
 * vào bundle có nonce cũ"): trang giữ `state.presignedNonce` từ lần bấm "Lấy Nonce" trước,
 * và KHÔNG bao giờ đọc lại trước khi ký. Nếu nonce đó đã bị tiêu thụ trong lúc trang mở (market
 * khác rút trước, hoặc chính mình rút ở tab khác), chữ ký mới mang nonce ĐÃ CHẾT: server từ chối
 * (409 `NONCE_NOT_CLAIMABLE`, D16) hoặc — trước D16 — nhét nó vào rung cũ. Người dùng thấy
 * "tier mới nằm trong bundle nonce cũ" mà không hiểu vì sao. Nonce CAO HƠN sàn vẫn hợp lệ
 * (xếp hàng có chủ đích qua nút ＋), nên chỉ chặn khi on-chain đã VƯỢT QUA nonce đang ký.
 *
 * Fail closed: không đọc được nonce on-chain thì không ký (chữ ký ở nonce mù còn tệ hơn việc
 * bắt người dùng bấm ký lại). Sàn nonce được cập nhật để nút ＋ đưa thẳng lên nonce mới.
 *
 * @returns {Promise<boolean>} true = được ký; false = đã hiện banner và chặn
 */
async function nonceStillSignable() {
  let onChain;
  try {
    onChain = await state.publicClient.getTransactionCount({
      address: state.currentAccount,
      blockTag: "pending",
    });
  } catch (err) {
    showPresignError(`Không đọc lại được nonce on-chain trước khi ký: ${err.message} — bấm "Lấy Nonce" rồi thử lại.`);
    return false;
  }
  // Sàn nonce luôn được đồng bộ: dù ký được hay không, giá trị cũ không còn đúng.
  state.onChainPendingNonce = onChain;
  setNonceStepperEnabled(true);
  const current = state.presignedNonce === null ? null : BigInt(state.presignedNonce);
  if (current !== null && onChain > current) {
    // Nâng nonce lên đúng sàn on-chain: chữ ký cũ ở nonce đã chết thì vô hiệu hoá luôn
    // (để người dùng ký lại đúng một lần), và BÁO RÕ. Không ký tiếp trong lượt này —
    // người dùng phải chủ động bấm ký lại ở nonce mới.
    const message =
      `Nonce ${current} đã bị vượt qua (on-chain đang là ${onChain}) — nonce đó đã bị một giao dịch khác tiêu thụ, ` +
      `chữ ký ở nonce này không thể lên bảng. Đã tự nâng nonce lên ${onChain}; ký lại để dùng nonce mới.`;
    state.presignedNonce = onChain;
    document.getElementById("presign-nonce").textContent = onChain;
    invalidateSignatures(message);
    showPresignError(message); // luôn có banner, kể cả khi không có chữ ký nào để vô hiệu
    updateNonceStepperButtons();
    updateSignButton();
    return false;
  }
  updateNonceStepperButtons();
  return true;
}

function updateSignButton() {
  const btn = document.getElementById("btn-sign-all");
  if (state.currentAccount && state.presignedNonce !== null && presignedGas.maxFeePerGas && state.presignedTiers.length > 0) {
    btn.disabled = false;
  } else {
    btn.disabled = true;
  }
  // Enable/disable nút rút toàn bộ shares
  const btnAll = document.getElementById("btn-sign-withdraw-all");
  if (btnAll) {
    btnAll.disabled = !(state.currentAccount && state.presignedNonce !== null && presignedGas.maxFeePerGas);
  }
}

// ============================================================
// PRESIGN: TIER MANAGEMENT
// ============================================================
export function addPresetTier(amount) {
  // Tránh trùng lặp
  if (state.presignedTiers.some(t => t.amount === String(amount))) return;
  state.presignedTiers.push({ amount: String(amount), amountWei: null, signedTx: null, status: "pending" });
  renderTierList();
  updateSignButton();
};

export function addTier() {
  state.presignedTiers.push({ amount: "", amountWei: null, signedTx: null, status: "pending" });
  renderTierList();
  updateSignButton();
};

export function removeTier(index) {
  state.presignedTiers.splice(index, 1);
  document.getElementById("btn-save-server").disabled = true;
  renderTierList();
  updateSignButton();
};

export function updateTierAmount(index, value) {
  state.presignedTiers[index].amount = value;
  // Reset signed state if amount changed (txHash bị vô hiệu vì amount cũ)
  if (state.presignedTiers[index].status === "signed") {
    state.presignedTiers[index].txHash = null;
    state.presignedTiers[index].amountWei = null;
    state.presignedTiers[index].status = "pending";
    document.getElementById("btn-save-server").disabled = true;
  }
  updateSignButton();
};

export function renderTierList() {
  const container = document.getElementById("tier-list");
  if (state.presignedTiers.length === 0) {
    container.innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem">Chưa có mốc nào. Nhấn nút "Thêm Mốc" để thêm mới.</p>';
  } else {
    container.innerHTML = state.presignedTiers.map((tier, i) => {
      const statusIcon = tier.status === "signed" ? "✅" :
                         tier.status === "signing" ? "⏳" :
                         tier.status === "error" ? "❌" : "⬜";
      const statusTitle = tier.status === "signed" ? "Đã ký" :
                          tier.status === "signing" ? "Đang ký..." :
                          tier.status === "error" ? "Lỗi" : "Chưa ký";
      return `<div class="tier-row">
            <span class="tier-label">#${i + 1}</span>
            <input type="number" value="${tier.amount}" placeholder="Số USDC"
              onchange="updateTierAmount(${i}, this.value)" ${tier.status === "signed" ? "readonly" : ""}>
            <span class="tier-status" title="${statusTitle}">${statusIcon}</span>
            <button class="btn-outline btn-remove" onclick="removeTier(${i})" ${tier.status === "signing" ? "disabled" : ""}>✕</button>
          </div>`;
    }).join("");
  }
  document.getElementById("tier-count").textContent =
    state.presignedTiers.filter(t => t.amount).length;
}

// ============================================================
// PRESIGN: SIGN ALL TIERS
// ============================================================
export async function signAllTiers() {
  if (isSigningInProgress) return;

  // Validate
  if (!state.walletClient || !state.currentAccount) {
    showPresignError("Vui lòng kết nối ví trước.");
    return;
  }
  if (state.presignedNonce === null) {
    showPresignError("Vui lòng lấy nonce trước.");
    return;
  }
  // Read gas from input fields (user có thể đã chỉnh sửa) — chỉ ĐỌC, không invalidate
  // (D12: gọi `onGasInputChange()` ở đây từng xoá chữ ký các mốc vừa ký dù gas không đổi).
  const gasError = readGasInputs();
  if (gasError || !presignedGas.maxFeePerGas || !presignedGas.maxPriorityFeePerGas) {
    showPresignError(gasError ? "Gas không hợp lệ: " + gasError : "Vui lòng nhập gas (hoặc nhấn Tự Động Gas).");
    return;
  }
  const validTiers = state.presignedTiers.filter(t => t.amount && parseFloat(t.amount) > 0);
  if (validTiers.length === 0) {
    showPresignError("Vui lòng thêm ít nhất 1 mốc tiền hợp lệ.");
    return;
  }
  // Nonce phải còn sống tại thời điểm ký (không đọc lại được ⇒ không ký).
  if (!(await nonceStillSignable())) return;
  // Multi-nonce race check: nếu market khác đã có bundle HOẠT ĐỘNG cùng
  // nonce này thì market nào trigger trước sẽ broadcast, market còn lại
  // sẽ expired. Đây là pattern chủ đích (không biết trước market nào
  // trigger), nên chỉ cảnh báo + xác nhận, không chặn cứng.
  try {
    const ovResp = await fetch("/api/overview", { headers: { ...getAuthHeaders() } });
    if (ovResp.ok) {
      const ov = await ovResp.json();
      const contenders = (ov.rounds || [])
        .find((rd) => rd.nonce === state.presignedNonce)?.markets || [];
      const others = contenders.filter((e) => e.id !== state.marketId && (e.status === "pending" || e.status === "broadcasting"));
      if (others.length > 0) {
        const okToRace = confirm(
          `Nonce ${state.presignedNonce} đã có bundle ở market khác (${others.map((e) => e.id.slice(0, 10) + "…").join(", ")}).\n\n` +
          "Market nào TRIGGER trước sẽ được broadcast; bundle của các market còn lại sẽ EXPIRED ngay khi nonce này được tiêu thụ." +
          "\n\nTiếp tục ký?"
        );
        if (!okToRace) return;
      }
    }
  } catch { /* overview unavailable — proceed */ }
  isSigningInProgress = true;
  document.getElementById("btn-sign-all").disabled = true;
  document.getElementById("btn-save-server").disabled = true;

  const progressEl = document.getElementById("sign-progress");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  progressEl.style.display = "block";

  const total = validTiers.length;
  let signed = 0;

  for (let i = 0; i < state.presignedTiers.length; i++) {
    const tier = state.presignedTiers[i];
    if (!tier.amount || parseFloat(tier.amount) <= 0) continue;

    tier.status = "signing";
    renderTierList();
    progressText.textContent = `Đang ký ${signed + 1}/${total}: ${tier.amount} USDC...`;
    progressFill.style.width = `${((signed) / total) * 100}%`;

    try {
      const assets = parseUnits(tier.amount, state.loanToken.decimals);
      const calldata = encodeFunctionData({
        abi: MORPHO_ABI,
        functionName: "withdraw",
        args: [state.marketParams, assets, 0n, state.lenderAddress, state.currentAccount],
      });

      // sendTransaction → MetaMask ký + gửi eth_sendRawTransaction đến RPC
      // Proxy trả về txHash thật (keccak256 của signedTx) để match tier sau này
      const txHash = await state.walletClient.sendTransaction({
        to: MORPHO_BLUE,
        data: calldata,
        value: 0n,
        nonce: state.presignedNonce,
        gas: 200000n,
        maxFeePerGas: presignedGas.maxFeePerGas,
        maxPriorityFeePerGas: presignedGas.maxPriorityFeePerGas,
        chain: mainnet,
        account: state.currentAccount,
      });

      // Ghi nhận hash (proxy đã capture signed tx)
      tier.txHash = txHash;
      tier.amountWei = assets.toString();
      tier.status = "signed";
      signed++;
    } catch (err) {
      tier.status = "error";
      tier.error = err.message;
      renderTierList();
      progressFill.style.width = `${(signed / total) * 100}%`;
      progressText.textContent = `❌ Lỗi tier ${i + 1}: ${err.message}`;
      isSigningInProgress = false;
      document.getElementById("btn-sign-all").disabled = false;
      return;
    }

    renderTierList();
  }

  progressFill.style.width = "100%";
  progressText.textContent = `✅ Đã ký thành công ${signed}/${total} giao dịch`;
  document.getElementById("btn-save-server").disabled = false;
  document.getElementById("btn-sign-all").disabled = false;
  isSigningInProgress = false;
};

// ============================================================
// PRESIGN: SIGN WITHDRAW ALL SHARES
// ============================================================
export async function signWithdrawAll() {
  if (isSigningInProgress) return;

  // Validate
  if (!state.walletClient || !state.currentAccount) {
    showPresignError("Vui lòng kết nối ví trước.");
    return;
  }
  if (state.presignedNonce === null) {
    showPresignError("Vui lòng lấy nonce trước.");
    return;
  }
  const gasError = onGasInputChange();
  if (gasError || !presignedGas.maxFeePerGas || !presignedGas.maxPriorityFeePerGas) {
    showPresignError(gasError ? "Gas không hợp lệ: " + gasError : "Vui lòng nhập gas (hoặc nhấn Tự Động Gas).");
    return;
  }
  // Nonce phải còn sống tại thời điểm ký (không đọc lại được ⇒ không ký).
  if (!(await nonceStillSignable())) return;

  // Re-fetch position để có supplyShares mới nhất
  try {
    const position = await state.publicClient.readContract({
      address: MORPHO_BLUE,
      abi: MORPHO_ABI,
      functionName: "position",
      args: [state.marketId, state.lenderAddress],
    });
    state.positionData.supplyShares = position[0];
  } catch {
    // Fall back to cached value — nếu không có thì báo lỗi
  }

  const shares = state.positionData.supplyShares;
  if (!shares || shares === 0n) {
    showPresignError("Bạn không có supply shares để rút.");
    return;
  }
  isSigningInProgress = true;
  const btn = document.getElementById("btn-sign-withdraw-all");
  btn.disabled = true;
  btn.textContent = "⏳ Đang ký...";
  const statusEl = document.getElementById("presign-withdraw-all-status");
  statusEl.innerHTML = '<span style="color:var(--yellow)">⏳ Đang ký giao dịch rút toàn bộ shares...</span>';

  try {
    const calldata = encodeFunctionData({
      abi: MORPHO_ABI,
      functionName: "withdraw",
      args: [state.marketParams, 0n, shares, state.lenderAddress, state.currentAccount],
    });

    const txHash = await state.walletClient.sendTransaction({
      to: MORPHO_BLUE,
      data: calldata,
      value: 0n,
      nonce: state.presignedNonce,
      gas: 200000n,
      maxFeePerGas: presignedGas.maxFeePerGas,
      maxPriorityFeePerGas: presignedGas.maxPriorityFeePerGas,
      chain: mainnet,
      account: state.currentAccount,
    });

    state.presignedWithdrawAll = {
      sharesWei: shares.toString(),
      txHash: txHash,
      status: "signed",
    };

    btn.textContent = "✅ Đã Ký";
    statusEl.innerHTML = '<span style="color:var(--green)">✅ Đã ký giao dịch rút toàn bộ shares thành công.</span>';
    document.getElementById("btn-save-server").disabled = false;
  } catch (err) {
    state.presignedWithdrawAll = { status: "error", error: err.message };
    btn.textContent = "🔄 Ký Rút Toàn Bộ Shares";
    statusEl.innerHTML = `<span style="color:var(--red)">❌ Lỗi: ${err.message}</span>`;
  } finally {
    isSigningInProgress = false;
    btn.disabled = false;
  }
};

function buildPresignedBundle() {
  // Đọc gas mới nhất từ input (phòng trường hợp user sửa sau khi ký)
  readGasInputs();
  const signedTiers = state.presignedTiers.filter(t => t.status === "signed");
  // Gửi metadata (không signedTx) — proxy sẽ ghép với signed tx đã capture
  const tiers = signedTiers.map((tier) => ({
    amount: tier.amount,
    amountWei: tier.amountWei,
    amountFormatted: `${tier.amount} ${state.loanToken.symbol}`,
    label: `${tier.amount} ${state.loanToken.symbol}`,
    txHash: tier.txHash,       // match với signedTx trong proxy
  }));

  // Append withdraw-all-shares entry nếu đã ký
  if (state.presignedWithdrawAll && state.presignedWithdrawAll.status === "signed") {
    tiers.push({
      type: "all-shares",
      sharesWei: state.presignedWithdrawAll.sharesWei,
      amountWei: "0",
      amountFormatted: "Toàn bộ shares",
      label: "Rút toàn bộ shares",
      txHash: state.presignedWithdrawAll.txHash,
    });
  }

  return {
    tiers,
    morphoBlueAddress: MORPHO_BLUE,
    marketId: state.marketId,
    lenderAddress: state.lenderAddress,
    nonce: state.presignedNonce,
    gas: "200000",
    maxFeePerGas: presignedGas.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: presignedGas.maxPriorityFeePerGas?.toString(),
    loanToken: { symbol: state.loanToken.symbol, decimals: state.loanToken.decimals },
  };
}

// ============================================================
// PRESIGN: SAVE TO SERVER
// ============================================================
export async function saveToServer() {
  const bundle = buildPresignedBundle();
  if (bundle.tiers.length === 0) {
    showPresignError("Không có giao dịch nào đã ký để lưu.");
    return;
  }

  if (!isAuthenticated()) {
    showPresignError("Vui lòng xác thực bằng ví trước khi lưu.");
    return;
  }

  document.getElementById("btn-save-server").disabled = true;
  document.getElementById("btn-save-server").textContent = "⏳ Đang gửi đến proxy...";

  try {
    // Gửi metadata đến proxy (localhost:8545) — proxy ghép với signed tx đã capture
    const resp = await fetch("/api/bundle", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify(bundle),
    });
    if (resp.status === 401) {
      clearSession();
      updateAuthUI();
      showPresignError("Phiên đăng nhập hết hạn. Vui lòng xác thực lại.");
      document.getElementById("btn-save-server").disabled = false;
      document.getElementById("btn-save-server").textContent = "💾 Lưu Lên Server";
      return;
    }
    const result = await resp.json();
    if (result.ok) {
      showPresignSuccess(
        `✅ Đã lưu ${result.tiers} giao dịch lên server!<br>` +
        `Proxy đã capture signed tx + gửi bundle đến server.<br>` +
        `Monitor sẽ tự động broadcast khi có thanh khoản.`
      );
      document.getElementById("btn-save-server").textContent = "✅ Đã Lưu";
      // Ladder trên server vừa thay đổi (merge vào rung cũ hoặc thêm rung mới)
      // — refresh cả overview lẫn rung đang hiển thị, nếu không UI giữ state cũ
      // tới lần chuyển tab tiếp theo.
      fetchExistingBundle();
      refreshPresignOverview();
    } else if (result.error?.includes("No captured transactions")) {
      showPresignError("Proxy chưa nhận được signed tx. Hãy ký lại các tier hoặc 'Ký Rút Toàn Bộ Shares'.");
      document.getElementById("btn-save-server").disabled = false;
      document.getElementById("btn-save-server").textContent = "💾 Lưu Lên Server";
    } else if (result.code === "NONCE_CONSUMED" || result.code === "NONCE_NOT_CLAIMABLE") {
      // Hai tầng chặn nonce đã chết, MỘT cách phục hồi: proxy đọc thẳng nonce on-chain
      // (`NONCE_CONSUMED`, D20) và server từ chối rung đã tiêu thụ (`NONCE_NOT_CLAIMABLE`, D16 — mã
      // này chỉ tới được đây vì relay proxy chuyển tiếp `code`). Chữ ký vừa gửi không thể mine ⇒
      // lấy ngay nonce mới (kèm vô hiệu chữ ký cũ) để người dùng ký lại đúng một lần.
      const fromServer = result.code === "NONCE_NOT_CLAIMABLE";
      // Lấy lại sàn TRƯỚC khi báo: `fetchNonce()` tự vô hiệu chữ ký cũ và có banner riêng, nên
      // thông báo cuối cùng (thứ người dùng đọc) phải là thông báo nói rõ VÌ SAO bị từ chối.
      await fetchNonce();
      // Nút lưu: chỉ bật lại khi CÒN chữ ký sống — nonce đổi thì `fetchNonce()` vừa vô hiệu hết, mời
      // bấm lại chỉ để nhận "không có giao dịch nào đã ký để lưu".
      document.getElementById("btn-save-server").disabled = !hasLiveSignatures();
      document.getElementById("btn-save-server").textContent = "💾 Lưu Lên Server";
      showPresignError(
        (fromServer
          ? "Rung của nonce này đã chết (nonce đã bị tiêu thụ) — server từ chối lưu: "
          : "Nonce của chữ ký đã bị tiêu thụ — proxy từ chối lưu: ") +
        `${result.error}<br>` +
        `<small>Đã lấy lại nonce on-chain (${state.presignedNonce}). Ký lại để dùng nonce mới.</small>`
      );
      fetchExistingBundle();
      refreshPresignOverview();
    } else {
      showPresignError("Lỗi proxy: " + (result.error || "Unknown"));
      document.getElementById("btn-save-server").disabled = false;
      document.getElementById("btn-save-server").textContent = "💾 Lưu Lên Server";
    }
  } catch (err) {
    showPresignError(`Không thể kết nối proxy (${getProxyUrl()}). Proxy đã chạy chưa? ` + err.message);
    document.getElementById("btn-save-server").disabled = false;
    document.getElementById("btn-save-server").textContent = "💾 Lưu Lên Server";
  }
};
