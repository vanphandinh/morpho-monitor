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
 * Stub dưới đây dựng `document` **từ chính webapp.html**: id nào có trong HTML thì trả một element
 * giả, id nào không có thì trả `null` — đúng như browser. Nhờ vậy test bắt cả hai lớp trên, và
 * liệt kê được chính xác id bị tra sai.
 *
 * Không chạm mạng: `fetch` bị thay bằng hàm trả 503 ngay, `confirm` luôn false, `ethereum` null.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../webapp.html", import.meta.url), "utf8");
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

/** Mọi id app đã tra trong lúc test (để chứng minh stub thực sự được dùng, không xanh rỗng). */
const requestedIds = new Set();
/** id mà app tra nhưng HTML không có — phải rỗng, nếu không là mismatch thiệt. */
const unknownIds = [];
/** id app tự chèn rồi tra lại (vd `tx-verify-note`) — hợp lệ nếu app cũng sinh `id="x"`. */
const selfInjectedIds = new Set([...fs.readFileSync(new URL("../webapp-app.mjs", import.meta.url), "utf8").matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

function makeElement(id) {
  return {
    id,
    style: {},
    dataset: {},
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    disabled: false,
    selectedIndex: -1,
    options: [],
    children: [],
    classList: {
      _set: new Set(),
      add(...c) { for (const x of c) this._set.add(x); },
      remove(...c) { for (const x of c) this._set.delete(x); },
      toggle(c) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    insertAdjacentHTML() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    dispatchEvent() { return true; },
    focus() {}, blur() {}, click() {}, remove() {}, scrollIntoView() {},
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };
}

const elements = new Map([...htmlIds].map((id) => [id, makeElement(id)]));
const documentListeners = new Map();

const documentStub = {
  readyState: "loading",
  title: "",
  body: makeElement("body"),
  documentElement: makeElement("html"),
  getElementById(id) {
    requestedIds.add(id);
    if (elements.has(id)) return elements.get(id);
    if (!selfInjectedIds.has(id)) unknownIds.push(id);
    return null;
  },
  querySelector(selector) { return makeElement(selector); },
  querySelectorAll() { return []; },
  createElement(tag) { return makeElement(tag); },
  addEventListener(type, fn) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(fn);
  },
  removeEventListener() {},
};

const storage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
};

const locationStub = { href: "http://127.0.0.1:3999/", search: "", origin: "http://127.0.0.1:3999", pathname: "/", hash: "" };

// window=1 market hợp lệ ⇒ init() đi qua guard đầu tiên rồi chết ở bước RPC (không mạng).
const windowStub = {
  MORPHO_CONFIG: {
    markets: [{ id: "0x" + "a".repeat(64), minLiquidity: "5000", suddenDrainMultiplier: 2 }],
    lenderAddress: "0x" + "1".repeat(40),
    proxyRpcUrl: "http://127.0.0.1:8545",
    rpcUrls: ["http://127.0.0.1:1"], // endpoint chết: không rời khỏi máy, và fetch đã bị thay
  },
  ethereum: null,
  location: locationStub,
  sessionStorage: storage(),
  localStorage: storage(),
  document: documentStub,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  alert() {},
  open() {},
};

const saved = new Map();
function setGlobal(name, value) {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
function restoreGlobals() {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  saved.clear();
}

beforeAll(async () => {
  setGlobal("window", windowStub);
  setGlobal("document", documentStub);
  setGlobal("location", locationStub);
  setGlobal("sessionStorage", windowStub.sessionStorage);
  setGlobal("localStorage", windowStub.localStorage);
  setGlobal("confirm", () => false);
  setGlobal("alert", () => {});
  // Không rời khỏi máy: mọi request trả 503 ngay, kể cả khi code quên stub lớp trên.
  setGlobal("fetch", async () => ({
    ok: false, status: 503,
    headers: { get: () => null },
    text: async () => "",
    json: async () => ({}),
  }));
  await import("../webapp-app.mjs");
});

afterAll(() => restoreGlobals());

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
    const missing = [...called].filter((name) => typeof windowStub[name] !== "function");
    expect(missing).toEqual([]);
  });

  it("đường boot chạy được và đi đúng nhánh lỗi khi RPC không nối được", async () => {
    const listeners = documentListeners.get("DOMContentLoaded") ?? [];
    expect(listeners.length).toBe(1); // document.readyState = "loading" ⇒ app chờ DOMContentLoaded

    await listeners[0](); // = init() của app

    // init() đã chạy tới nhánh catch: banner lỗi có nội dung, loading đã tắt.
    expect(elements.get("error-banner").textContent).toContain("❌");
    expect(elements.get("error-banner").style.display).toBe("block");
    expect(elements.get("loading").style.display).toBe("none");
  });

  // Phạm vi THẬT của test này (đo được, không phải suy đoán): đường boot trong đây dừng ở bước
  // RPC (không mạng) nên chỉ chạm 2 id (`loading`, `error-banner`). Nhờ vậy test này KHÔNG phải
  // lưới phủ toàn bộ id — lưới đó là test tĩnh trong `webapp.test.mjs` (quét mọi lời gọi
  // `getElementById`). Ở đây chỉ ghim rằng stub thực sự được dùng và không id lạ nào bị tra.
  it("không tra id nào ngoài HTML (và id tự chèn vẫn được coi là hợp lệ)", () => {
    expect(requestedIds.size).toBeGreaterThanOrEqual(2);
    expect(unknownIds).toEqual([]);
  });
});
