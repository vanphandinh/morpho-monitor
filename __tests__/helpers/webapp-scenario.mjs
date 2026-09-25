/**
 * Kịch bản cố định lái webapp qua ĐƯỜNG TIỀN (vòng 6, P2).
 *
 * Một kịch bản, hai người dùng:
 *
 *   1. `scripts/refactor-diff.mjs` — chạy CÙNG kịch bản này trên cây trước P5 (bản một file
 *      1.848 dòng) và trên cây hiện tại (7 module) rồi so trace. Khác nhau ⇒ việc tách module đã
 *      đổi hành vi. Đây là bằng chứng cơ học, không phải lời hứa "chắc là vẫn thế".
 *   2. `__tests__/webapp-flows.test.mjs` — khẳng định trên artifact (calldata, body `/api/bundle`,
 *      URL DELETE, trạng thái UI) và trên trace đã đóng băng.
 *
 * Kịch bản KHÔNG tự khẳng định gì (không `expect`) và KHÔNG import module production: nó chỉ gọi
 * `window.*` và đọc DOM, nên chạy được trên mọi cây có cùng hợp đồng HTML ↔ `window`.
 *
 * Thứ tự bước là một phần của hợp đồng: `switchTab` và `doWithdraw` bắn việc nền (không `await`),
 * nên mỗi bước kết thúc bằng `flush()` để các promise đã-bắn xong trước khi chụp trạng thái —
 * nếu không, ảnh chụp phụ thuộc thời điểm và trace sẽ chập chờn.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeApi, createFakeProvider, createFakeRpc, fakeHash, loadWebapp, webappConfig } from "./webapp-harness.mjs";
import { browserSources } from "./browser-modules.mjs";

/**
 * Gốc repo — dùng để biến `entry` thành đường dẫn TƯƠNG ĐỐI trong trace.
 *
 * Lý do (vòng 6, P6): trace được ĐÓNG BĂNG thành fixture rồi so **nguyên chuỗi**, nên một đường
 * dẫn tuyệt đối trong đó (`C:\Users\…`) là file chỉ đúng trên đúng một máy — test sẽ đỏ trên CI
 * Linux dù hành vi không đổi. Nhãn tương đối vẫn phân biệt được hai cây (`webapp-app.mjs` vs
 * `.freebuff/ab-05b8342/webapp-app.mjs`) nên `scripts/refactor-diff.mjs` không bị ảnh hưởng.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entryLabel = (entry) => path.relative(REPO_ROOT, entry).split(path.sep).join("/");

/** Để mọi promise đã-bắn (không await) của một bước kịp hoàn tất. */
async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** id mà module webapp tự chèn (`id="x"` trong source) — tra ra `null` vẫn hợp lệ. */
export function selfInjectedIdsOfCurrentTree() {
  return new Set(browserSources().flatMap((source) => [...source.matchAll(/id="([^"]+)"/g)].map((m) => m[1])));
}

/** Trạng thái UI quan trọng, chụp lại sau mỗi bước (ngắn, tất định, so sánh được). */
function observe(app) {
  return {
    nonce: app.text("presign-nonce"),
    tierCount: app.text("tier-count"),
    tierList: app.html("tier-list"),
    presignResult: app.html("presign-result"),
    withdrawAllStatus: app.html("presign-withdraw-all-status"),
    progressText: app.text("progress-text"),
    errorBanner: app.text("error-banner"),
    txResult: app.html("tx-result"),
    // id tự chèn (`tx-verify-note`): chỉ đọc được vì harness materialize id trong innerHTML.
    // Cần CẢ hai: nhánh "đã thấy" ghi `textContent`, nhánh cảnh báo ghi `innerHTML` — đọc thiếu một
    // trong hai là trace im lặng bỏ qua đúng cái cần kiểm (R4).
    txVerifyNote: app.text("tx-verify-note"),
    txVerifyNoteHtml: app.html("tx-verify-note"),
    withdrawAmount: app.value("withdraw-amount"),
    maxWithdraw: app.text("max-withdraw"),
    gasMaxFee: app.value("presign-gas-maxfee"),
    gasPriority: app.value("presign-gas-priority"),
    nonceDecDisabled: app.env.elements.get("btn-nonce-dec")?.disabled ?? null,
    signAllDisabled: app.env.elements.get("btn-sign-all")?.disabled ?? null,
  };
}

/**
 * Chạy kịch bản đường tiền.
 *
 * @param {object} options
 * @param {string} options.entry Đường dẫn (tuyệt đối) tới `webapp-app.mjs` của cây cần kiểm.
 * @param {object} [options.rpc] Fixture đè cho RPC giả (xem `createFakeRpc`).
 * @param {object} [options.api] Fixture đè cho REST giả (xem `createFakeApi`).
 * @param {object} [options.provider] Tuỳ chọn cho ví giả.
 * @param {boolean} [options.confirmResult] `confirm()` trả về gì (mặc định true: đồng ý xoá/rút).
 * @param {string|null} [options.gasEditAfterSign] Nếu đặt (VD "150"): sau khi lưu bundle nhiều tier,
 *   người dùng SỬA ô gas-max-fee rồi việc thay đổi này bắn `onGasInputChange()` — ca DƯƠNG của
 *   D12: gas THỰC SỰ đổi ⇒ chữ ký vừa ký phải bị vô hiệu. Mặc định null ⇒ trace chính không đổi.
 */
export async function runWebappScenario({
  entry = path.resolve(process.cwd(), "webapp-app.mjs"),
  rpc: rpcFixtures = {},
  api: apiFixtures = {},
  provider: providerOptions = {},
  confirmResult = true,
  gasEditAfterSign = null,
} = {}) {
  const rpc = createFakeRpc({ pendingNonce: "0xb", ...rpcFixtures });
  const api = createFakeApi({ ...apiFixtures });
  const provider = createFakeProvider(providerOptions);

  const app = await loadWebapp({
    entry,
    config: webappConfig(),
    rpc,
    api,
    provider,
    selfInjectedIds: selfInjectedIdsOfCurrentTree(),
    confirmResult,
  });

  const steps = [];
  const step = async (name, action) => {
    await action();
    await flush();
    steps.push({ name, calls: app.takeCalls(), obs: observe(app) });
  };

  try {
    // 1. Boot (việc RPC y như lúc mở trang, chỉ khác là RPC nay trả lời được).
    await step("boot", async () => {});

    // 2. Ví + đăng nhập: chứng minh chữ ký challenge và phiên đăng nhập chạy qua dây thật.
    await step("connect-wallet", () => app.window.connectWallet());
    await step("sign-in", () => app.window.signIn());

    // 3. Tab ký sẵn: nonce, stepper (sàn on-chain), gas, mốc.
    await step("tab-presign", async () => app.window.switchTab("presign"));
    await step("fetch-nonce", () => app.window.fetchNonce());
    await step("nonce-step-down-at-floor", async () => app.window.onNonceStep(-1));
    await step("nonce-step-up", async () => app.window.onNonceStep(1));
    await step("auto-fill-gas", () => app.window.autoFillGas());
    await step("add-tier-100", async () => {
      app.window.addTier();
      app.window.updateTierAmount(0, "100");
    });
    await step("add-tier-250", async () => {
      app.window.addTier();
      app.window.updateTierAmount(1, "250");
      // Thêm một mốc để TRỐNG: nó phải bị bỏ qua khi ký (không tiêu một tx, không vào bundle),
      // nhưng vẫn hiện trong danh sách. Đây là bất biến của `signAllTiers` — không có mốc này thì
      // một mốc rỗng lọt vào bundle sẽ thành "rút 0" và proxy từ chối cả rung.
      app.window.addTier();
    });

    // 4. Ký: mỗi tier một `eth_sendTransaction` (calldata rút tiền).
    await step("sign-all-tiers", () => app.window.signAllTiers());

    // 5. Lưu bundle dạng NHIỀU TIER.
    await step("save-to-server-tiers", () => app.window.saveToServer());

    // 5b. (tuỳ chọn, ca dương D12) Người dùng sửa gas SAU KHI đã ký ⇒ onGasInputChange phải
    //     invalidate. Chỉ chạy khi phía gọi yêu cầu — trace chính giữ nguyên 19 bước.
    if (gasEditAfterSign !== null) {
      await step("gas-edit", () => {
        app.env.elements.get("presign-gas-maxfee").value = gasEditAfterSign;
        app.window.onGasInputChange();
      });
    }

    // 6. Ký rút toàn bộ shares rồi lưu lại — bundle dạng ALL-SHARES (`type: "all-shares"`),
    //    một nhánh khác hẳn của `buildPresignedBundle`.
    //
    //    GHI NHẬN LỊCH SỬ (đã sửa D12): trước vòng này `signWithdrawAll` gọi `onGasInputChange()`,
    //    hàm đó invalidate VÔ ĐIỀU KIỆN — nên ký all-shares xoá luôn chữ ký các tier vừa ký. Nay
    //    `signWithdrawAll` chỉ ĐỌC gas (`readGasInputs()`) và invalidate chỉ chạy khi gas THỰC SỰ đổi.
    await step("sign-withdraw-all", () => app.window.signWithdrawAll());
    await step("save-to-server-all-shares", () => app.window.saveToServer());

    // 7. Xoá một tier của rung (đường DELETE phải kèm nonce).
    await step("delete-tier", () => app.window.deleteTierFromBundle(11, 0));

    // 8. Tab rút tiền: MAX từ dữ liệu on-chain, rồi rút theo số lượng và rút toàn bộ.
    await step("tab-withdraw", async () => app.window.switchTab("withdraw"));
    await step("set-max", () => app.window.setMaxAmount());
    await step("withdraw-amount", () => app.window.withdrawAmount());
    await step("withdraw-all", () => app.window.withdrawAll());

    return { entry: entryLabel(entry), steps };
  } finally {
    app.restore();
  }
}

/** Chuỗi JSON tất định của một trace — dùng để so hai cây, và để đóng băng thành fixture. */
export function traceJson(trace) {
  return JSON.stringify(trace, null, 2);
}

export { fakeHash };
