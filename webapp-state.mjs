/**
 * State + cấu hình + ABI dùng chung của webapp (audit P5).
 *
 * Module LÁ của đồ thị browser: không import module browser nào khác ⇒ không thể tạo vòng import.
 * Mọi state MUTABLE dùng chung giữa các luồng nằm trong MỘT object, và object đó bị `Object.seal`:
 * gán sai tên thành TypeError ngay, thay vì im lặng tạo thuộc tính mới rồi undefined ở chỗ khác.
 *
 * State chỉ MỘT module dùng KHÔNG nằm ở đây (xem `let` đầu module luồng tương ứng) — cố ý, để
 * container chung không phình thành "global bag".
 *
 * Được phục vụ công khai: KHÔNG chứa secret (xem CLAUDE.md, M2).
 */

// ============================================================
// CONFIG (injected by server via window.MORPHO_CONFIG)
// ============================================================
export const CFG = window.MORPHO_CONFIG || {};

export const SERVER_MARKETS = Array.isArray(CFG.markets) ? CFG.markets : [];

export const SERVER_LENDER_ADDRESS = CFG.lenderAddress || null;

export const SERVER_PROXY_RPC_URL = CFG.proxyRpcUrl || "http://127.0.0.1:8545";

// Ngưỡng recovery của presigned-broadcast.mjs (inject từ server). Claim đang
// broadcasting lâu hơn ngưỡng này là dấu hiệu bị thay thế/kẹt — phải hiện UI.
export const CLAIM_RECOVERY_MS = Number(CFG.claimRecoveryMs) > 0 ? Number(CFG.claimRecoveryMs) : 180000;

// R4: ngân sách xác minh tx (TX_VERIFY_ATTEMPTS / TX_VERIFY_DELAY_MS) nay nằm
// trong webapp-logic.mjs cùng với txVisibleOnChain() — xem module đó.

export const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// M2 + Round-4 phụ lục (2026-09-25): KHÔNG hardcode URL kèm API key trong
// file được phục vụ công khai. Danh sách thật do server inject qua
// window.MORPHO_CONFIG.rpcUrls (derive từ PUBLIC_RPC_URLS — 6 endpoint
// key-less đã probe thật; xem webapp-config.mjs). Fallback dưới đây chỉ
// chạy khi server không inject config, và KHÔNG chứa endpoint ankr
// key-less — đã chết (ankr bắt buộc API key, probe 2026-09-25).
export const RPC_URLS = (Array.isArray(CFG.rpcUrls) && CFG.rpcUrls.length > 0)
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
export const MORPHO_ABI = [
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
export const ERC20_ABI = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
];

// ============================================================
// STATE DÙNG CHUNG (mutable) — seal để gán sai tên thành TypeError
// ============================================================
export const state = {
  // STATE
  marketId: null,
  lenderAddress: null,
  publicClient: null,
  walletClient: null,
  currentAccount: null,
  marketParams: null,
  marketData: null,
  positionData: null,
  loanToken: { decimals: 6, symbol: "USDC" },
  collateralToken: { decimals: 18, symbol: "dCOMP" },
  presignedNonce: null,
  // Stepper nonce (2026-09-25): sàn = nonce on-chain lần fetch gần nhất.
  // Chỉnh nonce (±) chỉ được phép sau khi đã có sàn này.
  onChainPendingNonce: null,
  presignedTiers: [],       // { amount: string, amountWei: string, signedTx: string, status: 'pending'|'signing'|'signed'|'error' }
  presignedWithdrawAll: null, // { sharesWei: string, txHash: string, status: 'pending'|'signing'|'signed'|'error' }
};
Object.seal(state);
