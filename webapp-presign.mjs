/**
 * Tab "Ký sẵn": nonce, gas, mốc rút, ký và lưu bundle (audit P5).
 *
 * NỬA TRÊN của tính năng presign (nửa dưới: `webapp-presign-bundles.mjs`). Đây là module
 * duy nhất gọi `signTransaction` — tức chỗ duy nhất chạm khoá ký; phần còn lại chỉ đọc
 * bundle đã ký.
 */

import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { mainnet } from "viem/chains";
import { retryTransient, stepNonce } from "./webapp-logic.mjs";
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
    if (state.presignedTiers.length > 0 && state.presignedNonce !== null && gasPairReady()) {
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

/**
 * Đọc sàn nonce on-chain (`pending`) và cập nhật `state.presignedNonce`.
 *
 * @returns {Promise<boolean>} true = ĐỌC ĐƯỢC (sàn đã cập nhật, không cần so giá trị cũ); false = chưa
 *   kết nối ví hoặc RPC lỗi (đã hiện banner). `saveToServer` dùng giá trị này để không hứa "đã lấy lại
 *   nonce on-chain" khi lần đọc thất bại, và để phân biệt "nonce đã bị tiêu thụ" với "rung cùng nonce
 *   chỉ đang chặn" (audit 2026-09-26) — hai ca cần hai chỉ dẫn khác nhau.
 */
export async function fetchNonce() {
  if (!state.currentAccount) {
    showPresignError("Vui lòng kết nối ví trước.");
    return false;
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
    updateNonceHint();
    // Nonce mới → chữ ký cũ (cùng nonce cũ) không còn hợp lệ
    if (prevNonce !== null && prevNonce !== state.presignedNonce) {
      invalidateSignatures("Nonce đã thay đổi. Vui lòng ký lại các giao dịch.");
    }
    updateSignButton();
    return true;
  } catch (err) {
    showPresignError("Lỗi lấy nonce: " + err.message);
    document.getElementById("btn-fetch-nonce").disabled = false;
    document.getElementById("btn-fetch-nonce").textContent = "🔢 Lấy Nonce";
    return false;
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
  updateNonceHint();
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
 * Chấp nhận cả dạng thiếu số 0 đầu/cuối (`.5`, `,5`, `50.`) như `0.5`/`50.0` — bản cũ
 * (`parseFloat`) chấp nhận cả ba, nên từ chối chúng là hồi quy (audit D15–D20, 2026-09-26).
 *
 * @param {string} raw giá trị thô trong ô nhập
 * @returns {{ wei: bigint|null, error: string|null }} `wei = null` khi ô TRỐNG hoặc input không hợp lệ; `0n` LÀ
 *   giá trị hợp lệ (chủ động không tip, 2026-09-26) — chỉ trần phí 0 mới bị chặn, ở tầng caller.
 *   hoặc khi `error` khác null — không bao giờ trả về giá trị dở dang.
 */
export function parseGasInput(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { wei: null, error: null };
  // Dấu phẩy thập phân kiểu VN: chỉ đổi khi chuỗi KHÔNG có dấu chấm (tránh "1,000.5").
  let normalized = text.includes(".") ? text : text.replace(",", ".");
  // Chuẩn hoá dạng thiếu số 0 đầu/cuối về dạng đầy đủ TRƯỚC khi khớp regex (`.5` → `0.5`).
  if (normalized.startsWith(".")) normalized = `0${normalized}`;
  else if (normalized.endsWith(".")) normalized = `${normalized}0`;
  // `match[1]` PHẢI là phần thập phân (phần nguyên không bắt nhóm): nó là thứ chặn >9 chữ số mà
  // `parseUnits` sẽ âm thầm cắt bớt.
  const match = /^\d+(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    return { wei: null, error: `"${text}" không phải số Gwei hợp lệ — dùng dấu . hoặc , thập phân (không dùng số mũ).` };
  }
  if ((match[1] || "").length > 9) {
    return { wei: null, error: `"${text}" có quá 9 chữ số thập phân (wei là đơn vị nhỏ nhất).` };
  }
  const wei = parseUnits(normalized, 9);
  // 2026-09-26: `0` là giá trị HỢP LỆ (chủ động không tip), KHÔNG còn bị hạ về `null`.
  // Trước fix, "0" ở ô maxPriorityFeePerGas bị coi là "chưa thiết lập" ⇒ nút Ký khoá và guard báo
  // "Vui lòng nhập gas" — trong khi tip 0 hợp lệ theo EIP-1559 và chính `autoFillGas` ghi ra "0"
  // khi RPC trả priorityFee = 0. Ô TRỐNG mới là "chưa thiết lập"; cặp phí vô lý bị `gasPairError` chặn.
  return { wei, error: null };
}

/**
 * Kiểm tra CẶP phí ở tầng tĩnh (2026-09-26): hai tổ hợp không ký được / không thể lên bảng.
 *
 * 1. `maxFeePerGas = 0`: từ khi `parseGasInput` coi `0` là giá trị hợp lệ, chuỗi "0" ở ô maxFeePerGas đi
 *    thẳng qua cổng định dạng — nhưng trần 0 dưới cả base fee ⇒ giao dịch KHÔNG BAO GIỜ vào bảng, còn
 *    bundle đã ký thì tiêu mất nonce ⇒ claim kẹt. Tip 0 (không tip) hợp lệ; trần 0 thì không.
 * 2. `maxPriorityFeePerGas > maxFeePerGas`: EIP-1559 không cho tip vượt trần. Cổng này PHẢI ở đây vì
 *    không thể để viem lo: `assertRequest`/`assertTransactionEIP1559` ném `TipAboveFeeCapError` NGAY
 *    TRONG vòng ký ⇒ tier rơi vào ❌ với thông báo tiếng Anh ở `#progress-text`, KHÔNG banner ở
 *    `#presign-result` (banner cũ nằm nguyên), nút Ký vẫn bật ⇒ bấm lại lặp đúng lỗi đó (audit
 *    2026-09-26). Biên `tip === trần` HỢP LỆ — đúng như viem (chỉ chặn khi `>`).
 * @returns {string|null} thông báo lỗi (kèm số cụ thể) hoặc null khi cặp phí dùng được.
 */
function gasPairError(maxFeeWei, priorityWei) {
  if (maxFeeWei === 0n) {
    return "maxFeePerGas = 0: trần phí 0 nghĩa là giao dịch không bao giờ vào bảng — hãy đặt trần > 0 " +
      "(maxPriorityFeePerGas = 0 vẫn hợp lệ nếu bạn muốn không tip).";
  }
  if (maxFeeWei !== null && priorityWei !== null && priorityWei > maxFeeWei) {
    return `maxPriorityFeePerGas (${formatUnits(priorityWei, 9)} Gwei) lớn hơn maxFeePerGas ` +
      `(${formatUnits(maxFeeWei, 9)} Gwei) — EIP-1559 không cho phép tip vượt trần (ví sẽ từ chối ký). ` +
      "Hãy hạ tip hoặc nâng trần.";
  }
  return null;
}

/**
 * Cặp phí đang giữ trong `presignedGas` có dùng được để ký không — CÙNG một luật với `gasPairError()`
 * (một nguồn sự thật cho cả cổng chặn lẫn trạng thái nút, nên nút không thể mời bấm một lượt ký mà
 * `signAllTiers`/`signWithdrawAll` chắc chắn từ chối). Cần TRỐNG ≠ 0: ô trống là "chưa thiết lập".
 */
function gasPairReady() {
  // Chỉ cần TRẦN có giá trị: ô tip TRỐNG vẫn để nút mở như hành vi cũ — lượt bấm đó nhận đúng lời
  // nhắc "Vui lòng nhập gas (hoặc nhấn Tự Động Gas)", hữu ích hơn một nút chết không giải thích
  // (audit vòng 2, 2026-09-26). Cặp VÔ LÝ (trần 0, tip > trần) mới khoá nút, vì lượt ký chắc chắn bị
  // cổng `gasPairError` từ chối — mời bấm chỉ tạo vòng lặp "bấm → banner → bấm".
  return presignedGas.maxFeePerGas !== null &&
    gasPairError(presignedGas.maxFeePerGas, presignedGas.maxPriorityFeePerGas) === null;
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
  // `gasPairError` chạy SAU lỗi định dạng: "0" hợp lệ ở tầng parse, chỉ bị chặn ở đây vì cặp phí vô lý
  // (trần 0 không bao giờ vào bảng; tip > trần thì ví/viem từ chối ký) — khác ô TRỐNG = chưa thiết lập.
  const error = maxFee.error || priority.error || gasPairError(maxFee.wei, priority.wei);
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
  // `gasPairError` chạy SAU lỗi định dạng: "0" hợp lệ ở tầng parse, chỉ bị chặn ở đây vì cặp phí vô lý
  // (trần 0 không bao giờ vào bảng; tip > trần thì ví/viem từ chối ký) — khác ô TRỐNG = chưa thiết lập.
  const error = maxFee.error || priority.error || gasPairError(maxFee.wei, priority.wei);
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
  updateNonceHint();
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
    updateNonceHint();
    updateSignButton();
    return false;
  }
  updateNonceStepperButtons();
  return true;
}

function updateSignButton() {
  const btn = document.getElementById("btn-sign-all");
  // `gasPairReady()` (2026-09-26): `0n` falsy nên điều kiện cũ khoá nút ngay cả khi người dùng chủ động
  // tip 0; trần 0 và tip > trần vẫn phải khoá (tx không bao giờ vào bảng / ví từ chối ký).
  if (state.currentAccount && state.presignedNonce !== null && state.presignedTiers.length > 0 && gasPairReady()) {
    btn.disabled = false;
  } else {
    btn.disabled = true;
  }
  // Enable/disable nút rút toàn bộ shares
  const btnAll = document.getElementById("btn-sign-withdraw-all");
  if (btnAll) {
    btnAll.disabled = !(state.currentAccount && state.presignedNonce !== null && gasPairReady());
  }
}

// ============================================================
// PRESIGN: BẰNG CHỨNG NONCE CỦA CHỮ KÝ (proxy capture)
// ============================================================
/**
 * Đọc danh sách tx proxy đã capture (hash + nonce THẬT của chữ ký ví).
 *
 * Vì sao cần: nonce KHÔNG nằm trong hash mà ví trả về — nó chỉ tồn tại trong byte đã ký, thứ
 * browser không bao giờ giữ. Proxy là nơi duy nhất thấy nó (lưu lúc `eth_sendRawTransaction`), nên
 * `GET /api/captured` (đã lọc bỏ `signedTx`) là nguồn duy nhất để biết ví có tôn trọng
 * `state.presignedNonce` hay không (chẩn đoán 2026-09-26).
 *
 * Trả `null` khi CHƯA có bằng chứng (mạng lỗi, 401, proxy chưa có route, entry kiểu cũ): thiếu bằng
 * chứng KHÔNG phải bằng chứng sai — người gọi quyết định, và bước Lưu vẫn có cổng nonce ở proxy.
 * Đọc là read-only nên 401 ở đây không được tự đăng xuất người dùng (chỉ POST mới có nhánh đó).
 */
async function readCapturedTxs() {
  const outcome = await retryTransient(async () => {
    try {
      const resp = await fetch("/api/captured", { headers: { ...getAuthHeaders() } });
      if (!resp.ok) return { retry: resp.status >= 500, failure: `HTTP ${resp.status}` };
      const data = await resp.json();
      return { data: Array.isArray(data?.txs) ? data.txs : null };
    } catch (err) {
      return { retry: true, failure: `lỗi mạng: ${err.message}` };
    }
  });
  return outcome?.data ?? null;
}

/** Nonce THẬT của chữ ký có hash này theo proxy; `null` = proxy chưa có bằng chứng cho hash đó. */
function capturedNonceOf(txs, txHash) {
  if (!txs || !txHash) return null;
  const want = String(txHash).toLowerCase();
  const entry = txs.find((tx) => String(tx?.hash || "").toLowerCase() === want);
  return entry?.nonce == null ? null : Number(entry.nonce);
}

/**
 * Lời nhắc khi `presignedNonce` đứng TRÊN sàn on-chain: nonce cao chỉ vào được bảng nếu ví CHỊU
 * đặt nonce. Không chặn gì (không có cổng preflight theo ví — quyết định 2026-09-24) — chỉ nói
 * trước, để lần ký đầu tiên không đến bất ngờ.
 */
function updateNonceHint() {
  const el = document.getElementById("presign-nonce-hint");
  if (!el) return;
  const floor = state.onChainPendingNonce;
  const current = state.presignedNonce;
  if (floor === null || current === null || Number(current) <= Number(floor)) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "block";
  el.innerHTML =
    `<div class="banner warn">⚠️ Đang ký ở nonce <b>${current}</b> (sàn on-chain ${floor}, +${Number(current) - Number(floor)}). ` +
    `Ví phải cho phép đặt nonce khi ký — MetaMask: Settings → Advanced → bật “Customize transaction nonce”, ` +
    `rồi đặt đúng nonce <b>${current}</b> trong TỪNG popup xác nhận; hoặc dùng ví nhận nonce do dApp gửi. ` +
    `Ví không cho đặt nonce sẽ ký ở nonce riêng — webapp phát hiện ngay sau khi ký và sẽ không lưu.</div>`;
}

/** Thông báo lệch nonce dùng đúng HAI SỐ (không suy đoán) + đường sửa. */
function nonceMismatchMessage({ actual, requested, label }) {
  return (
    `Ví đã ký ở <b>nonce ${actual}</b>, không phải <b>nonce ${requested}</b> bạn đã chọn` +
    (label ? ` (${label})` : "") +
    ` — ví bỏ qua nonce do webapp gửi. Chữ ký này không thể lưu vào rung nonce ${requested} nên CHƯA có gì được gửi lên server. ` +
    `Cách sửa: bật cho phép đặt nonce trong ví (MetaMask: Settings → Advanced → “Customize transaction nonce”) rồi ký lại, ` +
    `đặt đúng nonce ${requested} trong TỪNG popup; hoặc dùng ví nhận nonce do dApp gửi.`
  );
}

/**
 * Đánh dấu các tier có chữ ký ở SAI nonce là ❌ — để ✅ không nói dối và nút Lưu không mời bấm
 * lại đúng lỗi đó. Tier đã đánh dấu sẽ bị `buildPresignedBundle` bỏ qua (status !== "signed").
 * @returns {boolean} true nếu có ít nhất một chữ ký bị đánh dấu
 */
function markNonceMismatchTiers(txHashes, { requested, actual }) {
  const wanted = new Set((txHashes || []).filter(Boolean).map((h) => String(h).toLowerCase()));
  if (wanted.size === 0) return false;
  let touched = false;
  for (const tier of state.presignedTiers) {
    if (!tier.txHash || !wanted.has(String(tier.txHash).toLowerCase())) continue;
    tier.status = "error";
    tier.error = `ví ký ở nonce ${actual}, không phải ${requested}`;
    tier.nonceMismatch = { requested, actual };
    touched = true;
  }
  if (state.presignedWithdrawAll?.txHash && wanted.has(String(state.presignedWithdrawAll.txHash).toLowerCase())) {
    state.presignedWithdrawAll.status = "error";
    state.presignedWithdrawAll.error = `ví ký ở nonce ${actual}, không phải ${requested}`;
    state.presignedWithdrawAll.nonceMismatch = { requested, actual };
    touched = true;
  }
  if (touched) renderTierList();
  return touched;
}

/**
 * So nonce THẬT của từng chữ ký trong bundle (proxy capture) với nonce bundle sẽ khai.
 * @returns {Promise<Array<{label: string, txHash: string, actual: number}>>} rỗng = khớp / chưa có bằng chứng
 */
async function findBundleNonceMismatches(bundle) {
  const txs = await readCapturedTxs();
  if (!txs) return [];
  const mismatches = [];
  for (const tier of bundle.tiers) {
    const actual = capturedNonceOf(txs, tier.txHash);
    if (actual !== null && Number(actual) !== Number(bundle.nonce)) {
      mismatches.push({ label: tier.label, txHash: tier.txHash, actual });
    }
  }
  return mismatches;
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
  // `=== null` chứ KHÔNG falsy: `0n` (không tip) là giá trị hợp lệ và `0n` là falsy trong JS
  // (2026-09-26). Trần phí 0 đã bị chặn phía trên qua `gasError`.
  if (gasError || presignedGas.maxFeePerGas === null || presignedGas.maxPriorityFeePerGas === null) {
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
  // Số tier không đọc được bằng chứng nonce (proxy cũ/mạng lỗi) — dùng cho lời kết trung thực.
  let unverified = 0;

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

      // Bằng chứng nonce (chẩn đoán 2026-09-26): ví có ký ĐÚNG nonce mình gửi không? Nonce không
      // nằm trong hash — chỉ proxy đọc được từ byte đã ký. Lệch ⇒ DỪNG NGAY: ký tiếp các tier còn
      // lại chỉ đắp thêm chữ ký không lưu được, còn để ✅ trên tier này là nói dối.
      const actualNonce = capturedNonceOf(await readCapturedTxs(), txHash);
      if (actualNonce !== null && Number(actualNonce) !== Number(state.presignedNonce)) {
        tier.status = "error";
        tier.error = `ví ký ở nonce ${actualNonce}, không phải ${state.presignedNonce}`;
        tier.nonceMismatch = { requested: Number(state.presignedNonce), actual: actualNonce };
        renderTierList();
        progressText.textContent = `❌ Ví ký ở nonce ${actualNonce}, không phải nonce ${state.presignedNonce} — đã dừng ký`;
        showPresignError(nonceMismatchMessage({
          actual: actualNonce,
          requested: state.presignedNonce,
          label: `${tier.amount} ${state.loanToken.symbol}`,
        }));
        isSigningInProgress = false;
        document.getElementById("btn-sign-all").disabled = false;
        return;
      }
      if (actualNonce === null) unverified++;

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
  progressText.textContent = `✅ Đã ký thành công ${signed}/${total} giao dịch` +
    (unverified > 0
      ? " (chưa xác minh được nonce — proxy sẽ kiểm khi lưu)"
      : ` — proxy xác nhận đúng nonce ${state.presignedNonce}`);
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
  // `=== null` chứ KHÔNG falsy: `0n` (không tip) là giá trị hợp lệ và `0n` là falsy trong JS
  // (2026-09-26). Trần phí 0 đã bị chặn phía trên qua `gasError`.
  if (gasError || presignedGas.maxFeePerGas === null || presignedGas.maxPriorityFeePerGas === null) {
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

    // Bằng chứng nonce — cùng luật với `signAllTiers`: ví ký sai nonce thì chữ ký này không thể
    // lưu ở rung nonce đã chọn, nên đánh dấu lỗi NGAY và không để nút Lưu mời bấm.
    const actualNonce = capturedNonceOf(await readCapturedTxs(), txHash);
    if (actualNonce !== null && Number(actualNonce) !== Number(state.presignedNonce)) {
      state.presignedWithdrawAll = {
        status: "error",
        error: `ví ký ở nonce ${actualNonce}, không phải ${state.presignedNonce}`,
        nonceMismatch: { requested: Number(state.presignedNonce), actual: actualNonce },
      };
      btn.textContent = "🔄 Ký Rút Toàn Bộ Shares";
      statusEl.innerHTML =
        `<span style="color:var(--red)">❌ Ví ký ở nonce ${actualNonce}, không phải nonce ${state.presignedNonce} — chưa ký được.</span>`;
      showPresignError(nonceMismatchMessage({
        actual: actualNonce,
        requested: state.presignedNonce,
        label: "Rút toàn bộ shares",
      }));
      return;
    }

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

  // Preflight nonce (chẩn đoán 2026-09-26): nếu chữ ký THẬT không cùng nonce bundle sẽ khai thì
  // proxy chắc chắn từ chối (409 NONCE_MISMATCH) — chặn ở đây để lời giải thích nằm trong tay
  // webapp kèm SỐ THẬT, thay vì đẩy một POST chắc chắn hỏng rồi hiện chuỗi "Lỗi proxy: …".
  // Thiếu bằng chứng (proxy cũ/mạng lỗi) KHÔNG chặn: cổng nonce ở proxy vẫn là chốt cuối.
  const mismatches = await findBundleNonceMismatches(bundle);
  if (mismatches.length > 0) {
    markNonceMismatchTiers(mismatches.map((m) => m.txHash), {
      requested: Number(bundle.nonce),
      actual: mismatches[0].actual,
    });
    document.getElementById("btn-save-server").disabled = true;
    showPresignError(nonceMismatchMessage({
      actual: mismatches.map((m) => m.actual).join(", "),
      requested: bundle.nonce,
      label: mismatches.map((m) => m.label).join(", "),
    }));
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
    } else if (result.code === "NONCE_MISMATCH") {
      // Proxy nói rõ chữ ký THẬT nằm ở nonce nào (409 + `txNonce`/`bundleNonce`/`index`, hoặc
      // `txNonces` khi các tier ở nhiều nonce khác nhau). Trước fix đây là chuỗi nằm trong
      // `result.error` và webapp rơi xuống nhánh "Lỗi proxy: …" chung — người dùng bấm Lưu lặp
      // đúng lỗi đó mà không biết phải sửa gì. Đánh dấu ❌ đúng các chữ ký không thể lưu và khoá
      // Lưu: muốn lưu phải sửa ví (cho đặt nonce) rồi ký lại — KHÔNG tự hạ nonce theo ví.
      const actuals = Array.isArray(result.txNonces)
        ? result.txNonces.join(", ")
        : String(result.txNonce ?? "?");
      const requested = result.bundleNonce ?? bundle.nonce;
      const faulty = Array.isArray(result.txNonces)
        // Trộn nonce: không tier nào ghép được thành MỘT rung ở nonce đã chọn.
        ? bundle.tiers.map((t) => t.txHash)
        : (result.index != null && bundle.tiers[result.index]
          ? [bundle.tiers[result.index].txHash]
          : bundle.tiers.map((t) => t.txHash));
      markNonceMismatchTiers(faulty, { requested: Number(requested), actual: actuals });
      showPresignError(nonceMismatchMessage({
        actual: actuals,
        requested,
        label: result.index != null ? bundle.tiers[result.index]?.label : null,
      }));
      document.getElementById("btn-save-server").disabled = true;
      document.getElementById("btn-save-server").textContent = "💾 Lưu Lên Server";
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
      // Audit 2026-09-26: "server từ chối" KHÔNG đồng nghĩa "nonce đã bị tiêu thụ". Rung `invalid`
      // (verify NỘI DUNG bundle thất bại — trước mọi lần broadcast) giữ nonce còn nguyên trên chain,
      // nên `fetchNonce()` đọc lại ĐÚNG nonce cũ, chữ ký vẫn dùng được sau khi xoá rung chặn. Phải đọc
      // nonce TRƯỚC/SAU để biết mình đang ở ca nào, thay vì hứa "đã lấy lại nonce mới" rồi để người
      // dùng bấm Lưu lặp đúng 409 đó.
      const fromServer = result.code === "NONCE_NOT_CLAIMABLE";
      const nonceBefore = state.presignedNonce;
      const refreshed = await fetchNonce();
      const nonceAdvanced = refreshed && state.presignedNonce !== nonceBefore;
      const headline = !fromServer
        ? "Nonce của chữ ký đã bị tiêu thụ — proxy từ chối lưu: "
        : nonceAdvanced
          ? "Rung của nonce này đã chết (nonce đã bị tiêu thụ) — server từ chối lưu: "
          : "Server từ chối lưu: ";
      const nonceNote = refreshed
        ? (nonceAdvanced
          ? `Đã lấy lại nonce on-chain (${state.presignedNonce}). Ký lại để dùng nonce mới.`
          : `Nonce on-chain vẫn là ${state.presignedNonce} — nonce CHƯA bị tiêu thụ: xoá rung chặn (nút 🗑 ở rung đó, mục “Bundle trên server”) rồi bấm Lưu Lại, KHÔNG cần ký lại.`)
        : "Không đọc lại được nonce on-chain — bấm “Lấy Nonce” rồi thử lại.";
      // Lấy lại sàn TRƯỚC khi báo: `fetchNonce()` tự vô hiệu chữ ký cũ và có banner riêng, nên
      // thông báo cuối cùng (thứ người dùng đọc) phải là thông báo nói rõ VÌ SAO bị từ chối.
      // Nút lưu: chỉ bật lại khi CÒN chữ ký sống — nonce đổi thì `fetchNonce()` vừa vô hiệu hết, mời
      // bấm lại chỉ để nhận "không có giao dịch nào đã ký để lưu".
      document.getElementById("btn-save-server").disabled = !hasLiveSignatures();
      document.getElementById("btn-save-server").textContent = "💾 Lưu Lên Server";
      showPresignError(
        headline +
        `${result.error}<br>` +
        `<small>${nonceNote}</small>`
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
