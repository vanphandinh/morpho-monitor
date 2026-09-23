/**
 * H2/B4: `verify-presigned.mjs` phải hiểu registry v2.
 *
 * Trước đây chạy trên `{ version: 2, bundles: {...} }` chỉ in "📄 Bundle rỗng"
 * rồi exit 0 — sai lệch âm thầm. CLI được spawn như tiến trình thật (module
 * chạy main() khi import).
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeMarketId, MORPHO_WITHDRAW_ABI } from "../presign-verify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const cliPath = path.join(projectRoot, "verify-presigned.mjs");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);
const LENDER = account.address;

const MARKET_PARAMS = {
  loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  oracle: "0x3333333333333333333333333333333333333333",
  irm: "0x4444444444444444444444444444444444444444",
  lltv: 860000000000000000n,
};
const MARKET_A = computeMarketId(MARKET_PARAMS);
const MARKET_B = "0x" + "b".repeat(64);

async function signedWithdraw({ nonce = 7, assets = 50_000_000_000n } = {}) {
  return account.signTransaction({
    to: MORPHO,
    data: encodeFunctionData({
      abi: MORPHO_WITHDRAW_ABI,
      functionName: "withdraw",
      args: [MARKET_PARAMS, assets, 0n, LENDER, LENDER],
    }),
    nonce,
    chainId: 1,
    gas: 200_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    type: "eip1559",
    value: 0n,
  });
}

function writeRegistry(value) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "verify-cli-")), "presigned.json");
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { cwd: projectRoot, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

async function bundleFor(nonce, { amountWei = "50000000000" } = {}) {
  const signedTx = await signedWithdraw({ nonce, assets: BigInt(amountWei) });
  return {
    version: 2,
    marketId: MARKET_A,
    morphoBlueAddress: MORPHO,
    lenderAddress: LENDER,
    nonce,
    createdAt: "2026-09-23T00:00:00.000Z",
    chainId: 1,
    status: "pending",
    withdrawals: [{ label: "tier", amountWei, amountFormatted: "50000 USDC", signedTx }],
  };
}

describe("verify-presigned CLI — registry v2", () => {
  it("valid registry → exit 0 với tổng hợp theo market", async () => {
    const file = writeRegistry({ version: 2, bundles: { [MARKET_A]: await bundleFor(7) } });
    const { code, stdout } = await runCli([file]);
    expect(code).toBe(0);
    expect(stdout).toContain("Registry v2");
    expect(stdout).toContain("Tổng hợp theo market");
    expect(stdout).toContain("OK");
    expect(stdout).toContain(MARKET_A.slice(0, 10));
  });

  it("mismatch amountWei → exit 1", async () => {
    const bundle = await bundleFor(7);
    bundle.withdrawals[0].amountWei = "999"; // sai lệch so với calldata
    const file = writeRegistry({ version: 2, bundles: { [MARKET_A]: bundle } });
    const { code, stdout, stderr } = await runCli([file]);
    expect(code).toBe(1);
    expect(stdout).toContain("MISMATCH");
    expect(stderr).toMatch(/vấn đề/);
  });

  it("bundle rỗng trong registry → exit 1 (trước đây exit 0)", async () => {
    const file = writeRegistry({ version: 2, bundles: { [MARKET_A]: { status: "pending", nonce: 7, withdrawals: [] } } });
    const { code, stdout, stderr } = await runCli([file]);
    expect(code).toBe(1);
    expect(stdout).toContain("bundle rỗng");
    expect(stderr).toMatch(/vấn đề/);
  });

  it("--market chỉ kiểm tra market được chọn", async () => {
    const good = await bundleFor(7);
    const bad = await bundleFor(8);
    bad.withdrawals[0].amountWei = "999";
    const file = writeRegistry({ version: 2, bundles: { [MARKET_A]: good, [MARKET_B]: bad } });

    const all = await runCli([file]);
    expect(all.code).toBe(1); // market B hỏng

    const onlyGood = await runCli([file, "--market", MARKET_A]);
    expect(onlyGood.code).toBe(0);
    // Nhãn trong bảng tổng hợp là `<10 ký tự>…<6 ký tự>` — không xuất hiện khi lọc.
    expect(onlyGood.stdout).not.toContain(`${MARKET_B.slice(0, 10)}…`);
  });

  it("--market không tồn tại trong registry → exit 1", async () => {
    const file = writeRegistry({ version: 2, bundles: { [MARKET_A]: await bundleFor(7) } });
    const { code, stderr } = await runCli([file, `--market=${"0x" + "c".repeat(64)}`]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Không có bundle nào cho market/);
  });
});

describe("verify-presigned CLI — bare bundle back-compat", () => {
  it("bundle hợp lệ → exit 0", async () => {
    const file = writeRegistry(await bundleFor(7));
    const { code, stdout } = await runCli([file]);
    expect(code).toBe(0);
    expect(stdout).toContain("KHỚP");
    expect(stdout).not.toContain("Registry v2");
  });

  it("bundle rỗng → exit 1", async () => {
    const file = writeRegistry({ withdrawals: [] });
    const { code, stdout } = await runCli([file]);
    expect(code).toBe(1);
    expect(stdout).toContain("Bundle rỗng");
  });

  it("file không tồn tại → exit 1", async () => {
    const { code, stderr } = await runCli([path.join(os.tmpdir(), "nope-" + keccak256("0x00") + ".json")]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/không tồn tại/);
  });
});
