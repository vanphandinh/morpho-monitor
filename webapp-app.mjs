/**
 * Presign / withdraw SPA — module khởi động của webapp.html (audit P5).
 *
 * ĐỈNH của đồ thị browser: import mọi module luồng, và là nơi DUY NHẤT gán `window.*`
 * (test ghim — mọi `on*` trong webapp.html phải trỏ tới một hàm có thật). Nhờ vậy không
 * module nào lặng lẽ định nghĩa lại một handler mà test còn xanh.
 *
 *   webapp-state.mjs            state + cấu hình + ABI (lá)
 *   webapp-shell.mjs            banner DOM, session, UI tài khoản
 *   webapp-overview.mjs         tab tổng quan: RPC, market/position, chuyển market
 *   webapp-presign-bundles.mjs  đọc/xoá bundle đã ký sẵn
 *   webapp-presign.mjs          tab ký sẵn: nonce/gas/mốc/ký/lưu
 *   webapp-withdraw.mjs         tab rút tiền + xác minh tx
 *
 * Được phục vụ tại /webapp-app.mjs bởi webapp-server.mjs → webapp-handler.mjs.
 * KHÔNG chứa secret: file này phục vụ công khai (xem CLAUDE.md, M2).
 */

import { createWalletClient, custom } from "viem";
import { getWalletProviderName } from "./webapp-wallet.mjs";
import { esc } from "./webapp-render.mjs";
import { CHAIN, CHAIN_HEX, CHAIN_ID, CHAIN_NAME, EXPLORER_URL, MORPHO_BLUE, NATIVE_CURRENCY, RPC_URLS, SERVER_LENDER_ADDRESS, SERVER_MARKETS, state } from "./webapp-state.mjs";
import { clearSession, getProxyUrl, hideError, renderRpcVerifiedNote, renderWalletCompatibility, saveSession, showError, showPresignError, showPresignSuccess, showTxResult, updateAuthUI } from "./webapp-shell.mjs";
import { createRpcClient, fetchAllData, initMarketSwitcher, renderMarketInfo, renderPosition, switchMarket } from "./webapp-overview.mjs";
import { deleteBundle, deleteRungFromBundle, deleteTierFromBundle, fetchExistingBundle, refreshPresignOverview, renderPresignMarketInfo, renderPresignPosition } from "./webapp-presign-bundles.mjs";
import { addPresetTier, addTier, autoFillGas, fetchNonce, noteActiveAccount, onGasInputChange, onNonceStep, readGasInputs, removeTier, renderTierList, saveToServer, setNonceStepperEnabled, signAllTiers, signWithdrawAll, syncNonceStepper, updatePresignWalletUI, updateTierAmount } from "./webapp-presign.mjs";
import { setMaxAmount, withdrawAll, withdrawAmount } from "./webapp-withdraw.mjs";

// Presign state
let currentTab = "withdraw";

/**
 * Sign in with wallet: get challenge → personal_sign → submit to server.
 */
async function signIn() {
  if (!state.currentAccount) {
    showPresignError("Vui lòng kết nối ví trước.");
    return;
  }
  if (state.currentAccount.toLowerCase() !== state.lenderAddress?.toLowerCase()) {
    showPresignError(`Ví đang kết nối (${state.currentAccount}) không khớp với địa chỉ lender (${state.lenderAddress}).`);
    return;
  }

  const btnSignIn = document.getElementById("btn-sign-in");
  btnSignIn.disabled = true;
  btnSignIn.textContent = "⏳ Đang lấy challenge...";

  try {
    // 1. Get challenge from server
    const challengeResp = await fetch("/api/challenge");
    const challengeData = await challengeResp.json();
    if (!challengeData.ok) {
      throw new Error(challengeData.error || "Failed to get challenge");
    }

    // 2. Sign challenge with wallet
    btnSignIn.textContent = "⏳ Vui lòng ký trong ví...";
    const signature = await state.walletClient.signMessage({
      account: state.currentAccount,
      message: challengeData.message,
    });

    // 3. Submit signature to server
    btnSignIn.textContent = "⏳ Đang xác thực...";
    const authResp = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: state.currentAccount,
        signature,
        challenge: challengeData.challenge,
      }),
    });
    const authData = await authResp.json();

    if (!authData.ok) {
      throw new Error(authData.error || "Authentication failed");
    }

    // 4. Save session
    saveSession(authData.token, authData.expiresAt);
    updateAuthUI();
    showPresignSuccess("✅ Xác thực thành công! Bạn có thể sử dụng các chức năng bảo mật.");

    // Auth vừa chuyển từ "chưa" sang "có": MỌI mục auth-gated của tab Ký Trước giờ mới đọc được.
    // Trước fix chỉ có ladder bundle được đọc ⇒ "Tổng Quan Presign (mọi market)" nằm `display:none`
    // cho tới khi người dùng chuyển tab hoặc F5 (triệu chứng 2026-09-26: "phải refresh lại webapp
    // mới xuất hiện"), vì chỉ `switchTab`/`init` mới gọi `refreshPresignOverview()`.
    // Vẫn gate theo tab đang mở: nút xác thực nằm TRONG tab Ký Trước, và đứng ở tab khác thì việc
    // đọc bundle là vô nghĩa (hợp đồng cũ vẫn giữ — xem `__tests__/webapp-bundle-visibility.test.mjs`).
    if (currentTab === "presign") {
      fetchExistingBundle();
      refreshPresignOverview();
    }
  } catch (err) {
    showPresignError("Xác thực thất bại: " + err.message);
    btnSignIn.disabled = false;
    btnSignIn.textContent = "🔏 Xác Thực Bằng Ví";
    btnSignIn.className = "btn-primary";
  }
};

function signOut() {
  clearSession();
  // Đối xứng với `signIn()`: mất phiên ⇒ mọi mục auth-gated phải ẨN lại ngay, không để dữ liệu
  // của phiên vừa hết nằm nguyên trên màn hình. Cả hai hàm tự early-return + ẩn khi chưa xác thực
  // nên ở đây KHÔNG có request nào đi ra.
  refreshPresignOverview();
  fetchExistingBundle();
  showPresignSuccess("✅ Đã đăng xuất.");
};

// ============================================================
// RPC CLIENT
// ============================================================

// ============================================================
// WALLET
// ============================================================
let walletHandlers = null; // bộ handler ví đang gắn — giữ tham chiếu để GỠ trước khi gắn lại
// Provider mà bộ handler ở trên đã gắn vào. Cần nhớ để (a) không gắn lại mỗi lần kết nối — ví không
// hỗ trợ `removeListener` sẽ cộng dồn handler — và (b) gỡ đúng provider cũ nếu `window.ethereum` đổi.
let walletHandlersProvider = null;

// ============================================================
// WALLET REMEMBER (refresh không phải bấm "Kết Nối Ví" lại)
// ============================================================
const WALLET_ACCOUNT_KEY = "morpho-wallet-account";

/** Ghi nhớ ví đã kết nối (lowercase) để lần mở trang sau tự khôi phục im lặng. */
function rememberWalletAccount(account) {
  try { localStorage.setItem(WALLET_ACCOUNT_KEY, String(account).toLowerCase()); } catch { /* storage bị chặn — bỏ qua */ }
}

/** Quên ví đã nhớ — CHỈ khi người dùng chủ động bấm "Ngắt Kết Nối" (sự kiện ví không xoá). */
function forgetWalletAccount() {
  try { localStorage.removeItem(WALLET_ACCOUNT_KEY); } catch { /* storage bị chặn — bỏ qua */ }
}

/** Địa chỉ đã ghi nhớ; `null` khi chưa từng kết nối hoặc storage bị chặn. */
function rememberedWalletAccount() {
  try { return localStorage.getItem(WALLET_ACCOUNT_KEY) || null; } catch { return null; }
}

/**
 * Gắn bộ handler ví — IDEMPOTENT theo provider: gọi bao nhiêu lần cho cùng một `window.ethereum`
 * cũng chỉ còn MỘT bộ (kết nối thủ công + khôi phục tự động không gắn trùng).
 *
 * Cờ `_listenersAttached` cũ chỉ chặn gắn trùng trong một lượt, còn `disconnectWallet()` reset cờ
 * mà không `removeListener` ⇒ mỗi lần kết nối lại cộng thêm một bộ handler và một sự kiện ví chạy
 * teardown nhiều lần (chẩn đoán 2026-11-15).
 */
function attachWalletListeners() {
  if (!window.ethereum) return;
  if (walletHandlers && walletHandlersProvider === window.ethereum) return;
  detachWalletListeners();

  walletHandlers = {
    accountsChanged: (accts) => {
      const accounts = Array.isArray(accts) ? accts : [];
      // Mảng rỗng KHÔNG đủ tin cậy để coi là "người dùng đã ngắt kết nối": MetaMask bắn nó ngay
      // sau khi trả hash (xem `webapp-presign.mjs`). Hỏi lại provider trước khi xoá state ví
      if (accounts.length === 0) {
        void verifyWalletAuthorization("accountsChanged");
        return;
      }
      adoptWalletAccount(accounts[0]);
    },

    chainChanged: (chainId) => {
      if (String(chainId).toLowerCase() === CHAIN_HEX) {
        // Returned to the configured chain — mở lại nút rút nếu ví còn kết nối. Nhánh sai
        // chain bên dưới khoá chúng; trước đây quay lại chain đúng vẫn kẹt khoá tới khi bấm
        // "Kết Nối Ví" lần nữa (giờ lộ ra ở đường auto-connect với ví đang ở chain khác).
        if (state.currentAccount) {
          document.getElementById("btn-withdraw").disabled = false;
          document.getElementById("btn-withdraw-all").disabled = false;
          document.getElementById("btn-max").disabled = false;
        }
        // refresh market data
        fetchAllData().then(() => {
          renderMarketInfo();
          renderPosition();
        }).catch(err => showError("Lỗi tải lại dữ liệu: " + err.message));
      } else {
        showTxResult("warn", `⚠️ Vui lòng chuyển về ${esc(CHAIN_NAME || `chain ${CHAIN_ID}`)} để sử dụng.`);
        document.getElementById("btn-withdraw").disabled = true;
        document.getElementById("btn-withdraw-all").disabled = true;
      }
    },

    disconnect: () => {
      // EIP-1193: provider mất kết nối tới chain — với MetaMask điều này cũng xảy ra khi RPC của
      // ví chớp, không chỉ khi người dùng ngắt. Cùng luật với `accountsChanged([])`.
      void verifyWalletAuthorization("disconnect");
    },
  };

  walletHandlersProvider = window.ethereum;
  for (const [event, handler] of Object.entries(walletHandlers)) {
    window.ethereum.on(event, handler);
  }
}

/** Gỡ bộ handler ví hiện tại (nếu có) — không đụng state/phiên. */
function detachWalletListeners() {
  if (!walletHandlers) return;
  const provider = walletHandlersProvider;
  if (provider?.removeListener) {
    for (const [event, handler] of Object.entries(walletHandlers)) {
      provider.removeListener(event, handler);
    }
  }
  walletHandlers = null;
  walletHandlersProvider = null;
}

/**
 * Xác minh lại quyền tài khoản sau một sự kiện ví — TRƯỚC khi phá state (chẩn đoán 2026-11-15).
 *
 * `accountsChanged([])` / `disconnect` không đủ tin cậy: MetaMask bắn chúng quanh lúc ký và khi
 * RPC của ví chớp. Hỏi lại `eth_accounts` (KHÔNG popup):
 *   - còn tài khoản ⇒ sự kiện là nhiễu, giữ nguyên ví + phiên;
 *   - rỗng thật    ⇒ khoá ví/nonce (guard giữa lượt ký vẫn phải thấy `currentAccount = null`),
 *                    nhưng KHÔNG xoá phiên xác thực và KHÔNG quên ví đã nhớ: phiên HMAC 24h độc
 *                    lập với việc ví còn kết nối, còn key nhớ ví là thứ để F5 tự khôi phục.
 * Không đọc được ⇒ giữ nguyên: thiếu bằng chứng không phải bằng chứng mất ví.
 */
async function verifyWalletAuthorization(trigger) {
  if (!window.ethereum?.request) return;
  let accounts;
  try {
    accounts = await window.ethereum.request({ method: "eth_accounts" });
  } catch {
    return; // ví khoá/không trả lời — một lần đọc hỏng không đủ để phá state
  }
  if (!Array.isArray(accounts)) return;
  if (accounts.length > 0) {
    adoptWalletAccount(accounts[0]);
    return;
  }
  releaseWalletState();
  showTxResult(
    "error",
    trigger === "disconnect"
      ? "🔌 Ví đã ngắt kết nối."
      : "🔌 Ví không còn quyền truy cập tài khoản."
  );
  updateAuthUI();
}

/**
 * Nhận một tài khoản ví đã được xác nhận (kết nối mới, đổi tài khoản, hoặc khôi phục sau sự kiện
 * nhiễu). Dựng lại `walletClient` theo đúng tài khoản — handler cũ chỉ đổi `currentAccount` mà để
 * client cầm tài khoản trước đó.
 */
function adoptWalletAccount(account) {
  if (!account) return;
  // Đổi tài khoản ví ⇒ nonce + sàn của tài khoản cũ vô nghĩa: xoá trước khi vẽ lại UI (chẩn đoán
  // 2026-11-15 — nút `+` từng mở với nonce của tài khoản trước).
  noteActiveAccount(account);
  state.currentAccount = account;
  if (window.ethereum && CHAIN) {
    state.walletClient = createWalletClient({
      account,
      chain: CHAIN,
      transport: custom(window.ethereum),
    });
  }
  rememberWalletAccount(account);
  document.getElementById("wallet-address").textContent = account;
  const presignAddr = document.getElementById("presign-wallet-address");
  if (presignAddr) presignAddr.textContent = account;
  updatePresignWalletUI();
  updateAuthUI();
  // Kết nối lại sau khi mất ví: bật lại stepper nonce ngay, không bắt bấm "Lấy Nonce" (lỗi 2).
  void syncNonceStepper();
}

/**
 * Khôi phục ví sau khi tải lại trang bằng `eth_accounts` — IM LẶNG, không popup như
 * `eth_requestAccounts`. Chỉ chạy khi đã từng kết nối (có key trong localStorage), nên môi
 * trường chưa từng kết nối (kể cả test harness) không phát sinh lời gọi provider nào.
 * Mọi lỗi đều im lặng: hỏng khôi phục không được chặn đường bấm "Kết Nối Ví" thủ công.
 */
async function tryAutoConnectWallet() {
  if (state.currentAccount || !window.ethereum) return;
  if (!CHAIN_HEX || !CHAIN) return;
  const stored = rememberedWalletAccount();
  if (!stored) return;
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    const match = (accounts || []).find((a) => String(a).toLowerCase() === stored.toLowerCase());
    if (!match) return; // ví đã khoá/thu hồi quyền — để người dùng bấm kết nối thủ công
    const chainId = await window.ethereum.request({ method: "eth_chainId" });

    // Người dùng có thể đã bấm "Kết Nối Ví" hoặc "Ngắt Kết Nối" trong lúc chờ ví trả lời
    // (eth_accounts không popup nhưng vẫn là IPC bất đồng bộ). Không kiểm lại thì lượt khôi
    // phục chậm sẽ ghi đè lựa chọn mới: kết nối lại sau khi ngắt, hoặc trả currentAccount về
    // địa chỉ cũ trong khi ví đã chuyển sang tài khoản khác.
    if (state.currentAccount) return;
    if (rememberedWalletAccount()?.toLowerCase() !== stored.toLowerCase()) return;

    state.currentAccount = match;
    state.walletClient = createWalletClient({
      account: state.currentAccount,
      chain: CHAIN,
      transport: custom(window.ethereum),
    });

    document.getElementById("wallet-status").style.display = "none";
    document.getElementById("wallet-connected").style.display = "block";
    document.getElementById("wallet-address").textContent = state.currentAccount;

    // Cùng luật với listener `chainChanged`: sai chain thì KHÔNG mở nút rút — giao dịch gửi
    // lên chain khác chắc chắn hỏng, còn nút mở mời người dùng bấm đúng lỗi đó. Đúng chain
    // mới bật (trước đây auto-connect bật vô điều kiện, khác hẳn đường kết nối thủ công).
    const onConfiguredChain = String(chainId).toLowerCase() === String(CHAIN_HEX).toLowerCase();
    document.getElementById("btn-withdraw").disabled = !onConfiguredChain;
    document.getElementById("btn-withdraw-all").disabled = !onConfiguredChain;
    document.getElementById("btn-max").disabled = !onConfiguredChain;

    attachWalletListeners();
    updatePresignWalletUI();
    updateAuthUI();
    renderWalletCompatibility();
    // Cùng luật với `connectWallet()`: khôi phục ví xong thì stepper nonce phải dùng được ngay.
    await syncNonceStepper();

    if (!onConfiguredChain) {
      // Chỉ cảnh báo — không tự switch chain (người dùng có thể đang ở mạng proxy khác).
      showTxResult("warn", `⚠️ Ví đã kết nối lại nhưng đang ở chain khác — chuyển về ${esc(CHAIN_NAME || `chain ${CHAIN_ID}`)} để ký.`);
    } else {
      hideError();
    }
  } catch { /* im lặng — đường kết nối thủ công vẫn nguyên */ }
}

async function connectWallet() {
  try {
    if (!window.ethereum) {
      showError("Vui lòng cài đặt MetaMask hoặc ví tương thích EIP-1193.");
      return;
    }

    if (!CHAIN_HEX || !CHAIN) {
      throw new Error("Thiếu cấu hình chain trong webapp — kiểm tra config/chains.json.");
    }

    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    // Cùng luật với `adoptWalletAccount()`: kết nối bằng tài khoản KHÁC tài khoản đang giữ nonce
    // (kể cả sau khi đã ngắt) ⇒ xoá nonce/sàn cũ, buộc lấy lại nonce.
    noteActiveAccount(accounts[0]);
    state.currentAccount = accounts[0];
    rememberWalletAccount(state.currentAccount);

    // Ensure the configured chain (metadata injected by the server).
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (String(chainId).toLowerCase() !== CHAIN_HEX) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: CHAIN_HEX }],
        });
      } catch (switchError) {
        if (switchError.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: CHAIN_HEX,
              chainName: CHAIN_NAME,
              nativeCurrency: NATIVE_CURRENCY,
              rpcUrls: RPC_URLS.length > 0 ? [RPC_URLS[0]] : [],
              ...(EXPLORER_URL ? { blockExplorerUrls: [EXPLORER_URL] } : {}),
            }],
          });
        } else {
          throw new Error(`Vui lòng chuyển sang ${CHAIN_NAME || `chain ${CHAIN_ID}`} trong ví.`);
        }
      }
    }

    state.walletClient = createWalletClient({
      account: state.currentAccount,
      chain: CHAIN,
      transport: custom(window.ethereum),
    });

    // Update UI
    document.getElementById("wallet-status").style.display = "none";
    document.getElementById("wallet-connected").style.display = "block";
    document.getElementById("wallet-address").textContent = state.currentAccount;

    // Enable buttons
    document.getElementById("btn-withdraw").disabled = false;
    document.getElementById("btn-withdraw-all").disabled = false;
    document.getElementById("btn-max").disabled = false;

    // Update presign tab wallet UI
    updatePresignWalletUI();
    updateAuthUI();
    renderWalletCompatibility();

    // Gắn listener TRƯỚC khi await RPC: đọc nonce có thể chậm, không được để ví bắn sự kiện trong
    // lúc chưa có handler.
    attachWalletListeners();

    // Kết nối lại: bật stepper nonce ngay (không bắt bấm "Lấy Nonce" lần nữa) — lỗi 2, 2026-11-15.
    await syncNonceStepper();

    hideError();
  } catch (err) {
    showError("Lỗi kết nối ví: " + err.message);
  }
};

/**
 * Khoá mọi UI dùng ví và xoá state ví — KHÔNG đụng phiên xác thực hay ví đã nhớ (hai thứ đó chỉ
 * người dùng chủ động mới được xoá, xem `disconnectWallet()`).
 */
function releaseWalletState() {
  state.walletClient = null;
  state.currentAccount = null;
  document.getElementById("wallet-status").style.display = "block";
  document.getElementById("wallet-connected").style.display = "none";
  document.getElementById("btn-withdraw").disabled = true;
  document.getElementById("btn-withdraw-all").disabled = true;
  document.getElementById("btn-max").disabled = true;
  // Presign tab
  document.getElementById("presign-wallet-status").style.display = "block";
  document.getElementById("presign-wallet-connected").style.display = "none";
  document.getElementById("btn-sign-all").disabled = true;
  document.getElementById("btn-fetch-nonce").disabled = true;
  document.getElementById("btn-auto-gas").disabled = true;
  // Stepper: mất sàn (nonce on-chain có thể đã đổi khi vắng mặt) ⇒ khoá. Đường kết nối lại tự đọc
  // lại sàn im lặng qua `syncNonceStepper()`, nên người dùng không phải bấm "Lấy Nonce" lần nữa.
  state.onChainPendingNonce = null;
  setNonceStepperEnabled(false);
}

/**
 * Người dùng CHỦ ĐỘNG ngắt kết nối (nút "Ngắt Kết Nối").
 *
 * Khác đường sự kiện ví: ở đây mới quên ví đã nhớ (F5 không tự kết nối lại) và bỏ phiên xác thực.
 */
function disconnectWallet() {
  releaseWalletState();
  // Gỡ listener: người dùng đã chủ động ngắt thì một sự kiện ví nhiễu (`accountsChanged([])` rồi
  // `eth_accounts` trả lại tài khoản) không được tự kết nối lại và đảo ngược lựa chọn của họ.
  detachWalletListeners();
  forgetWalletAccount();
  clearSession();
  updateAuthUI();
};

// ============================================================
// TAB SWITCHING
// ============================================================
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${tab}"]`).classList.add("active");
  document.getElementById(`tab-${tab}`).classList.add("active");

  // Khi chuyển sang tab Ký Trước: bundle đã ký nằm ở SERVER (registry), không phụ
  // thuộc RPC công cộng, nên đọc nó LUÔN — không còn `&& state.marketData` (chẩn đoán
  // 2026-09-26: RPC lỗi ⇒ bấm tab nhiều lần vẫn 0 request /api/presign, thông tin
  // bundle/tier "lúc hiện lúc không"). Phần render theo RPC mới cần `marketData`.
  if (tab === "presign") {
    renderWalletCompatibility();
    fetchExistingBundle();
    refreshPresignOverview();
    if (state.marketData) {
      renderPresignMarketInfo();
      renderPresignPosition();
      updatePresignWalletUI();
    }
  }
};

// ============================================================
// PRESIGN: ADD PROXY NETWORK TO WALLET
// ============================================================
async function addProxyNetwork() {
  if (!window.ethereum) {
    showPresignError("Không tìm thấy ví.");
    return;
  }
  if (!CHAIN_HEX) {
    showPresignError("Thiếu cấu hình chain trong webapp — kiểm tra config/chains.json.");
    return;
  }

  const wallet = getWalletProviderName();
  const PROXY_RPC = getProxyUrl();

  try {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CHAIN_HEX,
        chainName: `${CHAIN_NAME || `Chain ${CHAIN_ID}`} Proxy Sign`,
        nativeCurrency: NATIVE_CURRENCY,
        rpcUrls: [PROXY_RPC],
        ...(EXPLORER_URL ? { blockExplorerUrls: [EXPLORER_URL] } : {}),
      }],
    });
    showPresignSuccess(`✅ Đã thêm mạng Proxy! Hãy chuyển sang mạng <b>${esc(CHAIN_NAME || `Chain ${CHAIN_ID}`)} Proxy Sign</b>.`);
    document.getElementById("btn-add-proxy-network").textContent = "✅ Đã Thêm";
    document.getElementById("btn-add-proxy-network").disabled = true;
  } catch (err) {
    const msg = err.message || "";
    if (err.code === 4001) {
      showPresignError("Bạn đã từ chối thêm mạng.");
    } else if (msg.includes("corresponding handler")) {
      // Ví chặn wallet_addEthereumChain ngay ở client (Ambire, một số fork
      // MetaMask) — nút webapp không thể thêm mạng hộ user.
      showPresignError(
        `Ví ${wallet === "ambire" ? "Ambire" : "này"} chặn <code>wallet_addEthereumChain</code> ngay trong app ("doesn't has corresponding handler") — nút webapp không thể thêm mạng hộ bạn.<br><br>` +
        `<b>Cách thủ công:</b> mở app ví → Settings/Networks → chọn ${esc(CHAIN_NAME || `chain ${CHAIN_ID}`)} → thay RPC URL bằng:<br>` +
        `<code>${esc(PROXY_RPC)}</code><br>` +
        `<small>(ký xong nhớ đổi lại RPC cũ)</small>`
      );
    } else if (msg.includes("chain ID") || msg.includes("already") || msg.includes("exist")) {
      // Wallet từ chối thêm chainId trùng → hướng dẫn manual
      showPresignError(
        `${wallet === "rabby" ? "Rabby" : "Ví"} không cho thêm chainId=${CHAIN_ID} trùng lặp.<br><br>` +
        `<b>Cách thủ công:</b><br>` +
        `Vào Settings → Networks → ${esc(CHAIN_NAME || `chain ${CHAIN_ID}`)} → đổi RPC thành:<br>` +
        `<code>${esc(PROXY_RPC)}</code><br>` +
        `<small>(ký xong nhớ đổi lại RPC cũ)</small>`
      );
    } else {
      showPresignError(`Lỗi: ${msg}`);
    }
  }
};

// ============================================================
// INIT — boot tự thử lại qua RPC khác
// ============================================================
// `fallbackTransport` (webapp-overview.mjs) đã tự đảo URL theo từng request:
// một endpoint chết chỉ làm request đó thử URL tiếp theo. Nhưng `init()` cũ
// gọi `createRpcClient()` + `fetchAllData()` đúng MỘT lần: rơi đúng lúc TẤT CẢ
// endpoint cùng chớp (hoặc mạng người dùng chập chờn lúc mở trang) là app rơi
// thẳng vào banner lỗi dù chỉ cần thử lại. Vòng lặp dưới đây thử tối đa
// BOOT_ATTEMPTS lần; mỗi lần dựng client mới với điểm bắt đầu round-robin
// ngẫu nhiên nên lần sau đi vào URL khác lần trước.
export const BOOT_ATTEMPTS = 3;
export const BOOT_RETRY_DELAY_MS = 1200;

function setLoadingText(text) {
  const p = document.querySelector("#loading p");
  if (p) p.textContent = text;
}

/** Chain metadata shown without waiting for RPC health: add-network instructions + security banner. */
function renderProxyConfigMeta() {
  const morphoEl = document.getElementById("morpho-blue-address");
  if (morphoEl) morphoEl.textContent = MORPHO_BLUE || "—";
  const proxyUrlEl = document.getElementById("presign-proxy-url-display");
  if (proxyUrlEl) proxyUrlEl.textContent = getProxyUrl();
  const proxyChainIdEl = document.getElementById("presign-proxy-chain-id");
  if (proxyChainIdEl) proxyChainIdEl.textContent = CHAIN_ID ?? "—";
  const proxySymbolEl = document.getElementById("presign-proxy-symbol");
  if (proxySymbolEl) proxySymbolEl.textContent = NATIVE_CURRENCY?.symbol ?? "—";
  const proxyNameEl = document.getElementById("presign-proxy-name");
  if (proxyNameEl) proxyNameEl.textContent = `${CHAIN_NAME || `Chain ${CHAIN_ID}`} Proxy Sign`;
  const proxyNoteEl = document.getElementById("presign-proxy-chain-note");
  if (proxyNoteEl) proxyNoteEl.textContent = `Sau khi ký xong, đổi lại RPC về mạng ${CHAIN_NAME || `chain ${CHAIN_ID}`} thật.`;
}

async function init() {
  // Only accept an explicit market from the server allow-list. Links from
  // notifications can therefore select a market without trusting arbitrary
  // URL input.
  const requestedMarket = new URLSearchParams(location.search).get("market")?.toLowerCase();
  state.marketId = SERVER_MARKETS.find((market) => market.id === requestedMarket)?.id || SERVER_MARKETS[0]?.id || null;
  state.lenderAddress = SERVER_LENDER_ADDRESS;

  if (!state.marketId || !state.lenderAddress) {
    document.getElementById("loading").style.display = "none";
    showError("Thiếu market hoặc lender address. Kiểm tra cấu hình server (.env).");
    return;
  }
  // Chain metadata phải hiện cả khi RPC công cộng chết: người dùng vẫn cần
  // đúng Chain ID/RPC khi thêm mạng proxy thủ công.
  renderProxyConfigMeta();

  try {
    // Boot thử lại: RPC chớp đúng lúc mở trang thì thử RPC khác thay vì lỗi ngay.
    let bootError = null;
    for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
      try {
        // Create RPC client
        state.publicClient = await createRpcClient();

        // Fetch all data
        await fetchAllData();
        bootError = null;
        break;
      } catch (err) {
        bootError = err;
        // Lệch chain là lỗi cấu hình, retry không thể sửa — dừng ngay thay vì
        // đợi thêm 2 lần × 1.2s rồi vẫn báo cùng lỗi.
        if (err?.code === "CHAIN_ID_MISMATCH") break;
        if (attempt < BOOT_ATTEMPTS) {
          setLoadingText(`⏳ RPC không phản hồi, đang thử RPC khác (lần ${attempt + 1}/${BOOT_ATTEMPTS})...`);
          await new Promise((resolve) => setTimeout(resolve, BOOT_RETRY_DELAY_MS));
        }
      }
    }
    if (bootError) throw bootError;

    // Render
    initMarketSwitcher();
    renderMarketInfo();
    renderPosition();
    document.getElementById("wallet-section").style.display = "block";
    document.getElementById("tx-section").classList.add("visible");

    // Render presign tab data (in background, visible when user switches)
    renderPresignMarketInfo();
    renderPresignPosition();
    document.getElementById("presign-wallet-section").style.display = "block";
    document.getElementById("presign-setup").style.display = "block";
    document.getElementById("presign-tiers").style.display = "block";
    document.getElementById("presign-actions").style.display = "block";
    renderTierList();
    renderWalletCompatibility();
    // Lớp hybrid RPC (2026-09-27): dòng nhỏ "đã kiểm chứng lúc …" — ẩn khi lớp động tắt.
    renderRpcVerifiedNote();

    document.getElementById("loading").style.display = "none";
    updateAuthUI();
    // Khôi phục ví đã kết nối trước đó (không popup, không chặn render). Không await: phần
    // còn lại của UI đã sẵn sàng, ví hiện lên ngay khi provider trả lời.
    tryAutoConnectWallet();
  } catch (err) {
    document.getElementById("loading").style.display = "none";
    // Hết mọi lần thử mà RPC vẫn chết: subtitle không được kẹt ở chữ loading
    // hay tên market mặc định — phải nói rõ là lỗi (quyết định từ review 2026-10-03).
    const subtitle = document.getElementById("market-subtitle");
    if (subtitle) subtitle.textContent = "⚠️ Không tải được dữ liệu market";
    showError("Lỗi tải dữ liệu: " + err.message);
  } finally {
    // Bundle đã ký là dữ liệu SERVER — không phụ thuộc RPC công cộng. Đọc ngay cả
    // khi nhánh RPC ở trên thất bại (chẩn đoán 2026-09-26), nếu không người dùng
    // phải đoán xem mình đã ký gì và rung nào còn sống.
    fetchExistingBundle();
    refreshPresignOverview();
  }
}

// ============================================================
// HỢP ĐỒNG window.* — nơi DUY NHẤT gán window.* trong cả webapp
// (test ghim: mọi `on*` trong webapp.html phải có mặt ở đây, và KHÔNG module nào
//  khác được gán window.*). Thêm handler ⇒ sửa cả HTML và khối này.
// ============================================================
window.signIn = signIn;
window.signOut = signOut;
window.connectWallet = connectWallet;
window.disconnectWallet = disconnectWallet;
window.switchTab = switchTab;
window.switchMarket = switchMarket;
window.addProxyNetwork = addProxyNetwork;
window.fetchNonce = fetchNonce;
window.fetchExistingBundle = fetchExistingBundle;
window.refreshPresignOverview = refreshPresignOverview;
window.onNonceStep = onNonceStep;
window.autoFillGas = autoFillGas;
window.readGasInputs = readGasInputs;
window.onGasInputChange = onGasInputChange;
window.addPresetTier = addPresetTier;
window.addTier = addTier;
window.removeTier = removeTier;
window.updateTierAmount = updateTierAmount;
window.signAllTiers = signAllTiers;
window.signWithdrawAll = signWithdrawAll;
window.saveToServer = saveToServer;
window.deleteTierFromBundle = deleteTierFromBundle;
window.deleteRungFromBundle = deleteRungFromBundle;
window.deleteBundle = deleteBundle;
window.setMaxAmount = setMaxAmount;
window.withdrawAmount = withdrawAmount;
window.withdrawAll = withdrawAll;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
