/**
 * ĐƯỜNG TIỀN của webapp — chạy THẬT rồi khẳng định trên artifact (vòng 6, P3).
 *
 * Trước vòng này, đường tiền (ký sẵn + rút tiền) chỉ được chứng minh bằng chuỗi trong source: test
 * tĩnh đọc `app.toContain("...")`, boot test chỉ chạm 2 id vì nó dừng ở bước RPC. Không test nào
 * thực thi `signAllTiers()`/`withdrawAmount()` để xem **calldata gửi đi là gì**. Mà đó lại là thứ
 * duy nhất thật sự quan trọng: một tham số sai ở đây là mất tiền, không phải lỗi giao diện.
 *
 * Vì vậy suite này KHÔNG đọc source. Nó chạy kịch bản ở `helpers/webapp-scenario.mjs` (qua
 * `scripts/webapp-trace.mjs`, mỗi lần một tiến trình mới) rồi khẳng định trên:
 *
 *   1. **calldata** `withdraw()` mà viem gửi cho ví (`eth_sendTransaction`) — giải mã lại, so từng
 *      tham số: `assets`, `shares`, `onBehalf`, `receiver`, marketParams.
 *   2. **body** `POST /api/bundle` — thứ monitor dùng để ghép và broadcast sau này.
 *   3. **URL** `DELETE /api/presign` — phải kèm nonce, nếu không server sửa nhầm rung.
 *   4. **trạng thái UI** sau mỗi bước (nonce, danh sách mốc, ghi chú xác minh tx).
 *
 * Cộng thêm một lưới hồi quy: trace đã **đóng băng** trong `__tests__/fixtures/webapp-flows-trace.json`.
 * Fixture đó sinh ra từ chính kịch bản này, và ở P2 đã được chứng minh là y hệt trace của cây TRƯỚC
 * khi tách module (`npm run diff:refactor` — mặc định so với `ee43de6`, đỉnh của lịch sử trước khi
 * tách module đã được gộp lại qua rebase dọn lịch sử — ⇒ 0 khác biệt so với cây một file).
 * Nên nó vừa là lưới chống đổi hành vi ngoài ý muốn, vừa là bản ghi của refactor đã được kiểm chứng.
 *
 * Chạy lại fixture (chỉ khi ĐÃ CỐ Ý đổi hành vi):
 *   node scripts/webapp-trace.mjs --out __tests__/fixtures/webapp-flows-trace.json
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { MORPHO_BLUE_ADDRESS, decodeWithdrawCalldata, fakeHash } from "./helpers/webapp-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "scripts", "webapp-trace.mjs");
const FIXTURE = path.join(ROOT, "__tests__", "fixtures", "webapp-flows-trace.json");

const LENDER = "0x" + "1".repeat(40);
const LOAN_TOKEN = "0x" + "2".repeat(40);
const COLLATERAL_TOKEN = "0x" + "3".repeat(40);
const MARKET_ID = "0x" + "a".repeat(64);

/** Chạy kịch bản trong tiến trình mới và trả trace đã parse. */
function runTrace(extraArgs = []) {
  const stdout = execFileSync(process.execPath, [RUNNER, ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

let trace;
beforeAll(() => {
  trace = runTrace();
});

const stepNamed = (name) => {
  const found = trace.steps.find((step) => step.name === name);
  expect(found, `trace không có bước "${name}"`).toBeTruthy();
  return found;
};
const callsOf = (step) => step.calls.map((call) => JSON.parse(call));
const sendsOf = (step) =>
  callsOf(step)
    .filter((call) => call.kind === "provider" && call.method === "eth_sendTransaction")
    .map((call) => call.params[0]);
const apiOf = (step, method) => callsOf(step).filter((call) => call.kind === "api" && call.method === method);
const bundleBodies = (step) => apiOf(step, "POST").filter((call) => call.url === "/api/bundle").map((call) => call.body);

// ─────────────────────────────────────────────────────────────────────────────
// Chốt chống "xanh rỗng": nếu harness ngừng thật sự chạy (kịch bản rỗng, không lời gọi nào), mọi
// khẳng định bên dưới có thể vẫn xanh một cách vô nghĩa. Ba con số dưới đây đo được từ trace thật.
// ─────────────────────────────────────────────────────────────────────────────
describe("harness thật sự chạy (chốt chống xanh rỗng)", () => {
  it("kịch bản đi hết 19 bước và phát sinh lời gọi ra dây", () => {
    expect(trace.steps.map((step) => step.name)).toEqual([
      "boot", "connect-wallet", "sign-in", "tab-presign", "fetch-nonce", "nonce-step-down-at-floor",
      "nonce-step-up", "auto-fill-gas", "add-tier-100", "add-tier-250", "sign-all-tiers",
      "save-to-server-tiers", "sign-withdraw-all", "save-to-server-all-shares", "delete-tier",
      "tab-withdraw", "set-max", "withdraw-amount", "withdraw-all",
    ]);
    const totalCalls = trace.steps.reduce((sum, step) => sum + step.calls.length, 0);
    expect(totalCalls).toBeGreaterThanOrEqual(45); // đo được: 46
    const sends = trace.steps.flatMap((step) => sendsOf(step));
    expect(sends.length).toBeGreaterThanOrEqual(5); // 2 tier + all-shares + rút theo số lượng + rút hết
  });
});

describe("đường tiền — ký sẵn: mỗi mốc một giao dịch trên dây", () => {
  it("calldata `withdraw()` đúng từng tham số cho cả hai mốc", () => {
    const sends = sendsOf(stepNamed("sign-all-tiers"));
    expect(sends.length).toBe(2);

    const decoded = sends.map((params) => decodeWithdrawCalldata(params.data));
    // `assets` = số USDC người dùng nhập, quy đổi theo decimals của loan token (6).
    expect(decoded.map((call) => call.assets)).toEqual([100_000_000n, 250_000_000n]);
    for (const call of decoded) {
      expect(call.shares).toBe(0n); // rút theo số lượng ⇒ shares = 0
      expect(call.onBehalf).toBe(LENDER); // vị thế của lender
      expect(call.receiver).toBe(LENDER); // tiền về ví đang kết nối
      expect(call.loanToken).toBe(LOAN_TOKEN);
      expect(call.collateralToken).toBe(COLLATERAL_TOKEN);
      expect(call.lltv).toBe(860_000_000_000_000_000n); // 86% từ marketParams on-chain
    }
    for (const params of sends) {
      expect(params.to).toBe(MORPHO_BLUE_ADDRESS);
      expect(params.value).toBe("0x0");
    }
  });

  it("mốc ĐỂ TRỐNG bị bỏ qua — hiện trong danh sách, KHÔNG bị đem đi ký", () => {
    const signStep = stepNamed("sign-all-tiers");
    expect(sendsOf(signStep).length).toBe(2); // 3 mốc, chỉ 2 mốc có tiền
    expect(signStep.obs.tierList.match(/tier-row/g) ?? []).toHaveLength(3);
    expect(signStep.obs.tierList.match(/✅/g) ?? []).toHaveLength(2);
    expect(signStep.obs.tierCount).toBe("2"); // bộ đếm chỉ tính mốc có số tiền
    // Hai khẳng định dưới đây mới là chỗ BẮT LỖI nếu ai bỏ lớp chặn mốc rỗng: mốc rỗng phải ở
    // nguyên trạng thái `pending` (⬜) chứ không phải bị đem đi ký rồi hỏng (❌), và tổng số ở thanh
    // tiến độ phải tính theo mốc hợp lệ (2/2) chứ không phải theo tổng số dòng (2/3).
    expect(signStep.obs.tierList.match(/❌/g) ?? []).toHaveLength(0);
    expect(signStep.obs.tierList.match(/⬜/g) ?? []).toHaveLength(1);
    expect(signStep.obs.progressText).toContain("2/2");
  });

  it("nonce gửi lên là nonce của stepper, KHÔNG phải nonce on-chain thô", () => {
    const sends = sendsOf(stepNamed("sign-all-tiers"));
    for (const params of sends) expect(params.nonce).toBe("0xc"); // 12 = 11 (on-chain) + 1 bước tăng
    expect(stepNamed("fetch-nonce").obs.nonce).toBe("11");
  });

  it("gas/fee lấy từ ô nhập gas, đúng công thức 2×baseFee + 2×priority", () => {
    // RPC giả: baseFeePerGas = 1 gwei, eth_maxPriorityFeePerGas = 1 gwei.
    const autoGas = stepNamed("auto-fill-gas").obs;
    expect([autoGas.gasMaxFee, autoGas.gasPriority]).toEqual(["4", "2"]); // gwei, đã điền vào ô nhập
    for (const params of sendsOf(stepNamed("sign-all-tiers"))) {
      expect(params.gas).toBe("0x30d40"); // 200.000
      expect(params.maxFeePerGas).toBe("0xee6b2800"); // 4 gwei = 2×1 + 2×1
      expect(params.maxPriorityFeePerGas).toBe("0x77359400"); // 2 gwei
    }
  });

  it("stepper nonce kẹp sàn on-chain: nút giảm khoá ở sàn, và giảm quá sàn không có tác dụng", () => {
    expect(stepNamed("fetch-nonce").obs.nonce).toBe("11");
    expect(stepNamed("fetch-nonce").obs.nonceDecDisabled).toBe(true); // đang đứng ở sàn
    expect(stepNamed("nonce-step-down-at-floor").obs.nonce).toBe("11"); // giảm ở sàn ⇒ giữ nguyên
    expect(stepNamed("nonce-step-down-at-floor").calls).toHaveLength(0); // và không gọi gì ra dây
    expect(stepNamed("nonce-step-up").obs.nonce).toBe("12");
  });

  it("txHash của từng mốc được ghi lại — proxy cần nó để ghép tx đã capture", () => {
    const [first, second] = bundleBodies(stepNamed("save-to-server-tiers"))[0].tiers;
    expect(first.txHash).toBe(fakeHash(1));
    expect(second.txHash).toBe(fakeHash(2));
  });
});

describe("đường tiền — lưu bundle lên server", () => {
  it("POST /api/bundle mang đủ trường để monitor broadcast sau này", () => {
    const bodies = bundleBodies(stepNamed("save-to-server-tiers"));
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body.nonce).toBe(12);
    expect(body.gas).toBe("200000");
    expect(body.maxFeePerGas).toBe("4000000000");
    expect(body.maxPriorityFeePerGas).toBe("2000000000");
    expect(body.morphoBlueAddress).toBe(MORPHO_BLUE_ADDRESS);
    expect(body.marketId).toBe(MARKET_ID);
    expect(body.lenderAddress).toBe(LENDER);
    expect(body.loanToken).toEqual({ symbol: "USDC", decimals: 6 });
    expect(body.tiers.map((tier) => tier.amountWei)).toEqual(["100000000", "250000000"]);
  });

  it("mọi lời gọi API đều mang Bearer token của phiên đã xác thực", () => {
    for (const step of trace.steps) {
      for (const call of callsOf(step)) {
        if (call.kind !== "api") continue;
        if (call.url === "/api/challenge" || call.url === "/api/auth") continue; // 2 bước xác thực
        expect(call.authorization, `${step.name} → ${call.method} ${call.url}`).toBe("Bearer test-token");
      }
    }
  });

  it("bundle 'rút toàn bộ shares' dùng nhánh all-shares (amountWei = 0, sharesWei thật)", () => {
    const body = bundleBodies(stepNamed("save-to-server-all-shares"))[0];
    // D12 đã sửa: `signWithdrawAll` không còn vô hiệu các mốc đã ký, nên rung 2 tier + all-shares
    // cùng sống sót vào bundle — 3 entry, không phải 1.
    expect(body.tiers).toHaveLength(3);
    const allShares = body.tiers.find((tier) => tier.type === "all-shares");
    expect(allShares).toBeTruthy();
    expect(allShares.sharesWei).toBe("500000000");
    expect(allShares.amountWei).toBe("0");
    expect(allShares.txHash).toBe(fakeHash(3));
    const tierEntries = body.tiers.filter((tier) => tier.type === undefined);
    expect(tierEntries.map((tier) => tier.amount)).toEqual(["100", "250"]);
    expect(tierEntries.map((tier) => tier.txHash)).toEqual([fakeHash(1), fakeHash(2)]);
  });

  it("D12: ký rút-toàn-bộ-shares GIỮ NGUYÊN chữ ký các mốc đã ký trước đó (gas không đổi)", () => {
    // Sửa D12 (vòng 6): `signWithdrawAll()` gọi `readGasInputs()` (chỉ ĐỌC) thay vì
    // `onGasInputChange()`, và hàm này chỉ `invalidateSignatures()` khi gas THỰC SỰ đổi — nên ký
    // all-shares không còn tự xoá chữ ký các mốc vừa ký kèm báo "Gas đã thay đổi" dù gas không đổi.
    // Hành vi CŨ (đã đỏ-trước: áp guard lên code cũ ⇒ đúng 3 test đỏ) được ghi trong message commit
    // 21300cb và trong fixture trace cũ.
    expect(stepNamed("sign-withdraw-all").obs.presignResult).not.toContain("Gas đã thay đổi");
    const signed = stepNamed("sign-withdraw-all").obs.tierList.match(/✅/g) ?? [];
    expect(signed).toHaveLength(2);
  });

  it("D12: gas THỰC SỰ đổi thì chữ ký vẫn bị vô hiệu (không tắt bảo vệ)", () => {
    // Ca DƯƠNG: một tiến trình con với `gasEditAfterSign` — sau khi đã ký 2 mốc, người dùng sửa ô
    // gas-max-fee và việc thay đổi này bắn `onGasInputChange()`; gas mới khác gas cũ ⇒ phải
    // invalidate, báo "Gas đã thay đổi" và chữ ký các mốc về ⬜. Chạy qua tuỳ chọn kịch bản vì
    // trace chính không có bước sửa gas (autoFillGas ghi thẳng presignedGas rồi mới ghi ra ô nhập,
    // nên onchange của user là đường duy nhất tới nhánh này — chi tiết dễ mất khi refactor).
    const edited = runTrace(["--overrides", JSON.stringify({ gasEditAfterSign: "150" })]);
    const step = edited.steps.find((entry) => entry.name === "gas-edit");
    expect(step, "trace phụ phải có bước gas-edit").toBeTruthy();
    expect(step.obs.presignResult).toContain("Gas đã thay đổi");
    expect(step.obs.tierList.match(/✅/g) ?? []).toHaveLength(0);
    expect(step.obs.signAllDisabled).toBe(false);
  });

  it("D14: bấm Tự Động Gas SAU khi ký + phí ĐỔI ⇒ chữ ký phải bị vô hiệu (audit 2026-09-26)", () => {
    // `autoFillGas()` là đường DUY NHẤT ghi `presignedGas` mà không đi qua cổng vô hiệu chữ ký:
    // nó gán phí mới rồi mới ghi ra ô nhập, nên người dùng thấy phí MỚI trong khi byte đã ký vẫn
    // mang phí CŨ — bundle lưu lên có thể trộn nhiều mức phí và không gì trong UI nói ra điều đó.
    // Ở đây RPC giả trả phí mới (priority 2 gwei thay vì 1 gwei) giữa hai lần bấm.
    const raised = runTrace(["--overrides", JSON.stringify({ autoGasAfterSign: { priorityFee: "0x77359400" } })]);
    const step = raised.steps.find((entry) => entry.name === "auto-gas-after-sign");
    expect(step, "trace phụ phải có bước auto-gas-after-sign").toBeTruthy();
    expect(step.obs.gasPriority).toBe("4"); // phí mới THẬT SỰ vào ô nhập (điều kiện của ca này)
    expect(step.obs.presignResult).toContain("Gas đã thay đổi");
    expect(step.obs.tierList.match(/✅/g) ?? []).toHaveLength(0); // chữ ký đã ký về ⬜
    expect(step.obs.signAllDisabled).toBe(false);
  });

  it("D14: bấm Tự Động Gas SAU khi ký nhưng phí KHÔNG đổi ⇒ GIỮ chữ ký (ca âm)", () => {
    // Cổng so-sánh-phải-chạy-trước-khi-gán, không phải một lệnh invalidate vô điều kiện: nếu
    // phí y hệt thì chữ ký vẫn còn nguyên, nút lưu vẫn bật. Đây là ca chống "sửa quá tay".
    const same = runTrace(["--overrides", JSON.stringify({ autoGasAfterSign: {} })]);
    const step = same.steps.find((entry) => entry.name === "auto-gas-after-sign");
    expect(step, "trace phụ phải có bước auto-gas-after-sign").toBeTruthy();
    expect(step.obs.gasPriority).toBe("2"); // phí không đổi
    expect(step.obs.presignResult).not.toContain("Gas đã thay đổi");
    expect(step.obs.tierList.match(/✅/g) ?? []).toHaveLength(2); // 2 mốc đã ký vẫn còn
  });

  it("DELETE tier gửi kèm market + nonce + tier (thiếu nonce ⇒ server sửa nhầm rung)", () => {
    const deletes = apiOf(stepNamed("delete-tier"), "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toBe(`/api/presign?market=${MARKET_ID}&nonce=11&tier=0`);
  });
});

describe("đường tiền — tab rút tiền", () => {
  it("MAX = min(supplyAssets, liquidity) hiện lên ô nhập", () => {
    // RPC giả: supply 1e9 shares, totalSupplyAssets 1e9, totalBorrowAssets 4e8
    //   ⇒ supplyAssets = 5e8 (500 USDC), liquidity = 6e8 ⇒ MAX = 5e8.
    expect(stepNamed("set-max").obs.withdrawAmount).toBe("500");
    expect(stepNamed("set-max").obs.maxWithdraw).toBe("500 USDC");
  });

  it("rút theo số lượng: simulate trước, rồi gửi tx assets=MAX, shares=0", () => {
    const step = stepNamed("withdraw-amount");
    const simulated = callsOf(step).filter((call) => call.kind === "rpc" && call.method === "eth_call");
    expect(simulated.length).toBeGreaterThanOrEqual(1); // doWithdraw mô phỏng trước khi gửi

    const sends = sendsOf(step);
    expect(sends).toHaveLength(1);
    const decoded = decodeWithdrawCalldata(sends[0].data);
    expect(decoded.assets).toBe(500_000_000n);
    expect(decoded.shares).toBe(0n);
    expect(decoded.onBehalf).toBe(LENDER);
    expect(decoded.receiver).toBe(LENDER);
    expect(sends[0].to).toBe(MORPHO_BLUE_ADDRESS);
  });

  it("rút toàn bộ: gửi shares thật, assets = 0", () => {
    const sends = sendsOf(stepNamed("withdraw-all"));
    expect(sends).toHaveLength(1);
    const decoded = decodeWithdrawCalldata(sends[0].data);
    expect(decoded.assets).toBe(0n);
    expect(decoded.shares).toBe(500_000_000n); // đúng supplyShares của vị thế
  });
});

describe("R4 — xác minh tx best-effort không chặn UI", () => {
  it("thấy tx trên RPC công khai ⇒ ghi chú nói đã thấy", () => {
    expect(stepNamed("withdraw-amount").obs.txVerifyNote).toContain("Đã thấy giao dịch");
  });

  it("KHÔNG thấy tx ⇒ cảnh báo khả năng ví trỏ RPC về proxy (chỉ được capture)", () => {
    // Nhánh này chờ thật 4 × 3s (`txVisibleOnChain`), nên hạ trần `setTimeout` trong tiến trình con —
    // đường code thì y hệt, chỉ khác là không phải đợi 12 giây.
    const unseen = runTrace(["--overrides", JSON.stringify({ rpc: { txVisible: false } }), "--cap-timers", "1"]);
    const step = unseen.steps.find((entry) => entry.name === "withdraw-amount");
    expect(step.obs.txVerifyNoteHtml).toContain("ghi lại (capture)");
    expect(step.obs.txVerifyNoteHtml).toContain("http://127.0.0.1:8545"); // URL proxy trong cảnh báo
    // Xác minh là best-effort: banner thành công vẫn còn nguyên, không bị đảo thành lỗi.
    expect(step.obs.txResult).toContain("thành công");
  });
});

describe("lưới hồi quy — trace đã đóng băng", () => {
  it("kịch bản hiện tại tái tạo đúng trace đã đóng băng (đóng băng lại sau khi sửa D12)", () => {
    // Fixture sinh lần đầu từ cây TRƯỚC P5 (0 khác biệt qua `npm run diff:refactor`), rồi được ĐÓNG
    // BĂNG LẠI sau khi sửa D12 có chủ ý — khác biệt duy nhất so với bản trước là bước
    // `sign-withdraw-all` (không còn "Gas đã thay đổi") và bước `save-to-server-all-shares`
    // (lưu 3 entry thay vì 1). Vẫn 19 bước · 46 lời gọi ra dây.
    // Chuẩn hoá CRLF: repo bật `core.autocrlf=true`, nên trên checkout Windows file fixture ra khỏi
    // git sẽ có `\r\n` — so nguyên chuỗi là test tự vỡ theo hệ điều hành, không phải theo hành vi.
    const frozen = fs.readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n");
    expect(JSON.stringify(trace, null, 2)).toBe(frozen);
  });

  it("fixture không rỗng và chứa đúng số bước/lời gọi đã đo", () => {
    const frozen = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    expect(frozen.steps).toHaveLength(19);
    // 46 → 48 (chẩn đoán 2026-09-26): mỗi bước ký nay đọc lại nonce on-chain TRƯỚC khi ký
    // (guard chống ký ở nonce đã chết), cộng 1 `eth_getTransactionCount` cho mỗi bước
    // `sign-all-tiers` và `sign-withdraw-all`. Không có lời gọi nào bị mất.
    expect(frozen.steps.reduce((sum, step) => sum + step.calls.length, 0)).toBe(48);
  });

  it("nhãn cây là đường dẫn TƯƠNG ĐỐI — fixture không ghim đường dẫn của một máy", () => {
    // Đỏ-trước (vòng 6, P6): khi `entry` còn là đường dẫn tuyệt đối, fixture chứa
    // `C:\Users\…\morpho\webapp-app.mjs` — test so nguyên chuỗi nên nó đỏ trên CI Linux dù hành vi
    // y hệt. Đây là lỗi đã lọt qua P3 và chỉ lộ khi soạn tài liệu; nó cũng chính là lớp lỗi mà job
    // CI ở P5 tồn tại để bắt.
    const frozen = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    expect(frozen.entry).toBe("webapp-app.mjs");
    expect(trace.entry).toBe("webapp-app.mjs");
    expect(frozen.entry).not.toMatch(/^([A-Za-z]:|[\\/])/);
  });
});
