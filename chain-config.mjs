import fs from "node:fs";
import * as viemChains from "viem/chains";
import { defineChain, getAddress, isAddress } from "viem";

/**
 * Chain registry — nguồn metadata duy nhất cho mỗi deployment.
 *
 * Một bản clone chỉ chọn `CHAIN_ID`; địa chỉ Morpho, explorer, native currency
 * và public RPC mặc định đến từ `config/chains.json`, không hardcode trong code.
 * `RPC_URLS`/`WSS_URLS`/`PUBLIC_RPC_URLS` trong .env vẫn thắng config để operator
 * dùng endpoint riêng có key.
 */

export const CHAIN_CONFIG_MISSING = "CHAIN_CONFIG_MISSING";
export const CHAIN_CONFIG_INVALID = "CHAIN_CONFIG_INVALID";
export const UNSUPPORTED_CHAIN = "UNSUPPORTED_CHAIN";
export const MORPHO_ADDRESS_MISMATCH = "MORPHO_ADDRESS_MISMATCH";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Fallback tối thiểu cho deployment ETH cũ khi host chưa có config/chains.json. */
export const BUILTIN_ETH_CHAIN = Object.freeze({
  id: 1,
  name: "Ethereum",
  viemChain: "mainnet",
  morphoBlueAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  explorerUrl: "https://etherscan.io",
  explorerName: "Etherscan",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  publicRpcUrls: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
  ],
  wsRpcUrls: ["wss://ethereum-rpc.publicnode.com"],
});

function configError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function assertHttpUrl(value, field, index) {
  if (typeof value !== "string" || !value.trim()) {
    throw configError(CHAIN_CONFIG_INVALID, `chains[${index}].${field} must be a non-empty URL`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configError(CHAIN_CONFIG_INVALID, `chains[${index}].${field} is not a valid URL: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw configError(CHAIN_CONFIG_INVALID, `chains[${index}].${field} must be http(s): ${value}`);
  }
  return value.trim();
}

function assertWsUrl(value, field, index) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configError(CHAIN_CONFIG_INVALID, `chains[${index}].${field} is not a valid URL: ${value}`);
  }
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw configError(CHAIN_CONFIG_INVALID, `chains[${index}].${field} must be ws(s): ${value}`);
  }
  return value.trim();
}

function normalizeEntry(entry, index, seen) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw configError(CHAIN_CONFIG_INVALID, `chains[${index}] must be an object`);
  }

  const id = Number(entry.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw configError(CHAIN_CONFIG_INVALID, `chains[${index}].id must be a positive integer`);
  }
  if (seen.has(id)) {
    throw configError(CHAIN_CONFIG_INVALID, `Duplicate chain id: ${id}`);
  }
  seen.add(id);

  if (typeof entry.name !== "string" || !entry.name.trim()) {
    throw configError(CHAIN_CONFIG_INVALID, `chains[${index}].name must be a non-empty string`);
  }
  if (!ADDRESS_RE.test(String(entry.morphoBlueAddress ?? "")) || !isAddress(entry.morphoBlueAddress)) {
    throw configError(
      CHAIN_CONFIG_INVALID,
      `chains[${index}].morphoBlueAddress must be a valid address`
    );
  }

  if (!Array.isArray(entry.publicRpcUrls) || entry.publicRpcUrls.length === 0) {
    throw configError(CHAIN_CONFIG_INVALID, `chains[${index}].publicRpcUrls must be a non-empty array`);
  }
  const publicRpcUrls = entry.publicRpcUrls.map((url, i) =>
    assertHttpUrl(url, `publicRpcUrls[${i}]`, index)
  );

  const wsRpcUrls = Array.isArray(entry.wsRpcUrls)
    ? entry.wsRpcUrls.map((url, i) => assertWsUrl(url, `wsRpcUrls[${i}]`, index))
    : [];

  const explorerUrl = entry.explorerUrl == null
    ? null
    : assertHttpUrl(entry.explorerUrl, "explorerUrl", index);

  let nativeCurrency = null;
  if (entry.nativeCurrency != null) {
    const n = entry.nativeCurrency;
    if (!n || typeof n !== "object" || typeof n.symbol !== "string" || !n.symbol.trim()) {
      throw configError(CHAIN_CONFIG_INVALID, `chains[${index}].nativeCurrency.symbol is required`);
    }
    const decimals = Number(n.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw configError(CHAIN_CONFIG_INVALID, `chains[${index}].nativeCurrency.decimals invalid`);
    }
    nativeCurrency = {
      name: typeof n.name === "string" && n.name.trim() ? n.name : n.symbol,
      symbol: n.symbol,
      decimals,
    };
  }

  return {
    id,
    name: entry.name.trim(),
    viemChain: typeof entry.viemChain === "string" ? entry.viemChain.trim() : "",
    morphoBlueAddress: getAddress(entry.morphoBlueAddress),
    explorerUrl,
    explorerName: typeof entry.explorerName === "string" && entry.explorerName.trim()
      ? entry.explorerName.trim()
      : null,
    nativeCurrency,
    publicRpcUrls,
    wsRpcUrls,
  };
}

/** Parse + validate `config/chains.json`. Pure; no file I/O. */
export function parseChainConfig(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw configError(CHAIN_CONFIG_INVALID, "chains.json must be an object");
  }
  if (parsed.version !== 1) {
    throw configError(CHAIN_CONFIG_INVALID, "chains.json must be { version: 1, chains: [...] }");
  }
  if (!Array.isArray(parsed.chains) || parsed.chains.length === 0) {
    throw configError(CHAIN_CONFIG_INVALID, "chains.json must contain at least one chain");
  }
  const seen = new Set();
  return {
    version: 1,
    chains: parsed.chains.map((entry, index) => normalizeEntry(entry, index, seen)),
  };
}

/** Load and validate `config/chains.json`. */
export function loadChainConfig(filePath = "./config/chains.json") {
  if (!filePath) {
    throw configError(CHAIN_CONFIG_MISSING, "CHAIN_CONFIG_FILE is empty");
  }
  if (!fs.existsSync(filePath)) {
    throw configError(
      CHAIN_CONFIG_MISSING,
      `❌ Không tìm thấy file cấu hình chain: ${filePath}\n` +
        "   → Copy config/chains.json vào thư mục config của deployment.\n" +
        "   → File này chứa metadata công khai, không chứa API key."
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw configError(
      CHAIN_CONFIG_INVALID,
      `Cannot read CHAIN_CONFIG_FILE (${filePath}): ${err.message}`
    );
  }
  return parseChainConfig(parsed);
}

function findViemChain(entry) {
  if (entry.viemChain && viemChains[entry.viemChain]) {
    const candidate = viemChains[entry.viemChain];
    if (candidate && Number(candidate.id) === entry.id) return candidate;
  }
  return Object.values(viemChains).find(
    (candidate) => candidate && Number(candidate?.id) === entry.id
  );
}

/** Resolve one validated config entry to a viem chain + display metadata. */
export function resolveChain(config, chainId) {
  const wanted = Number(chainId);
  const entry = config?.chains?.find((chain) => Number(chain.id) === wanted);
  if (!entry) {
    const available = (config?.chains ?? []).map((chain) => `${chain.id} (${chain.name})`).join(", ");
    throw configError(
      UNSUPPORTED_CHAIN,
      `❌ CHAIN_ID=${chainId} không có trong config/chains.json.\n` +
        `   → Các chain đang có: ${available || "(rỗng)"}\n` +
        "   → Thêm entry vào config/chains.json hoặc đổi CHAIN_ID."
    );
  }

  const knownChain = findViemChain(entry);
  const nativeCurrency = entry.nativeCurrency ?? knownChain?.nativeCurrency;
  if (!nativeCurrency) {
    throw configError(
      CHAIN_CONFIG_INVALID,
      `Chain ${entry.id} thiếu nativeCurrency và không có trong viem/chains`
    );
  }

  const chain = knownChain ?? defineChain({
    id: entry.id,
    name: entry.name,
    nativeCurrency,
    rpcUrls: { default: { http: entry.publicRpcUrls } },
    ...(entry.explorerUrl
      ? { blockExplorers: { default: { name: entry.explorerName ?? "Explorer", url: entry.explorerUrl } } }
      : {}),
  });

  return Object.freeze({
    id: entry.id,
    name: entry.name,
    chain,
    morphoBlueAddress: entry.morphoBlueAddress,
    explorerUrl: entry.explorerUrl ?? chain.blockExplorers?.default?.url ?? null,
    explorerName: entry.explorerName ?? chain.blockExplorers?.default?.name ?? "Explorer",
    nativeCurrency,
    publicRpcUrls: entry.publicRpcUrls,
    wsRpcUrls: entry.wsRpcUrls,
  });
}

export function chainIdHex(chainId) {
  return "0x" + Number(chainId).toString(16);
}

export function txUrl(chain, hash) {
  if (!chain?.explorerUrl || !hash) return null;
  return `${String(chain.explorerUrl).replace(/\/+$/, "")}/tx/${hash}`;
}

export function addressUrl(chain, address) {
  if (!chain?.explorerUrl || !address) return null;
  return `${String(chain.explorerUrl).replace(/\/+$/, "")}/address/${address}`;
}
