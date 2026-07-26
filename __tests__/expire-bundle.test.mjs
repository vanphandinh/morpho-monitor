import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// Pure function: expireStaleBundle
//
// Duplicated từ monitor.mjs để test độc lập (theo convention
// của dự án — xem __tests__/presign-broadcast.test.mjs).
// Nhận fs và client làm tham số để mock hoàn toàn trong test.
// ============================================================

const BROADCASTING_STUCK_MS = 180_000; // 3 phút — khớp monitor.mjs

/**
 * Check if the pre-signed bundle's nonce is still valid.
 * Also recovers stuck status="broadcasting" after crash.
 *
 * @param {object} opts
 * @param {string} opts.presignedFile - path to presigned.json
 * @param {string} opts.lenderAddress - lender's Ethereum address
 * @param {object} opts.fs - filesystem mock (existsSync, readFileSync, writeFileSync, unlinkSync)
 * @param {object} opts.client - viem client mock (getTransactionCount)
 * @param {number} [opts.now] - injectable Date.now() for stuck-age tests
 */
async function expireStaleBundle({
  presignedFile,
  lenderAddress,
  fs,
  client,
  now = Date.now(),
  stuckMs = BROADCASTING_STUCK_MS,
}) {
  if (!fs.existsSync(presignedFile)) return;

  let bundle;
  try {
    const raw = fs.readFileSync(presignedFile, "utf-8");
    bundle = JSON.parse(raw);
  } catch {
    return;
  }

  const status = bundle.status;
  if (status !== "pending" && status !== "broadcasting") return;

  if (bundle.nonce == null) return;

  const currentNonce = await client.getTransactionCount({
    address: lenderAddress,
    blockTag: "pending",
  });

  if (status === "broadcasting") {
    if (currentNonce > bundle.nonce) {
      // fall through to expire
    } else {
      const claimedAt = bundle.broadcastingAt
        ? Date.parse(bundle.broadcastingAt)
        : NaN;
      const ageMs = Number.isFinite(claimedAt) ? now - claimedAt : Infinity;
      if (ageMs >= stuckMs) {
        bundle.status = "pending";
        delete bundle.broadcastingTier;
        delete bundle.broadcastingAt;
        fs.writeFileSync(presignedFile, JSON.stringify(bundle, null, 2));
      }
      return { recovered: ageMs >= stuckMs ? "pending" : null };
    }
  } else if (currentNonce <= bundle.nonce) {
    return;
  }

  // Expire path (pending or broadcasting with advanced nonce)
  bundle.status = "expired";
  bundle.error = `Nonce tăng: bundle=${bundle.nonce}, chain=${currentNonce}`;
  bundle.expiredAt = new Date().toISOString();
  delete bundle.broadcastingTier;
  delete bundle.broadcastingAt;
  const usedPath = presignedFile.replace(".json", ".used.json");
  fs.writeFileSync(usedPath, JSON.stringify(bundle, null, 2));
  fs.unlinkSync(presignedFile);
  return { expired: true };
}

// ============================================================
// TEST HELPERS
// ============================================================

const PRESIGNED_FILE = "./data/presigned.json";
const USED_FILE = "./data/presigned.used.json";
const LENDER_ADDRESS = "0x0A5e1Db3671faCcD146404925bDa5c59929f66c3";

/**
 * Tạo một bundle hợp lệ với nonce cho trước.
 */
function makeBundle(overrides = {}) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    chainId: 1,
    morphoBlueAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    marketId: "0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6",
    lenderAddress: LENDER_ADDRESS,
    nonce: 5,
    gas: "200000",
    maxFeePerGas: "50000000000",
    maxPriorityFeePerGas: "2000000000",
    loanToken: { symbol: "USDC", decimals: 6 },
    withdrawals: [
      {
        label: "50000 USDC",
        amountWei: "50000000000",
        amountFormatted: "50000 USDC",
        nonce: 5,
        signedTx: "0x02f8abcd",
      },
    ],
    status: "pending",
    ...overrides,
  };
}

/**
 * Tạo mock fs với các phương thức vi.fn().
 */
function makeMockFs({ exists = true, readData = null, readThrows = false } = {}) {
  return {
    existsSync: vi.fn().mockReturnValue(exists),
    readFileSync: vi.fn().mockImplementation(() => {
      if (readThrows) throw new Error("File read error");
      return readData;
    }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
}

/**
 * Tạo mock client với getTransactionCount trả về nonce cho trước.
 */
function makeMockClient(nonce) {
  return {
    getTransactionCount: vi.fn().mockResolvedValue(nonce),
  };
}

// ============================================================
// TESTS: expireStaleBundle
// ============================================================

describe("expireStaleBundle", () => {
  let fs;
  let client;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // --- Case 1: Không có file presigned ---
  it("không làm gì khi file presigned không tồn tại", async () => {
    fs = makeMockFs({ exists: false });
    client = makeMockClient(10);

    await expireStaleBundle({
      presignedFile: PRESIGNED_FILE,
      lenderAddress: LENDER_ADDRESS,
      fs,
      client,
    });

    // Không được gọi getTransactionCount vì file không tồn tại
    expect(client.getTransactionCount).not.toHaveBeenCalled();
    // Không ghi file gì cả
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  // --- Case 2: File bị lỗi parse ---
  it("không throw và không làm gì khi file chứa JSON không hợp lệ", async () => {
    fs = makeMockFs({ exists: true, readData: "not valid json!!!" });
    client = makeMockClient(10);

    // Không được throw
    await expect(
      expireStaleBundle({
        presignedFile: PRESIGNED_FILE,
        lenderAddress: LENDER_ADDRESS,
        fs,
        client,
      })
    ).resolves.toBeUndefined();

    // Không gọi getTransactionCount vì parse lỗi → return sớm
    expect(client.getTransactionCount).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  // --- Case 2b: File read throws ---
  it("không throw và không làm gì khi readFileSync throws", async () => {
    fs = makeMockFs({ exists: true, readThrows: true });
    client = makeMockClient(10);

    await expect(
      expireStaleBundle({
        presignedFile: PRESIGNED_FILE,
        lenderAddress: LENDER_ADDRESS,
        fs,
        client,
      })
    ).resolves.toBeUndefined();

    expect(client.getTransactionCount).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  // --- Case 3: Bundle status không phải pending/broadcasting ---
  it("bỏ qua bundle có status không phải 'pending'/'broadcasting'", async () => {
    const bundle = makeBundle({ status: "broadcast", nonce: 5 });
    fs = makeMockFs({ exists: true, readData: JSON.stringify(bundle) });
    client = makeMockClient(10);

    await expireStaleBundle({
      presignedFile: PRESIGNED_FILE,
      lenderAddress: LENDER_ADDRESS,
      fs,
      client,
    });

    expect(client.getTransactionCount).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  // --- Case 4: Nonce chain bằng nonce bundle (vẫn valid) ---
  it("giữ nguyên bundle khi nonce chain bằng nonce bundle", async () => {
    const bundle = makeBundle({ status: "pending", nonce: 5 });
    fs = makeMockFs({ exists: true, readData: JSON.stringify(bundle) });
    client = makeMockClient(5); // currentNonce = 5, bundle.nonce = 5

    await expireStaleBundle({
      presignedFile: PRESIGNED_FILE,
      lenderAddress: LENDER_ADDRESS,
      fs,
      client,
    });

    // Có gọi getTransactionCount
    expect(client.getTransactionCount).toHaveBeenCalledWith({
      address: LENDER_ADDRESS,
      blockTag: "pending",
    });
    // Nhưng không clear bundle vì nonce chưa tăng
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  // --- Case 5: Nonce chain < nonce bundle (edge case — vẫn valid) ---
  it("giữ nguyên bundle khi nonce chain nhỏ hơn nonce bundle", async () => {
    const bundle = makeBundle({ status: "pending", nonce: 5 });
    fs = makeMockFs({ exists: true, readData: JSON.stringify(bundle) });
    client = makeMockClient(3); // currentNonce = 3, bundle.nonce = 5

    await expireStaleBundle({
      presignedFile: PRESIGNED_FILE,
      lenderAddress: LENDER_ADDRESS,
      fs,
      client,
    });

    expect(client.getTransactionCount).toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  // --- Case 6: Nonce chain > nonce bundle → EXPIRE ---
  it("clear bundle khi nonce chain đã tăng vượt nonce bundle", async () => {
    const bundle = makeBundle({ status: "pending", nonce: 5 });
    fs = makeMockFs({ exists: true, readData: JSON.stringify(bundle) });
    client = makeMockClient(10); // currentNonce = 10 > bundle.nonce = 5

    await expireStaleBundle({
      presignedFile: PRESIGNED_FILE,
      lenderAddress: LENDER_ADDRESS,
      fs,
      client,
    });

    // Đã gọi getTransactionCount
    expect(client.getTransactionCount).toHaveBeenCalledWith({
      address: LENDER_ADDRESS,
      blockTag: "pending",
    });

    // Đã ghi file .used.json với bundle đã được cập nhật
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [usedPath, usedContent] = fs.writeFileSync.mock.calls[0];
    expect(usedPath).toBe(USED_FILE);

    const writtenBundle = JSON.parse(usedContent);
    expect(writtenBundle.status).toBe("expired");
    expect(writtenBundle.error).toContain("Nonce tăng");
    expect(writtenBundle.error).toContain("bundle=5");
    expect(writtenBundle.error).toContain("chain=10");
    expect(writtenBundle.expiredAt).toBeDefined();

    // Đã xóa file presigned.json gốc
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
    expect(fs.unlinkSync).toHaveBeenCalledWith(PRESIGNED_FILE);
  });

  // --- Case 7: Nonce chain > nonce bundle với nonce 0 ---
  it("clear bundle khi nonce bundle = 0 và chain nonce > 0", async () => {
    const bundle = makeBundle({ status: "pending", nonce: 0 });
    fs = makeMockFs({ exists: true, readData: JSON.stringify(bundle) });
    client = makeMockClient(1); // đã có 1 tx → nonce 0 đã dùng

    await expireStaleBundle({
      presignedFile: PRESIGNED_FILE,
      lenderAddress: LENDER_ADDRESS,
      fs,
      client,
    });

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [, usedContent] = fs.writeFileSync.mock.calls[0];
    const writtenBundle = JSON.parse(usedContent);
    expect(writtenBundle.status).toBe("expired");
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
  });

  // --- Broadcasting recovery ---
  it("broadcasting + nonce tăng → expire", async () => {
    const bundle = makeBundle({
      status: "broadcasting",
      nonce: 5,
      broadcastingAt: new Date().toISOString(),
      broadcastingTier: "50k",
    });
    fs = makeMockFs({ exists: true, readData: JSON.stringify(bundle) });
    client = makeMockClient(6);

    await expireStaleBundle({
      presignedFile: PRESIGNED_FILE,
      lenderAddress: LENDER_ADDRESS,
      fs,
      client,
    });

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [usedPath, usedContent] = fs.writeFileSync.mock.calls[0];
    expect(usedPath).toBe(USED_FILE);
    const written = JSON.parse(usedContent);
    expect(written.status).toBe("expired");
    expect(written.broadcastingAt).toBeUndefined();
    expect(fs.unlinkSync).toHaveBeenCalledWith(PRESIGNED_FILE);
  });

  it("broadcasting mới (age < stuck) + nonce bằng → giữ nguyên", async () => {
    const now = Date.now();
    const bundle = makeBundle({
      status: "broadcasting",
      nonce: 5,
      broadcastingAt: new Date(now - 30_000).toISOString(), // 30s ago
      broadcastingTier: "50k",
    });
    fs = makeMockFs({ exists: true, readData: JSON.stringify(bundle) });
    client = makeMockClient(5);

    await expireStaleBundle({
      presignedFile: PRESIGNED_FILE,
      lenderAddress: LENDER_ADDRESS,
      fs,
      client,
      now,
    });

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it("broadcasting kẹt (age >= stuck) + nonce bằng → reset pending", async () => {
    const now = Date.now();
    const bundle = makeBundle({
      status: "broadcasting",
      nonce: 5,
      broadcastingAt: new Date(now - 200_000).toISOString(), // > 180s
      broadcastingTier: "50k",
    });
    fs = makeMockFs({ exists: true, readData: JSON.stringify(bundle) });
    client = makeMockClient(5);

    await expireStaleBundle({
      presignedFile: PRESIGNED_FILE,
      lenderAddress: LENDER_ADDRESS,
      fs,
      client,
      now,
    });

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [path, content] = fs.writeFileSync.mock.calls[0];
    expect(path).toBe(PRESIGNED_FILE);
    const written = JSON.parse(content);
    expect(written.status).toBe("pending");
    expect(written.broadcastingAt).toBeUndefined();
    expect(written.broadcastingTier).toBeUndefined();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it("broadcasting thiếu broadcastingAt → reset pending ngay", async () => {
    const bundle = makeBundle({
      status: "broadcasting",
      nonce: 5,
      broadcastingTier: "50k",
      // no broadcastingAt
    });
    fs = makeMockFs({ exists: true, readData: JSON.stringify(bundle) });
    client = makeMockClient(5);

    await expireStaleBundle({
      presignedFile: PRESIGNED_FILE,
      lenderAddress: LENDER_ADDRESS,
      fs,
      client,
    });

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.status).toBe("pending");
  });
});
