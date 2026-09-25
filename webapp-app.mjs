/**
 * Presign / withdraw SPA — script chính của webapp.html.
 *
 * Audit A.1: trước đây khối này nằm INLINE trong webapp.html nên nó là code
 * production DUY NHẤT không được lint (oxlint chỉ quét .mjs) — lỗi no-undef
 * bên trong vẫn parse hợp lệ, chỉ chết lúc người dùng bấm nút. Nó cũng không
 * import được trong test, nên __tests__/webapp.test.mjs phải NHÂN BẢN thủ công
 * các hàm thuần để test được. Giờ nó là module thật: được lint, và các hàm
 * thuần sẽ được test import trực tiếp.
 *
 * Được phục vụ tại /webapp-app.mjs bởi webapp-server.mjs → webapp-handler.mjs.
 * KHÔNG chứa secret: file này phục vụ công khai (xem CLAUDE.md, M2).
 */
    import {
      createPublicClient, createWalletClient, http, custom,
      formatUnits, parseUnits, encodeFunctionData,
    } from "viem";
    import { mainnet } from "viem/chains";
    // Audit A.1b: logic thuần nằm ở webapp-logic.mjs — CÙNG một đoạn code chạy
    // trong browser và trong test (__tests__/webapp.test.mjs), nên không còn bản
    // sao có thể lệch nhau. Route /webapp-logic.mjs do webapp-handler.mjs phục vụ
    // song song với /webapp-app.mjs.
    import {
      TX_VERIFY_ATTEMPTS,
      TX_VERIFY_DELAY_MS,
      wadToPercent,
      shortenAddr,
      broadcastingAgeMinutes,
      isClaimOverdue,
      txVisibleOnChain,
      computeSupplyAssets,
      computeBorrowAssets,
      computeLiquidity,
      computeUtilization,
      computeMaxWithdraw,
      validateWithdraw,
      stepNonce,
    } from "./webapp-logic.mjs";

    // ============================================================
    // CONFIG (injected by server via window.MORPHO_CONFIG)
    // ============================================================
    const CFG = window.MORPHO_CONFIG || {};
    const SERVER_MARKETS = Array.isArray(CFG.markets) ? CFG.markets : [];
    const SERVER_LENDER_ADDRESS = CFG.lenderAddress || null;
    const SERVER_PROXY_RPC_URL = CFG.proxyRpcUrl || "http://127.0.0.1:8545";
    // Ngưỡng recovery của presigned-broadcast.mjs (inject từ server). Claim đang
    // broadcasting lâu hơn ngưỡng này là dấu hiệu bị thay thế/kẹt — phải hiện UI.
    const CLAIM_RECOVERY_MS = Number(CFG.claimRecoveryMs) > 0 ? Number(CFG.claimRecoveryMs) : 180000;

    // R4: ngân sách xác minh tx (TX_VERIFY_ATTEMPTS / TX_VERIFY_DELAY_MS) nay nằm
    // trong webapp-logic.mjs cùng với txVisibleOnChain() — xem module đó.

    const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

    // M2 + Round-4 phụ lục (2026-09-25): KHÔNG hardcode URL kèm API key trong
    // file được phục vụ công khai. Danh sách thật do server inject qua
    // window.MORPHO_CONFIG.rpcUrls (derive từ PUBLIC_RPC_URLS — 6 endpoint
    // key-less đã probe thật; xem webapp-config.mjs). Fallback dưới đây chỉ
    // chạy khi server không inject config, và KHÔNG chứa endpoint ankr
    // key-less — đã chết (ankr bắt buộc API key, probe 2026-09-25).
    const RPC_URLS = (Array.isArray(CFG.rpcUrls) && CFG.rpcUrls.length > 0)
      ? CFG.rpcUrls
      : [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.drpc.org",
        "https://eth-mainnet.public.blastapi.io",
        "https://gateway.tenderly.co/public/mainnet",
        "https://1rpc.io/eth",
        "https://eth.meowrpc.com",
      ];

    // Minimal ABI for Morpho Blue
    const MORPHO_ABI = [
      {
        type: "function", name: "withdraw",
        inputs: [
          { name: "marketParams", type: "tuple", components: [
            { name: "loanToken", type: "address" },
            { name: "collateralToken", type: "address" },
            { name: "oracle", type: "address" },
            { name: "irm", type: "address" },
            { name: "lltv", type: "uint256" },
          ]},
          { name: "assets", type: "uint256" },
          { name: "shares", type: "uint256" },
          { name: "onBehalf", type: "address" },
          { name: "receiver", type: "address" },
        ],
        outputs: [{ type: "uint256" }, { type: "uint256" }],
        stateMutability: "nonpayable",
      },
      {
        type: "function", name: "idToMarketParams",
        inputs: [{ type: "bytes32" }],
        outputs: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
        stateMutability: "view",
      },
      {
        type: "function", name: "market",
        inputs: [{ type: "bytes32" }],
        outputs: [
          { name: "totalSupplyAssets", type: "uint128" },
          { name: "totalSupplyShares", type: "uint128" },
          { name: "totalBorrowAssets", type: "uint128" },
          { name: "totalBorrowShares", type: "uint128" },
          { name: "lastUpdate", type: "uint128" },
          { name: "fee", type: "uint128" },
        ],
        stateMutability: "view",
      },
      {
        type: "function", name: "position",
        inputs: [{ type: "bytes32" }, { type: "address" }],
        outputs: [
          { name: "supplyShares", type: "uint256" },
          { name: "borrowShares", type: "uint128" },
          { name: "collateral", type: "uint128" },
        ],
        stateMutability: "view",
      },
    ];

    // ERC20 minimal ABI
    const ERC20_ABI = [
      { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
      { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
      { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
    ];

    // ============================================================
    // STATE
    // ============================================================
    let marketId = null;
    let lenderAddress = null;
    let publicClient = null;
    let walletClient = null;
    let currentAccount = null;

    let marketParams = null;
    let marketData = null;
    let positionData = null;
    let loanToken = { decimals: 6, symbol: "USDC" };
    let collateralToken = { decimals: 18, symbol: "dCOMP" };

    // Auth state
    let sessionToken = sessionStorage.getItem("morpho-session-token") || null;
    let sessionExpiresAt = sessionStorage.getItem("morpho-session-expires") || null;

    // Presign state
    let currentTab = "withdraw";
    let presignedNonce = null;
    // Stepper nonce (2026-09-25): sàn = nonce on-chain lần fetch gần nhất.
    // Chỉnh nonce (±) chỉ được phép sau khi đã có sàn này.
    let onChainPendingNonce = null;
    let presignedTiers = [];       // { amount: string, amountWei: string, signedTx: string, status: 'pending'|'signing'|'signed'|'error' }
    let presignedWithdrawAll = null; // { sharesWei: string, txHash: string, status: 'pending'|'signing'|'signed'|'error' }
    let presignedGas = { maxFeePerGas: null, maxPriorityFeePerGas: null };
    let isSigningInProgress = false;
    // R4: tăng mỗi lần rút — kết quả xác minh của lần rút CŨ không được ghi đè
    // banner của lần rút MỚI.
    let txVerifyToken = 0;

    // ============================================================
    // HELPERS
    // ============================================================
    // wadToPercent / shortenAddr / broadcastingAgeMinutes / isClaimOverdue /
    // txVisibleOnChain nay nằm trong webapp-logic.mjs (A.1b): browser tải chính
    // module đó, và test import đúng nó — không còn hai bản có thể lệch nhau.
    function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
    /**
     * R4 (đã chuyển sang webapp-logic.mjs): giao dịch mà ví trả về hash có thật
     * sự nằm trên chain?
     */
    function showError(msg) {
      const el = document.getElementById("error-banner");
      el.textContent = "❌ " + msg;
      el.style.display = "block";
    }

    function hideError() {
      document.getElementById("error-banner").style.display = "none";
    }

    function showTxResult(type, msg) {
      const el = document.getElementById("tx-result");
      el.style.display = "block";
      el.innerHTML = `<div class="banner ${type}">${msg}</div>`;
    }

    // ============================================================
    // AUTH HELPERS (wallet signature)
    // ============================================================
    function isAuthenticated() {
      if (!sessionToken || !sessionExpiresAt) return false;
      if (Date.now() > parseInt(sessionExpiresAt, 10)) {
        clearSession();
        return false;
      }
      return true;
    }

    function getAuthHeaders() {
      if (!sessionToken) return {};
      return { "Authorization": "Bearer " + sessionToken };
    }

    function saveSession(token, expiresAt) {
      sessionToken = token;
      sessionExpiresAt = new Date(expiresAt).getTime().toString();
      sessionStorage.setItem("morpho-session-token", token);
      sessionStorage.setItem("morpho-session-expires", sessionExpiresAt);
    }

    function clearSession() {
      sessionToken = null;
      sessionExpiresAt = null;
      sessionStorage.removeItem("morpho-session-token");
      sessionStorage.removeItem("morpho-session-expires");
      updateAuthUI();
    }

    function updateAuthUI() {
      const authed = isAuthenticated();
      // Sign-in button
      const btnSignIn = document.getElementById("btn-sign-in");
      if (btnSignIn) {
        if (authed) {
          btnSignIn.textContent = "✅ Đã Xác Thực";
          btnSignIn.disabled = true;
          btnSignIn.className = "btn-outline";
        } else if (currentAccount && currentAccount.toLowerCase() === lenderAddress?.toLowerCase()) {
          btnSignIn.textContent = "🔏 Xác Thực Bằng Ví";
          btnSignIn.disabled = false;
          btnSignIn.className = "btn-primary";
        } else if (currentAccount) {
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

    /**
     * Sign in with wallet: get challenge → personal_sign → submit to server.
     */
    window.signIn = async function () {
      if (!currentAccount) {
        showPresignError("Vui lòng kết nối ví trước.");
        return;
      }
      if (currentAccount.toLowerCase() !== lenderAddress?.toLowerCase()) {
        showPresignError(`Ví đang kết nối (${currentAccount}) không khớp với địa chỉ lender (${lenderAddress}).`);
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
        const signature = await walletClient.signMessage({
          account: currentAccount,
          message: challengeData.message,
        });

        // 3. Submit signature to server
        btnSignIn.textContent = "⏳ Đang xác thực...";
        const authResp = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: currentAccount,
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

        // Refresh existing bundle display if on presign tab
        if (currentTab === "presign") {
          fetchExistingBundle();
        }
      } catch (err) {
        showPresignError("Xác thực thất bại: " + err.message);
        btnSignIn.disabled = false;
        btnSignIn.textContent = "🔏 Xác Thực Bằng Ví";
        btnSignIn.className = "btn-primary";
      }
    };

    window.signOut = function () {
      clearSession();
      showPresignSuccess("✅ Đã đăng xuất.");
    };

    // ============================================================
    // RPC CLIENT
    // ============================================================

    /**
     * Fallback transport — bản rút gọn của server-side round-robin transport.
     * Mỗi request bắt đầu từ URL hiện tại (random lúc khởi tạo).
     * Nếu thất bại → thử URL tiếp theo. Thành công → advance index cho request sau.
     * Không có circuit breaker vì browser session ngắn.
     */
    function fallbackTransport(urls, opts = {}) {
      const { timeout = 15000 } = opts;
      let idx = Math.floor(Math.random() * urls.length); // random start — phân tán tải

      return (config) => {
        const transports = urls.map(url => http(url, { timeout })(config));

        return {
          ...transports[0],
          request: async (args) => {
            let lastError;
            for (let i = 0; i < urls.length; i++) {
              const urlIdx = (idx + i) % urls.length;
              try {
                const result = await transports[urlIdx].request(args);
                idx = (urlIdx + 1) % urls.length; // advance cho request tiếp theo
                return result;
              } catch (err) {
                lastError = err;
              }
            }
            throw lastError;
          },
        };
      };
    }

    async function createRpcClient() {
      const client = createPublicClient({
        chain: mainnet,
        transport: fallbackTransport(RPC_URLS, { timeout: 15000 }),
      });
      // Startup health check — chỉ fail nếu TẤT CẢ URL đều down
      await client.getChainId();
      return client;
    }

    // ============================================================
    // FETCH DATA
    // ============================================================
    async function fetchAllData() {
      // Fetch market params
      const params = await publicClient.readContract({
        address: MORPHO_BLUE,
        abi: MORPHO_ABI,
        functionName: "idToMarketParams",
        args: [marketId],
      });
      marketParams = {
        loanToken: params[0],
        collateralToken: params[1],
        oracle: params[2],
        irm: params[3],
        lltv: params[4],
      };

      // Fetch market state + position + token metadata in parallel
      const [market, position, cToken, lToken] = await Promise.all([
        publicClient.readContract({
          address: MORPHO_BLUE,
          abi: MORPHO_ABI,
          functionName: "market",
          args: [marketId],
        }),
        publicClient.readContract({
          address: MORPHO_BLUE,
          abi: MORPHO_ABI,
          functionName: "position",
          args: [marketId, lenderAddress],
        }),
        publicClient.readContract({
          address: marketParams.collateralToken,
          abi: ERC20_ABI,
          functionName: "decimals",
        }).then(d => publicClient.readContract({
          address: marketParams.collateralToken, abi: ERC20_ABI, functionName: "symbol",
        }).then(s => ({ decimals: d, symbol: s }))).catch(() => ({ decimals: 18, symbol: "?" })),
        publicClient.readContract({
          address: marketParams.loanToken,
          abi: ERC20_ABI,
          functionName: "decimals",
        }).then(d => publicClient.readContract({
          address: marketParams.loanToken, abi: ERC20_ABI, functionName: "symbol",
        }).then(s => ({ decimals: d, symbol: s }))).catch(() => ({ decimals: 6, symbol: "?" })),
      ]);

      marketData = {
        totalSupplyAssets: market[0],
        totalSupplyShares: market[1],
        totalBorrowAssets: market[2],
        totalBorrowShares: market[3],
        lastUpdate: market[4],
        fee: market[5],
      };

      positionData = {
        supplyShares: position[0],
        borrowShares: position[1],
        collateral: position[2],
      };

      collateralToken = cToken;
      loanToken = lToken;

      // Compute derived values
      const supplyAssets = computeSupplyAssets(
        positionData.supplyShares,
        marketData.totalSupplyAssets,
        marketData.totalSupplyShares
      );

      marketData.liquidity = computeLiquidity(marketData.totalSupplyAssets, marketData.totalBorrowAssets);
      marketData.supplyAssets = supplyAssets;
      marketData.utilization = computeUtilization(marketData.totalBorrowAssets, marketData.totalSupplyAssets);
    }

    // ============================================================
    // RENDER
    // ============================================================
    function renderMarketInfo() {
      const liquidity = marketData.liquidity;
      const liquidityClass = liquidity > 0n ? "green" : "red";

      document.getElementById("market-info").innerHTML = [
        row("Collateral", `${shortenAddr(marketParams.collateralToken)} (${collateralToken.symbol})`),
        row("Loan Token", `${shortenAddr(marketParams.loanToken)} (${loanToken.symbol})`),
        row("Oracle", shortenAddr(marketParams.oracle)),
        row("IRM", shortenAddr(marketParams.irm)),
        row("LLTV", wadToPercent(marketParams.lltv)),
        row("Total Supply", formatToken(marketData.totalSupplyAssets, loanToken)),
        row("Total Borrow", formatToken(marketData.totalBorrowAssets, loanToken)),
        row("Liquidity",
          `<span class="value ${liquidityClass}">${formatToken(liquidity, loanToken)}</span>`),
        row("Utilization", wadToPercent(marketData.utilization)),
      ].join("");

      document.getElementById("market-section").style.display = "block";

      // Show liquidity warning if 0
      const warnEl = document.getElementById("liquidity-warning");
      if (liquidity === 0n) {
        warnEl.style.display = "block";
        warnEl.textContent = "⚠️ Market đang 100% utilized. Giao dịch rút tiền sẽ thất bại cho đến khi có thanh khoản.";
      } else {
        warnEl.style.display = "none";
      }
    }

    function renderPosition() {
      const supplyAssets = marketData.supplyAssets;

      document.getElementById("position-info").innerHTML = [
        row("Supply Shares", positionData.supplyShares.toString()),
        row("Supply Assets", formatToken(supplyAssets, loanToken)),
        row("Borrow Shares", positionData.borrowShares.toString()),
        row("Borrow Assets", formatToken(
          computeBorrowAssets(positionData.borrowShares, marketData.totalBorrowAssets, marketData.totalBorrowShares),
          loanToken
        )),
        row("Collateral", formatToken(positionData.collateral, collateralToken)),
      ].join("");

      document.getElementById("position-section").style.display = "block";

      // MAX = min(supplyAssets, liquidity): chỉ rút được tối đa bằng thanh khoản hiện có
      const maxWithdraw = supplyAssets < marketData.liquidity ? supplyAssets : marketData.liquidity;
      document.getElementById("max-withdraw").textContent = formatToken(maxWithdraw, loanToken);
    }

    function row(label, value) {
      return `<div class="row"><span class="label">${label}</span><span class="value">${value}</span></div>`;
    }

    function formatToken(amount, token) {
      return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
    }

    // ============================================================
    // WALLET
    // ============================================================
    let _listenersAttached = false; // guard against duplicate event listeners

    window.connectWallet = async function() {
      try {
        if (!window.ethereum) {
          showError("Vui lòng cài đặt MetaMask hoặc ví tương thích EIP-1193.");
          return;
        }

        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        currentAccount = accounts[0];

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

        walletClient = createWalletClient({
          account: currentAccount,
          chain: mainnet,
          transport: custom(window.ethereum),
        });

        // Update UI
        document.getElementById("wallet-status").style.display = "none";
        document.getElementById("wallet-connected").style.display = "block";
        document.getElementById("wallet-address").textContent = currentAccount;

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
              currentAccount = accts[0];
              document.getElementById("wallet-address").textContent = currentAccount;
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

    window.disconnectWallet = function() {
      walletClient = null;
      currentAccount = null;
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
      onChainPendingNonce = null;
      setNonceStepperEnabled(false);
      // Clear auth
      clearSession();
      updateAuthUI();
    };

    // ============================================================
    // TAB SWITCHING
    // ============================================================
    window.switchTab = function(tab) {
      currentTab = tab;
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
      document.querySelector(`.tab[data-tab="${tab}"]`).classList.add("active");
      document.getElementById(`tab-${tab}`).classList.add("active");

      // Khi chuyển sang tab Ký Trước, render presign data nếu đã có
      if (tab === "presign" && marketData) {
        renderPresignMarketInfo();
        renderPresignPosition();
        renderWalletCompatibility();
        updatePresignWalletUI();
        fetchExistingBundle();
        refreshPresignOverview();
      }
    };

    // ============================================================
    // MARKET SWITCHER (>1 market)
    // ============================================================
    function initMarketSwitcher() {
      const wrap = document.getElementById("market-switcher-wrap");
      const select = document.getElementById("market-switcher");
      if (!wrap || !select || SERVER_MARKETS.length <= 1) return;
      const short = (id) => `${id.slice(0, 10)}…${id.slice(-4)}`;
      select.innerHTML = SERVER_MARKETS.map((m) =>
        `<option value="${m.id}"${m.id === marketId ? " selected" : ""}>${short(m.id)}</option>`
      ).join("");
      wrap.style.display = "block";
    }

    window.switchMarket = function(id) {
      if (!id || id === marketId) return;
      location.search = `?market=${encodeURIComponent(id)}`;
    };

    // ============================================================
    // PRESIGN OVERVIEW (mọi market)
    // ============================================================
    async function refreshPresignOverview() {
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

    function getProxyUrl() {
      return SERVER_PROXY_RPC_URL;
    }

    // ============================================================
    // PRESIGN: WALLET COMPATIBILITY
    // ============================================================
    function getWalletProviderName() {
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

    function getCompatibilityMessage() {
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

    function renderWalletCompatibility() {
      const banner = document.getElementById("presign-wallet-banner");
      const compat = getCompatibilityMessage();
      banner.style.display = "block";
      banner.innerHTML = compat.msg;
      banner.className = "banner info";
    }

    function updatePresignWalletUI() {
      const statusEl = document.getElementById("presign-wallet-status");
      const connectedEl = document.getElementById("presign-wallet-connected");
      if (currentAccount) {
        statusEl.style.display = "none";
        connectedEl.style.display = "block";
        document.getElementById("presign-wallet-address").textContent = currentAccount;
        document.getElementById("btn-fetch-nonce").disabled = false;
        document.getElementById("btn-auto-gas").disabled = false;
        if (presignedTiers.length > 0 && presignedNonce !== null && presignedGas.maxFeePerGas) {
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

    // ============================================================
    // PRESIGN: ADD PROXY NETWORK TO WALLET
    // ============================================================
    window.addProxyNetwork = async function() {
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
    // PRESIGN: NONCE & GAS
    // ============================================================
    window.fetchNonce = async function() {
      if (!currentAccount) {
        showPresignError("Vui lòng kết nối ví trước.");
        return;
      }
      try {
        document.getElementById("btn-fetch-nonce").disabled = true;
        document.getElementById("btn-fetch-nonce").textContent = "⏳ Đang lấy...";
        const prevNonce = presignedNonce;
        presignedNonce = await publicClient.getTransactionCount({
          address: currentAccount,
          blockTag: "pending",
        });
        document.getElementById("presign-nonce").textContent = presignedNonce;
        document.getElementById("btn-fetch-nonce").textContent = "✅ Đã lấy Nonce";
        // Stepper: có sàn rồi ⇒ cho chỉnh nonce bằng ± (không bao giờ xuống
        // dưới sàn — xem stepNonce trong webapp-logic.mjs).
        onChainPendingNonce = presignedNonce;
        setNonceStepperEnabled(true);
        // Nonce mới → chữ ký cũ (cùng nonce cũ) không còn hợp lệ
        if (prevNonce !== null && prevNonce !== presignedNonce) {
          let invalidated = false;
          for (const tier of presignedTiers) {
            if (tier.status === "signed") {
              tier.status = "pending";
              tier.txHash = null;
              tier.amountWei = null;
              invalidated = true;
            }
          }
          if (presignedWithdrawAll && presignedWithdrawAll.status === "signed") {
            presignedWithdrawAll.status = "pending";
            presignedWithdrawAll.txHash = null;
            invalidated = true;
          }
          if (invalidated) {
            document.getElementById("btn-save-server").disabled = true;
            showPresignError("Nonce đã thay đổi. Vui lòng ký lại các giao dịch.");
            renderTierList();
          }
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
    function setNonceStepperEnabled(enabled) {
      document.getElementById("btn-nonce-dec").disabled = !enabled;
      document.getElementById("btn-nonce-inc").disabled = !enabled;
      updateNonceStepperButtons();
    }

    function updateNonceStepperButtons() {
      if (onChainPendingNonce === null || presignedNonce === null) return;
      document.getElementById("btn-nonce-dec").disabled = presignedNonce <= onChainPendingNonce;
    }

    window.onNonceStep = function (delta) {
      const next = stepNonce(presignedNonce, onChainPendingNonce, delta);
      if (next === null || next === presignedNonce) return;
      presignedNonce = next;
      document.getElementById("presign-nonce").textContent = presignedNonce;
      // Nonce mới → chữ ký cũ (ký ở nonce cũ) không còn hợp lệ.
      let invalidated = false;
      for (const tier of presignedTiers) {
        if (tier.status === "signed") {
          tier.status = "pending";
          tier.txHash = null;
          tier.amountWei = null;
          invalidated = true;
        }
      }
      if (presignedWithdrawAll && presignedWithdrawAll.status === "signed") {
        presignedWithdrawAll.status = "pending";
        presignedWithdrawAll.txHash = null;
        invalidated = true;
      }
      if (invalidated) {
        document.getElementById("btn-save-server").disabled = true;
        showPresignError("Nonce đã thay đổi. Vui lòng ký lại các giao dịch.");
        renderTierList();
      }
      updateNonceStepperButtons();
      updateSignButton();
    };

    window.autoFillGas = async function() {
      try {
        document.getElementById("btn-auto-gas").disabled = true;
        document.getElementById("btn-auto-gas").textContent = "⏳ Đang lấy...";
        const [priorityFee, block] = await Promise.all([
          publicClient.estimateMaxPriorityFeePerGas(),
          publicClient.getBlock({ blockTag: "latest" }),
        ]);
        const baseFee = block.baseFeePerGas ?? 10_000_000_000n;
        // 2x multiplier để đảm bảo inclusion sau này
        presignedGas.maxPriorityFeePerGas = priorityFee * 2n;
        presignedGas.maxFeePerGas = (baseFee * 2n) + presignedGas.maxPriorityFeePerGas;
        // Fill input fields (user có thể chỉnh sửa sau)
        document.getElementById("presign-gas-maxfee").value =
          formatUnits(presignedGas.maxFeePerGas, 9);
        document.getElementById("presign-gas-priority").value =
          formatUnits(presignedGas.maxPriorityFeePerGas, 9);
        document.getElementById("btn-auto-gas").textContent = "✅ Đã lấy Gas";
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
    function readGasInputs() {
      const maxFeeVal = parseFloat(document.getElementById("presign-gas-maxfee").value);
      const priorityVal = parseFloat(document.getElementById("presign-gas-priority").value);
      if (!isNaN(maxFeeVal) && maxFeeVal > 0) {
        presignedGas.maxFeePerGas = parseUnits(String(maxFeeVal), 9);
      }
      if (!isNaN(priorityVal) && priorityVal > 0) {
        presignedGas.maxPriorityFeePerGas = parseUnits(String(priorityVal), 9);
      }
    }
    window.readGasInputs = readGasInputs;

    function onGasInputChange() {
      const maxFeeVal = parseFloat(document.getElementById("presign-gas-maxfee").value);
      const priorityVal = parseFloat(document.getElementById("presign-gas-priority").value);
      if (!isNaN(maxFeeVal) && maxFeeVal > 0) {
        presignedGas.maxFeePerGas = parseUnits(String(maxFeeVal), 9);
      } else {
        presignedGas.maxFeePerGas = null;
      }
      if (!isNaN(priorityVal) && priorityVal > 0) {
        presignedGas.maxPriorityFeePerGas = parseUnits(String(priorityVal), 9);
      } else {
        presignedGas.maxPriorityFeePerGas = null;
      }
      // Reset signed state if gas changed (cần ký lại)
      let gasChanged = false;
      if (presignedTiers.some(t => t.status === "signed")) {
        // Reset all signed tiers back to pending
        for (const tier of presignedTiers) {
          if (tier.status === "signed") {
            tier.status = "pending";
            tier.txHash = null;
            tier.amountWei = null;
          }
        }
        document.getElementById("btn-save-server").disabled = true;
        gasChanged = true;
      }
      if (presignedWithdrawAll && presignedWithdrawAll.status === "signed") {
        presignedWithdrawAll.status = "pending";
        presignedWithdrawAll.txHash = null;
        document.getElementById("btn-save-server").disabled = true;
        gasChanged = true;
      }
      if (gasChanged) {
        showPresignError("Gas đã thay đổi. Vui lòng ký lại các giao dịch.");
        renderTierList();
      }
      updateSignButton();
    }
    window.onGasInputChange = onGasInputChange;

    function updateSignButton() {
      const btn = document.getElementById("btn-sign-all");
      if (currentAccount && presignedNonce !== null && presignedGas.maxFeePerGas && presignedTiers.length > 0) {
        btn.disabled = false;
      } else {
        btn.disabled = true;
      }
      // Enable/disable nút rút toàn bộ shares
      const btnAll = document.getElementById("btn-sign-withdraw-all");
      if (btnAll) {
        btnAll.disabled = !(currentAccount && presignedNonce !== null && presignedGas.maxFeePerGas);
      }
    }

    // ============================================================
    // PRESIGN: TIER MANAGEMENT
    // ============================================================
    window.addPresetTier = function(amount) {
      // Tránh trùng lặp
      if (presignedTiers.some(t => t.amount === String(amount))) return;
      presignedTiers.push({ amount: String(amount), amountWei: null, signedTx: null, status: "pending" });
      renderTierList();
      updateSignButton();
    };

    window.addTier = function() {
      presignedTiers.push({ amount: "", amountWei: null, signedTx: null, status: "pending" });
      renderTierList();
      updateSignButton();
    };

    window.removeTier = function(index) {
      presignedTiers.splice(index, 1);
      document.getElementById("btn-save-server").disabled = true;
      renderTierList();
      updateSignButton();
    };

    window.updateTierAmount = function(index, value) {
      presignedTiers[index].amount = value;
      // Reset signed state if amount changed (txHash bị vô hiệu vì amount cũ)
      if (presignedTiers[index].status === "signed") {
        presignedTiers[index].txHash = null;
        presignedTiers[index].amountWei = null;
        presignedTiers[index].status = "pending";
        document.getElementById("btn-save-server").disabled = true;
      }
      updateSignButton();
    };

    function renderTierList() {
      const container = document.getElementById("tier-list");
      if (presignedTiers.length === 0) {
        container.innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem">Chưa có mốc nào. Nhấn nút "Thêm Mốc" để thêm mới.</p>';
      } else {
        container.innerHTML = presignedTiers.map((tier, i) => {
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
        presignedTiers.filter(t => t.amount).length;
    }

    // ============================================================
    // PRESIGN: SIGN ALL TIERS
    // ============================================================
    window.signAllTiers = async function() {
      if (isSigningInProgress) return;

      // Validate
      if (!walletClient || !currentAccount) {
        showPresignError("Vui lòng kết nối ví trước.");
        return;
      }
      if (presignedNonce === null) {
        showPresignError("Vui lòng lấy nonce trước.");
        return;
      }
      // Read gas from input fields (user có thể đã chỉnh sửa)
      onGasInputChange();
      if (!presignedGas.maxFeePerGas || !presignedGas.maxPriorityFeePerGas) {
        showPresignError("Vui lòng nhập gas (hoặc nhấn Tự Động Gas).");
        return;
      }
      const validTiers = presignedTiers.filter(t => t.amount && parseFloat(t.amount) > 0);
      if (validTiers.length === 0) {
        showPresignError("Vui lòng thêm ít nhất 1 mốc tiền hợp lệ.");
        return;
      }
      // Multi-nonce race check: nếu market khác đã có bundle HOẠT ĐỘNG cùng
      // nonce này thì market nào trigger trước sẽ broadcast, market còn lại
      // sẽ expired. Đây là pattern chủ đích (không biết trước market nào
      // trigger), nên chỉ cảnh báo + xác nhận, không chặn cứng.
      try {
        const ovResp = await fetch("/api/overview", { headers: { ...getAuthHeaders() } });
        if (ovResp.ok) {
          const ov = await ovResp.json();
          const contenders = (ov.rounds || [])
            .find((rd) => rd.nonce === presignedNonce)?.markets || [];
          const others = contenders.filter((e) => e.id !== marketId && (e.status === "pending" || e.status === "broadcasting"));
          if (others.length > 0) {
            const okToRace = confirm(
              `Nonce ${presignedNonce} đã có bundle ở market khác (${others.map((e) => e.id.slice(0, 10) + "…").join(", ")}).\n\n` +
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

      for (let i = 0; i < presignedTiers.length; i++) {
        const tier = presignedTiers[i];
        if (!tier.amount || parseFloat(tier.amount) <= 0) continue;

        tier.status = "signing";
        renderTierList();
        progressText.textContent = `Đang ký ${signed + 1}/${total}: ${tier.amount} USDC...`;
        progressFill.style.width = `${((signed) / total) * 100}%`;

        try {
          const assets = parseUnits(tier.amount, loanToken.decimals);
          const calldata = encodeFunctionData({
            abi: MORPHO_ABI,
            functionName: "withdraw",
            args: [marketParams, assets, 0n, lenderAddress, currentAccount],
          });

          // sendTransaction → MetaMask ký + gửi eth_sendRawTransaction đến RPC
          // Proxy trả về txHash thật (keccak256 của signedTx) để match tier sau này
          const txHash = await walletClient.sendTransaction({
            to: MORPHO_BLUE,
            data: calldata,
            value: 0n,
            nonce: presignedNonce,
            gas: 200000n,
            maxFeePerGas: presignedGas.maxFeePerGas,
            maxPriorityFeePerGas: presignedGas.maxPriorityFeePerGas,
            chain: mainnet,
            account: currentAccount,
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
    window.signWithdrawAll = async function() {
      if (isSigningInProgress) return;

      // Validate
      if (!walletClient || !currentAccount) {
        showPresignError("Vui lòng kết nối ví trước.");
        return;
      }
      if (presignedNonce === null) {
        showPresignError("Vui lòng lấy nonce trước.");
        return;
      }
      onGasInputChange();
      if (!presignedGas.maxFeePerGas || !presignedGas.maxPriorityFeePerGas) {
        showPresignError("Vui lòng nhập gas (hoặc nhấn Tự Động Gas).");
        return;
      }

      // Re-fetch position để có supplyShares mới nhất
      try {
        const position = await publicClient.readContract({
          address: MORPHO_BLUE,
          abi: MORPHO_ABI,
          functionName: "position",
          args: [marketId, lenderAddress],
        });
        positionData.supplyShares = position[0];
      } catch {
        // Fall back to cached value — nếu không có thì báo lỗi
      }

      const shares = positionData.supplyShares;
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
          args: [marketParams, 0n, shares, lenderAddress, currentAccount],
        });

        const txHash = await walletClient.sendTransaction({
          to: MORPHO_BLUE,
          data: calldata,
          value: 0n,
          nonce: presignedNonce,
          gas: 200000n,
          maxFeePerGas: presignedGas.maxFeePerGas,
          maxPriorityFeePerGas: presignedGas.maxPriorityFeePerGas,
          chain: mainnet,
          account: currentAccount,
        });

        presignedWithdrawAll = {
          sharesWei: shares.toString(),
          txHash: txHash,
          status: "signed",
        };

        btn.textContent = "✅ Đã Ký";
        statusEl.innerHTML = '<span style="color:var(--green)">✅ Đã ký giao dịch rút toàn bộ shares thành công.</span>';
        document.getElementById("btn-save-server").disabled = false;
      } catch (err) {
        presignedWithdrawAll = { status: "error", error: err.message };
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
      const signedTiers = presignedTiers.filter(t => t.status === "signed");
      // Gửi metadata (không signedTx) — proxy sẽ ghép với signed tx đã capture
      const tiers = signedTiers.map((tier) => ({
        amount: tier.amount,
        amountWei: tier.amountWei,
        amountFormatted: `${tier.amount} ${loanToken.symbol}`,
        label: `${tier.amount} ${loanToken.symbol}`,
        txHash: tier.txHash,       // match với signedTx trong proxy
      }));

      // Append withdraw-all-shares entry nếu đã ký
      if (presignedWithdrawAll && presignedWithdrawAll.status === "signed") {
        tiers.push({
          type: "all-shares",
          sharesWei: presignedWithdrawAll.sharesWei,
          amountWei: "0",
          amountFormatted: "Toàn bộ shares",
          label: "Rút toàn bộ shares",
          txHash: presignedWithdrawAll.txHash,
        });
      }

      return {
        tiers,
        morphoBlueAddress: MORPHO_BLUE,
        marketId: marketId,
        lenderAddress: lenderAddress,
        nonce: presignedNonce,
        gas: "200000",
        maxFeePerGas: presignedGas.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: presignedGas.maxPriorityFeePerGas?.toString(),
        loanToken: { symbol: loanToken.symbol, decimals: loanToken.decimals },
      };
    }

    // ============================================================
    // PRESIGN: SAVE TO SERVER
    // ============================================================
    window.saveToServer = async function() {
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

    // ============================================================
    // PRESIGN: UI HELPERS
    // ============================================================
    function showPresignError(msg) {
      const el = document.getElementById("presign-result");
      el.style.display = "block";
      el.innerHTML = `<div class="banner error">❌ ${msg}</div>`;
    }

    function showPresignSuccess(msg) {
      const el = document.getElementById("presign-result");
      el.style.display = "block";
      el.innerHTML = `<div class="banner success">${msg}</div>`;
    }

    function renderPresignMarketInfo() {
      const liquidity = marketData.liquidity;
      const liquidityClass = liquidity > 0n ? "green" : "red";
      document.getElementById("presign-market-info").innerHTML = [
        row("Collateral", `${shortenAddr(marketParams.collateralToken)} (${collateralToken.symbol})`),
        row("Loan Token", `${shortenAddr(marketParams.loanToken)} (${loanToken.symbol})`),
        row("Liquidity", `<span class="value ${liquidityClass}">${formatToken(liquidity, loanToken)}</span>`),
        row("Utilization", wadToPercent(marketData.utilization)),
        row("Total Supply", formatToken(marketData.totalSupplyAssets, loanToken)),
      ].join("");
      document.getElementById("presign-market-section").style.display = "block";
    }

    function renderPresignPosition() {
      const supplyAssets = marketData.supplyAssets;
      document.getElementById("presign-position-info").innerHTML = [
        row("Supply Assets", formatToken(supplyAssets, loanToken)),
        row("Supply Shares", positionData.supplyShares.toString()),
      ].join("");
      document.getElementById("presign-position-section").style.display = "block";
    }

    function renderPresignWithdrawAllInfo() {
      const sharesEl = document.getElementById("presign-supply-shares");
      const assetsEl = document.getElementById("presign-supply-assets");
      if (sharesEl && positionData.supplyShares != null) {
        sharesEl.textContent = positionData.supplyShares.toString();
      }
      if (assetsEl && marketData.supplyAssets != null) {
        assetsEl.textContent = formatToken(marketData.supplyAssets, loanToken);
      }
    }

    // ============================================================
    // PRESIGN: FETCH EXISTING BUNDLE
    // ============================================================
    async function fetchExistingBundle() {
      if (!isAuthenticated()) {
        document.getElementById("presign-existing").style.display = "none";
        return;
      }
      try {
        const resp = await fetch(`/api/presign?market=${encodeURIComponent(marketId)}`, {
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

    window.deleteTierFromBundle = async function(nonce, index) {
      if (!confirm(`Xóa tier #${index + 1} khỏi rung nonce ${nonce}?`)) return;

      try {
        // Bắt buộc kèm nonce: API từ chối (400) khi market có nhiều rung mà thiếu
        // nonce — nếu không, nó sửa rung nonce thấp nhất, có thể khác rung đang xem (F3/R2).
        const resp = await fetch(`/api/presign?market=${encodeURIComponent(marketId)}&nonce=${encodeURIComponent(nonce)}&tier=${index}`, {
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

    window.deleteBundle = async function() {
      if (!confirm("Bạn có chắc muốn xóa toàn bộ bundle đã ký trên server?\n\nHành động này không thể hoàn tác.")) return;

      try {
        const resp = await fetch(`/api/presign?market=${encodeURIComponent(marketId)}`, {
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

    // ============================================================
    // WITHDRAW
    // ============================================================
    window.setMaxAmount = async function() {
      // Re-fetch both market state and position to get fresh data
      // (cached data may be stale if page has been open for a while)
      try {
        const [position, market] = await Promise.all([
          publicClient.readContract({
            address: MORPHO_BLUE,
            abi: MORPHO_ABI,
            functionName: "position",
            args: [marketId, lenderAddress],
          }),
          publicClient.readContract({
            address: MORPHO_BLUE,
            abi: MORPHO_ABI,
            functionName: "market",
            args: [marketId],
          }),
        ]);

        // Update position
        positionData.supplyShares = position[0];

        // Update market state
        marketData.totalSupplyAssets = market[0];
        marketData.totalSupplyShares = market[1];
        marketData.totalBorrowAssets = market[2];
        marketData.totalBorrowShares = market[3];

        // Recompute derived values
        const supplyAssets = computeSupplyAssets(
          positionData.supplyShares,
          marketData.totalSupplyAssets,
          marketData.totalSupplyShares
        );
        const liquidity = computeLiquidity(marketData.totalSupplyAssets, marketData.totalBorrowAssets);

        marketData.supplyAssets = supplyAssets;
        marketData.liquidity = liquidity;

        // MAX = min(supplyAssets, liquidity): thanh khoản thấp hơn số đã cung cấp
        // thì chỉ rút được tối đa bằng thanh khoản.
        const max = computeMaxWithdraw(supplyAssets, liquidity);

        document.getElementById("withdraw-amount").value = formatUnits(max, loanToken.decimals);
        document.getElementById("max-withdraw").textContent = formatToken(max, loanToken);
      } catch {
        // Fallback to cached value if re-fetch fails
        const supplyAssets = marketData.supplyAssets ?? 0n;
        const liquidity = marketData.liquidity ?? 0n;
        const max = computeMaxWithdraw(supplyAssets, liquidity);
        document.getElementById("withdraw-amount").value = formatUnits(max, loanToken.decimals);
        document.getElementById("max-withdraw").textContent = formatToken(max, loanToken);
      }
    };

    window.withdrawAmount = async function() {
      const amountStr = document.getElementById("withdraw-amount").value;
      if (!amountStr || parseFloat(amountStr) <= 0) {
        showError("Vui lòng nhập số lượng cần rút.");
        return;
      }

      const assets = parseUnits(amountStr, loanToken.decimals);

      // Client-side validation: catch obvious errors before sending on-chain.
      // Phép kiểm tra nằm ở webapp-logic.mjs (A.1b) nên test import đúng code
      // này — chỉ phần hiển thị (kèm số tiền đã format) ở lại đây.
      const check = validateWithdraw({
        assets,
        supplyAssets: marketData.supplyAssets,
        liquidity: marketData.liquidity,
      });
      if (!check.valid) {
        if (check.reason === "over_balance") {
          showError(
            `Số lượng vượt quá số dư có thể rút (${formatToken(marketData.supplyAssets, loanToken)}).`
          );
        } else if (check.reason === "over_liquidity") {
          showError(
            `Thanh khoản market không đủ. Chỉ có ${formatToken(marketData.liquidity, loanToken)} khả dụng.`
          );
        } else {
          showError("Số lượng rút không thể bằng 0.");
        }
        return;
      }

      await doWithdraw(assets, 0n);
    };

    window.withdrawAll = async function() {
      const shares = positionData.supplyShares;
      if (shares === 0n) {
        showError("Bạn không có supply shares để rút.");
        return;
      }

      // Re-fetch position to get up-to-date supply data
      try {
        const position = await publicClient.readContract({
          address: MORPHO_BLUE,
          abi: MORPHO_ABI,
          functionName: "position",
          args: [marketId, lenderAddress],
        });
        positionData.supplyShares = position[0];
        const supplyAssets = computeSupplyAssets(
          positionData.supplyShares,
          marketData.totalSupplyAssets,
          marketData.totalSupplyShares
        );
        marketData.supplyAssets = supplyAssets;
      } catch {
        // Continue with cached data if refresh fails
      }

      const supplyAssets = marketData.supplyAssets;

      // Warn if market liquidity < supply assets (partial withdrawal may occur)
      if (marketData.liquidity < supplyAssets) {
        const confirmMsg =
          `⚠️ Thanh khoản thị trường chỉ có ${formatToken(marketData.liquidity, loanToken)}, ` +
          `thấp hơn vị thế ${formatToken(supplyAssets, loanToken)} của bạn.\n\n` +
          `Giao dịch có thể chỉ rút được một phần hoặc thất bại.\n\n` +
          `Tiếp tục?`;
        if (!confirm(confirmMsg)) return;
      }

      // Confirm
      const confirmMsg =
        `Bạn sắp rút TOÀN BỘ vị thế:\n\n` +
        `${formatToken(supplyAssets, loanToken)}\n` +
        `(${shares.toString()} shares)\n\n` +
        `Tiền sẽ được gửi về ví: ${currentAccount}\n\n` +
        `Xác nhận?`;

      if (!confirm(confirmMsg)) return;

      await doWithdraw(0n, shares);
    };

    async function doWithdraw(assets, shares) {
      if (!walletClient || !currentAccount) {
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
        const { request } = await publicClient.simulateContract({
          address: MORPHO_BLUE,
          abi: MORPHO_ABI,
          functionName: "withdraw",
          args: [marketParams, assets, shares, lenderAddress, currentAccount],
          account: currentAccount,
        });

        btnWithdraw.textContent = "⏳ Chờ MetaMask xác nhận...";

        // Step 2: Write
        const hash = await walletClient.writeContract(request);

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
        txVisibleOnChain(publicClient, hash).then((visible) => {
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

    // ============================================================
    // INIT
    // ============================================================
    async function init() {
      // Only accept an explicit market from the server allow-list. Links from
      // notifications can therefore select a market without trusting arbitrary
      // URL input.
      const requestedMarket = new URLSearchParams(location.search).get("market")?.toLowerCase();
      marketId = SERVER_MARKETS.find((market) => market.id === requestedMarket)?.id || SERVER_MARKETS[0]?.id || null;
      lenderAddress = SERVER_LENDER_ADDRESS;

      if (!marketId || !lenderAddress) {
        document.getElementById("loading").style.display = "none";
        showError("Thiếu market hoặc lender address. Kiểm tra cấu hình server (.env).");
        return;
      }

      try {
        // Create RPC client
        publicClient = await createRpcClient();

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
      }
    }

    // Handle potential MetaMask not injected yet
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }

  