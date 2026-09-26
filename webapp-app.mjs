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
import { mainnet } from "viem/chains";
import { getWalletProviderName } from "./webapp-wallet.mjs";
import { SERVER_LENDER_ADDRESS, SERVER_MARKETS, state } from "./webapp-state.mjs";
import { clearSession, getProxyUrl, hideError, renderWalletCompatibility, saveSession, showError, showPresignError, showPresignSuccess, showTxResult, updateAuthUI } from "./webapp-shell.mjs";
import { createRpcClient, fetchAllData, initMarketSwitcher, renderMarketInfo, renderPosition, switchMarket } from "./webapp-overview.mjs";
import { deleteBundle, deleteRungFromBundle, deleteTierFromBundle, fetchExistingBundle, refreshPresignOverview, renderPresignMarketInfo, renderPresignPosition } from "./webapp-presign-bundles.mjs";
import { addPresetTier, addTier, autoFillGas, fetchNonce, onGasInputChange, onNonceStep, readGasInputs, removeTier, renderTierList, saveToServer, setNonceStepperEnabled, signAllTiers, signWithdrawAll, updatePresignWalletUI, updateTierAmount } from "./webapp-presign.mjs";
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
let _listenersAttached = false; // guard against duplicate event listeners

async function connectWallet() {
  try {
    if (!window.ethereum) {
      showError("Vui lòng cài đặt MetaMask hoặc ví tương thích EIP-1193.");
      return;
    }

    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.currentAccount = accounts[0];

    // Ensure mainnet
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId !== "0x1") {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x1" }],
        });
      } catch (switchError) {
        if (switchError.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: "0x1",
              chainName: "Ethereum Mainnet",
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://ethereum-rpc.publicnode.com"],
              blockExplorerUrls: ["https://etherscan.io"],
            }],
          });
        } else {
          throw new Error("Vui lòng chuyển sang Ethereum Mainnet trong ví.");
        }
      }
    }

    state.walletClient = createWalletClient({
      account: state.currentAccount,
      chain: mainnet,
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

    // Attach wallet event listeners once (prevents duplicate firing)
    if (!_listenersAttached) {
      _listenersAttached = true;

      window.ethereum.on("accountsChanged", (accts) => {
        if (accts.length === 0) {
          window.disconnectWallet();
        } else {
          state.currentAccount = accts[0];
          document.getElementById("wallet-address").textContent = state.currentAccount;
        }
      });

      window.ethereum.on("chainChanged", (chainId) => {
        if (chainId === "0x1") {
          // Returned to Ethereum mainnet — refresh market data
          fetchAllData().then(() => {
            renderMarketInfo();
            renderPosition();
          }).catch(err => showError("Lỗi tải lại dữ liệu: " + err.message));
        } else {
          showTxResult("warn", "⚠️ Vui lòng chuyển về Ethereum Mainnet để sử dụng.");
          document.getElementById("btn-withdraw").disabled = true;
          document.getElementById("btn-withdraw-all").disabled = true;
        }
      });

      window.ethereum.on("disconnect", () => {
        window.disconnectWallet();
        showTxResult("error", "🔌 Ví đã ngắt kết nối.");
      });
    }

    hideError();
  } catch (err) {
    showError("Lỗi kết nối ví: " + err.message);
  }
};

function disconnectWallet() {
  state.walletClient = null;
  state.currentAccount = null;
  _listenersAttached = false; // allow re-attach on next connect
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
  // Stepper: mất sàn (nonce on-chain có thể đã đổi khi vắng mặt) ⇒ khoá,
  // bắt bấm "Lấy Nonce" lại sau khi kết nối lại.
  state.onChainPendingNonce = null;
  setNonceStepperEnabled(false);
  // Clear auth
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

  const wallet = getWalletProviderName();
  const PROXY_RPC = getProxyUrl();

  try {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0x1",
        chainName: "Ethereum Proxy Sign",
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: [PROXY_RPC],
        blockExplorerUrls: ["https://etherscan.io"],
      }],
    });
    showPresignSuccess("✅ Đã thêm mạng Proxy! Hãy chuyển sang mạng <b>Ethereum Proxy Sign</b>.");
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
        `<b>Cách thủ công:</b> mở app ví → Settings/Networks → chọn Ethereum Mainnet → thay RPC URL bằng:<br>` +
        `<code>${PROXY_RPC}</code><br>` +
        `<small>(ký xong nhớ đổi lại RPC cũ)</small>`
      );
    } else if (msg.includes("chain ID") || msg.includes("already") || msg.includes("exist")) {
      // Wallet từ chối thêm chainId trùng → hướng dẫn manual
      showPresignError(
        `${wallet === "rabby" ? "Rabby" : "Ví"} không cho thêm chainId=1 trùng lặp.<br><br>` +
        `<b>Cách thủ công:</b><br>` +
        `Vào Settings → Networks → Ethereum → đổi RPC thành:<br>` +
        `<code>${PROXY_RPC}</code><br>` +
        `<small>(ký xong nhớ đổi lại RPC cũ)</small>`
      );
    } else {
      showPresignError(`Lỗi: ${msg}`);
    }
  }
};

// ============================================================
// INIT
// ============================================================
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

  try {
    // Create RPC client
    state.publicClient = await createRpcClient();

    // Fetch all data
    await fetchAllData();

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
    // Populate proxy URL
    const proxyUrlEl = document.getElementById("presign-proxy-url-display");
    if (proxyUrlEl) proxyUrlEl.textContent = getProxyUrl();

    document.getElementById("loading").style.display = "none";
    updateAuthUI();
  } catch (err) {
    document.getElementById("loading").style.display = "none";
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
