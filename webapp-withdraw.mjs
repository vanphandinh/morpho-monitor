/**
 * Tab "Rút Tiền": MAX, validate, ký lệnh rút, xác minh tx trên RPC công khai (audit P5).
 *
 * Giữ nguyên bất biến R4: validation chạy TRƯỚC khi ký, và xác minh tx là best-effort không
 * chặn UI — kết quả xác minh của lần rút CŨ không được ghi đè banner của lần rút MỚI.
 */

import { formatUnits, parseUnits } from "viem";
import { TX_VERIFY_ATTEMPTS, TX_VERIFY_DELAY_MS, computeLiquidity, computeMaxWithdraw, computeSupplyAssets, shortenAddr, txVisibleOnChain, validateWithdraw } from "./webapp-logic.mjs";
import { esc, formatToken } from "./webapp-render.mjs";
import { MORPHO_ABI, MORPHO_BLUE, state } from "./webapp-state.mjs";
import { getProxyUrl, hideError, showError, showTxResult } from "./webapp-shell.mjs";

// R4: tăng mỗi lần rút — kết quả xác minh của lần rút CŨ không được ghi đè
// banner của lần rút MỚI.
let txVerifyToken = 0;

// ============================================================
// WITHDRAW
// ============================================================
export async function setMaxAmount() {
  // Re-fetch both market state and position to get fresh data
  // (cached data may be stale if page has been open for a while)
  try {
    const [position, market] = await Promise.all([
      state.publicClient.readContract({
        address: MORPHO_BLUE,
        abi: MORPHO_ABI,
        functionName: "position",
        args: [state.marketId, state.lenderAddress],
      }),
      state.publicClient.readContract({
        address: MORPHO_BLUE,
        abi: MORPHO_ABI,
        functionName: "market",
        args: [state.marketId],
      }),
    ]);

    // Update position
    state.positionData.supplyShares = position[0];

    // Update market state
    state.marketData.totalSupplyAssets = market[0];
    state.marketData.totalSupplyShares = market[1];
    state.marketData.totalBorrowAssets = market[2];
    state.marketData.totalBorrowShares = market[3];

    // Recompute derived values
    const supplyAssets = computeSupplyAssets(
      state.positionData.supplyShares,
      state.marketData.totalSupplyAssets,
      state.marketData.totalSupplyShares
    );
    const liquidity = computeLiquidity(state.marketData.totalSupplyAssets, state.marketData.totalBorrowAssets);

    state.marketData.supplyAssets = supplyAssets;
    state.marketData.liquidity = liquidity;

    // MAX = min(supplyAssets, liquidity): thanh khoản thấp hơn số đã cung cấp
    // thì chỉ rút được tối đa bằng thanh khoản.
    const max = computeMaxWithdraw(supplyAssets, liquidity);

    document.getElementById("withdraw-amount").value = formatUnits(max, state.loanToken.decimals);
    document.getElementById("max-withdraw").textContent = formatToken(max, state.loanToken);
  } catch {
    // Fallback to cached value if re-fetch fails
    const supplyAssets = state.marketData.supplyAssets ?? 0n;
    const liquidity = state.marketData.liquidity ?? 0n;
    const max = computeMaxWithdraw(supplyAssets, liquidity);
    document.getElementById("withdraw-amount").value = formatUnits(max, state.loanToken.decimals);
    document.getElementById("max-withdraw").textContent = formatToken(max, state.loanToken);
  }
};

export async function withdrawAmount() {
  const amountStr = document.getElementById("withdraw-amount").value;
  if (!amountStr || parseFloat(amountStr) <= 0) {
    showError("Vui lòng nhập số lượng cần rút.");
    return;
  }

  const assets = parseUnits(amountStr, state.loanToken.decimals);

  // Client-side validation: catch obvious errors before sending on-chain.
  // Phép kiểm tra nằm ở webapp-logic.mjs (A.1b) nên test import đúng code
  // này — chỉ phần hiển thị (kèm số tiền đã format) ở lại đây.
  const check = validateWithdraw({
    assets,
    supplyAssets: state.marketData.supplyAssets,
    liquidity: state.marketData.liquidity,
  });
  if (!check.valid) {
    if (check.reason === "over_balance") {
      showError(
        `Số lượng vượt quá số dư có thể rút (${formatToken(state.marketData.supplyAssets, state.loanToken)}).`
      );
    } else if (check.reason === "over_liquidity") {
      showError(
        `Thanh khoản market không đủ. Chỉ có ${formatToken(state.marketData.liquidity, state.loanToken)} khả dụng.`
      );
    } else {
      showError("Số lượng rút không thể bằng 0.");
    }
    return;
  }

  await doWithdraw(assets, 0n);
};

export async function withdrawAll() {
  const shares = state.positionData.supplyShares;
  if (shares === 0n) {
    showError("Bạn không có supply shares để rút.");
    return;
  }

  // Re-fetch position to get up-to-date supply data
  try {
    const position = await state.publicClient.readContract({
      address: MORPHO_BLUE,
      abi: MORPHO_ABI,
      functionName: "position",
      args: [state.marketId, state.lenderAddress],
    });
    state.positionData.supplyShares = position[0];
    const supplyAssets = computeSupplyAssets(
      state.positionData.supplyShares,
      state.marketData.totalSupplyAssets,
      state.marketData.totalSupplyShares
    );
    state.marketData.supplyAssets = supplyAssets;
  } catch {
    // Continue with cached data if refresh fails
  }

  const supplyAssets = state.marketData.supplyAssets;

  // Warn if market liquidity < supply assets (partial withdrawal may occur)
  if (state.marketData.liquidity < supplyAssets) {
    const confirmMsg =
      `⚠️ Thanh khoản thị trường chỉ có ${formatToken(state.marketData.liquidity, state.loanToken)}, ` +
      `thấp hơn vị thế ${formatToken(supplyAssets, state.loanToken)} của bạn.\n\n` +
      `Giao dịch có thể chỉ rút được một phần hoặc thất bại.\n\n` +
      `Tiếp tục?`;
    if (!confirm(confirmMsg)) return;
  }

  // Confirm
  const confirmMsg =
    `Bạn sắp rút TOÀN BỘ vị thế:\n\n` +
    `${formatToken(supplyAssets, state.loanToken)}\n` +
    `(${shares.toString()} shares)\n\n` +
    `Tiền sẽ được gửi về ví: ${state.currentAccount}\n\n` +
    `Xác nhận?`;

  if (!confirm(confirmMsg)) return;

  await doWithdraw(0n, shares);
};

async function doWithdraw(assets, shares) {
  if (!state.walletClient || !state.currentAccount) {
    showError("Vui lòng kết nối ví trước.");
    return;
  }

  hideError();
  document.getElementById("tx-result").style.display = "none";

  const btnWithdraw = document.getElementById("btn-withdraw");
  const btnWithdrawAll = document.getElementById("btn-withdraw-all");
  btnWithdraw.disabled = true;
  btnWithdrawAll.disabled = true;
  btnWithdraw.textContent = "⏳ Đang kiểm tra...";

  try {
    // Step 1: Simulate
    const { request } = await state.publicClient.simulateContract({
      address: MORPHO_BLUE,
      abi: MORPHO_ABI,
      functionName: "withdraw",
      args: [state.marketParams, assets, shares, state.lenderAddress, state.currentAccount],
      account: state.currentAccount,
    });

    btnWithdraw.textContent = "⏳ Chờ MetaMask xác nhận...";

    // Step 2: Write
    const hash = await state.walletClient.writeContract(request);

    const etherscanLink = `https://etherscan.io/tx/${hash}`;
    showTxResult("success",
      `✅ Giao dịch đã gửi thành công!<br><br>` +
      `<strong>Tx Hash:</strong> <a href="${etherscanLink}" target="_blank">${shortenAddr(hash)}</a><br>` +
      `<a href="${etherscanLink}" target="_blank">📊 Xem trên Etherscan →</a>` +
      `<div id="tx-verify-note" class="tx-verify-note">⏳ Đang xác minh giao dịch trên RPC công khai…</div>`
    );

    // R4: xác minh không chặn UI — bắt trường hợp ví trỏ RPC về proxy, tx chỉ
    // được capture nên không bao giờ lên chain dù ví báo thành công.
    const verifyToken = ++txVerifyToken;
    txVisibleOnChain(state.publicClient, hash).then((visible) => {
      if (verifyToken !== txVerifyToken) return; // đã có lần rút mới hơn
      const note = document.getElementById("tx-verify-note");
      if (!note) return; // banner đã bị lần rút khác thay thế
      if (visible) {
        note.textContent = "✅ Đã thấy giao dịch trên RPC công khai.";
        return;
      }
      note.innerHTML =
        `⚠️ Không thấy giao dịch này trên RPC công khai sau ~${Math.round((TX_VERIFY_ATTEMPTS * TX_VERIFY_DELAY_MS) / 1000)}s. ` +
        `Nếu ví của bạn đang trỏ RPC về proxy (<code>${esc(getProxyUrl())}</code>), giao dịch chỉ được ` +
        `<strong>ghi lại (capture)</strong> để ký sẵn — chưa lên chain. ` +
        `Hãy thêm mạng thật trong ví rồi đối chiếu link Etherscan ở trên.`;
    }).catch(() => {
      // Xác minh là best-effort: lỗi ở đây không được làm hỏng UI.
    });
  } catch (err) {
    if (err.message?.includes("rejected") || err.message?.includes("denied")) {
      showTxResult("error", "❌ Bạn đã từ chối giao dịch.");
    } else if (err.message?.includes("revert") || err.message?.includes("reverted")) {
      showTxResult("error", `❌ Giao dịch thất bại (revert):<br>${err.message}`);
    } else {
      showTxResult("error", `❌ Lỗi: ${err.message}`);
    }
  } finally {
    btnWithdraw.textContent = "Rút Tiền";
    btnWithdraw.disabled = false;
    btnWithdrawAll.disabled = false;
  }
}
