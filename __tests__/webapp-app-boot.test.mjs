/**
 * webapp-app.mjs — chứng minh module **evaluate được**, không chỉ *tải được* (audit vòng 5, O1).
 *
 * Vòng 5 đã đóng lớp "import 404" (`webapp.test.mjs` — đồ thị module khép kín) và `node --check`
 * đã đóng lớp cú pháp. Còn lại lớp chỉ lộ ra khi browser **chạy** code:
 *
 *   1. sai thứ tự khởi tạo / TDZ — hàm top-level đọc một `const` khai báo phía dưới (ESM không
 *      báo lúc parse, chỉ ném lúc import);
 *   2. `document.getElementById("x")` trỏ vào id KHÔNG có trong HTML ⇒ `null.textContent` ⇒
 *      TypeError chỉ hiện khi người dùng bấm đúng nút đó.
 *
 * Môi trường giả dựng `document` **từ chính webapp.html**: id nào có trong HTML thì trả một element
 * giả, id nào không có thì trả `null` — đúng như browser. Nhờ vậy test bắt cả hai lớp trên, và
 * liệt kê được chính xác id bị tra sai.
 *
 * Vòng 6 (P1): stub tách sang `__tests__/helpers/dom-stub.mjs` để `webapp-flows.test.mjs` và
 * `scripts/refactor-diff.mjs` dùng lại được — ba nơi dùng chung một định nghĩa "browser giả".
 *
 * Không chạm mạng: `fetch` trả 503 ngay, `confirm` luôn false, `ethereum` null.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// Audit P5: id mà webapp TỰ CHÈN có thể nằm ở bất kỳ module browser nào (ví dụ
// `tx-verify-note` nay ở webapp-withdraw.mjs), nên phải quét cả closure import.
import { browserSources } from "./helpers/browser-modules.mjs";
import { installBrowserEnv, readWebappHtml } from "./helpers/dom-stub.mjs";

const html = readWebappHtml();
/** id app tự chèn rồi tra lại (vd `tx-verify-note`) — hợp lệ nếu module nào đó sinh `id="x"`. */
const selfInjectedIds = new Set(
  browserSources().flatMap((source) => [...source.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
);

/** @type {ReturnType<typeof installBrowserEnv>} */
let env;

beforeAll(async () => {
  env = installBrowserEnv({
    html,
    // 1 market hợp lệ ⇒ init() đi qua guard đầu tiên rồi chết ở bước RPC (không mạng).
    config: {
      markets: [{ id: "0x" + "a".repeat(64), minLiquidity: "5000", suddenDrainMultiplier: 2 }],
      lenderAddress: "0x" + "1".repeat(40),
      proxyRpcUrl: "http://127.0.0.1:8545",
      rpcUrls: ["http://127.0.0.1:1"], // endpoint chết: không rời khỏi máy, và fetch đã bị thay
    },
    selfInjectedIds,
  });
  await import("../webapp-app.mjs");
});

afterAll(() => env.restore());

describe("webapp-app.mjs — module evaluate được trong môi trường giống browser", () => {
  it("import chạy hết tới cuối: mọi handler trong HTML đều là hàm trên window", () => {
    // Cùng danh sách với test tĩnh trong webapp.test.mjs, nhưng lần này khẳng định việc GÁN đã
    // thực sự chạy — test tĩnh chỉ thấy chữ `window.x =` trong file.
    const attrs = /[\s]on(?:click|change|input|keydown|keyup|submit|blur|focus)="([^"]*)"/g;
    const called = new Set();
    for (const [, body] of html.matchAll(attrs)) {
      for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
    }
    expect(called.size).toBeGreaterThanOrEqual(15); // chốt chống regex hỏng
    const missing = [...called].filter((name) => typeof env.window[name] !== "function");
    expect(missing).toEqual([]);
  });

  it("đường boot chạy được và đi đúng nhánh lỗi khi RPC không nối được", async () => {
    const listeners = env.documentListeners.get("DOMContentLoaded") ?? [];
    expect(listeners.length).toBe(1); // document.readyState = "loading" ⇒ app chờ DOMContentLoaded

    await listeners[0](); // = init() của app

    // init() đã chạy tới nhánh catch: banner lỗi có nội dung, loading đã tắt.
    expect(env.elements.get("error-banner").textContent).toContain("❌");
    expect(env.elements.get("error-banner").style.display).toBe("block");
    expect(env.elements.get("loading").style.display).toBe("none");
  });

  // Phạm vi THẬT của test này (đo được, không phải suy đoán): đường boot trong đây dừng ở bước
  // RPC (không mạng) nên chỉ chạm 2 id (`loading`, `error-banner`). Nhờ vậy test này KHÔNG phải
  // lưới phủ toàn bộ id — lưới đó là test tĩnh trong `webapp.test.mjs` (quét mọi lời gọi
  // `getElementById`). Ở đây chỉ ghim rằng stub thực sự được dùng và không id lạ nào bị tra.
  it("không tra id nào ngoài HTML (và id tự chèn vẫn được coi là hợp lệ)", () => {
    expect(env.requestedIds.size).toBeGreaterThanOrEqual(2);
    expect(env.unknownIds).toEqual([]);
  });
});
