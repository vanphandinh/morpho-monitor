/**
 * Môi trường browser giả dùng chung cho mọi test webapp (vòng 6, P1).
 *
 * Trước vòng 6, stub này nằm lẫn trong `webapp-app-boot.test.mjs`. Nay có ba nơi cần nó:
 *
 *   1. `webapp-app-boot.test.mjs`  — chứng minh module **evaluate được** (`window`/`document` thật);
 *   2. `webapp-flows.test.mjs`     — **lái** các handler (ký sẵn, rút tiền) rồi soi artifact;
 *   3. `scripts/refactor-diff.mjs` — chạy **cùng một kịch bản** trên cây trước P5 và cây hiện tại.
 *
 * Vì vậy nó phải: (a) không phụ thuộc entry nào, (b) reset được hoàn toàn để hai lượt chạy trong
 * cùng một tiến trình không rò state sang nhau, (c) theo dõi id bị tra sai.
 *
 * Hai điều mô phỏng ở đây là **hợp đồng**, không phải tiện ích:
 *
 *   - `document.getElementById("x")` trả `null` khi HTML không có id đó — đúng như browser, và đó
 *     là cách bắt lớp lỗi `null.textContent` (chỉ hiện khi người dùng bấm đúng nút).
 *   - Gán `innerHTML` có **materialize** các `id="…"` bên trong thành element tra lại được. Browser
 *     parse HTML thành DOM; không có bước này thì `id="tx-verify-note"` mà app tự chèn rồi tra lại
 *     sẽ luôn là `null`, và test không thể soi được nội dung xác minh tx (R4).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEBAPP_HTML = path.join(ROOT, "webapp.html");

/** Tên global mà stub chiếm chỗ — lưu descriptor để trả lại nguyên trạng khi `restore()`. */
const GLOBAL_NAMES = ["window", "document", "location", "sessionStorage", "localStorage", "confirm", "alert", "fetch"];

export function readWebappHtml() {
  return fs.readFileSync(WEBAPP_HTML, "utf8");
}

/** id khai báo trong `webapp.html`: chỉ những id này mới được coi là "có thật". */
export function declaredHtmlIds(html = readWebappHtml()) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

/**
 * Element giả: đủ để code webapp chạy qua, KHÔNG mô phỏng layout/CSS.
 * `innerHTML` là accessor thật (xem `hookInnerHtml`) nên element tạo trực tiếp từ đây cần được
 * `installBrowserEnv` bọc lại nếu muốn id bên trong được materialize.
 */
export function makeElement(id) {
  const attributes = new Map();
  const classSet = new Set();
  return {
    id,
    style: {},
    dataset: {},
    textContent: "",
    innerHTML: "",
    innerText: "",
    value: "",
    checked: false,
    disabled: false,
    selectedIndex: -1,
    options: [],
    children: [],
    parentNode: null,
    classList: {
      add(...c) { for (const x of c) classSet.add(x); },
      remove(...c) { for (const x of c) classSet.delete(x); },
      toggle(c) { if (classSet.has(c)) classSet.delete(c); else classSet.add(c); },
      contains(c) { return classSet.has(c); },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    replaceChildren() {},
    insertAdjacentHTML() {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    dispatchEvent() { return true; },
    matches() { return false; },
    contains() { return false; },
    closest() { return null; },
    focus() {},
    blur() {},
    click() {},
    remove() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };
}

/** storage giả (sessionStorage/localStorage) — Map đóng, không chạm đĩa. */
export function createStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() { return map.size; },
  };
}

/** `fetch` mặc định: đóng luôn, không rời khỏi máy. */
export function offlineFetch() {
  return Promise.resolve({
    ok: false,
    status: 503,
    headers: { get: () => null },
    text: async () => "",
    json: async () => ({}),
  });
}

function hookInnerHtml(element, onMarkup) {
  let value = "";
  Object.defineProperty(element, "innerHTML", {
    enumerable: true,
    configurable: true,
    get: () => value,
    set: (markup) => {
      value = String(markup ?? "");
      onMarkup(value);
    },
  });
}

/**
 * Cài môi trường browser giả lên globalThis và trả handle để lái/soi.
 *
 * @param {object} [options]
 * @param {string} [options.html] HTML nguồn để biết id nào có thật (mặc định: `webapp.html`).
 * @param {object} [options.config] Đối tượng gán vào `window.MORPHO_CONFIG`.
 * @param {Function} [options.fetchImpl] Thay `fetch` (mặc định: `offlineFetch`).
 * @param {object|null} [options.ethereum] `window.ethereum` giả (EIP-1193) hoặc `null`.
 * @param {Set<string>} [options.selfInjectedIds] id do module tự chèn ⇒ tra ra `null` vẫn hợp lệ.
 * @param {string} [options.readyState] `document.readyState` (`"loading"` ⇒ app chờ DOMContentLoaded).
 * @param {boolean} [options.confirmResult] Giá trị `confirm()` trả về.
 */
export function installBrowserEnv({
  html = readWebappHtml(),
  config = {},
  fetchImpl = offlineFetch,
  ethereum = null,
  selfInjectedIds = new Set(),
  readyState = "loading",
  confirmResult = false,
} = {}) {
  const htmlIds = declaredHtmlIds(html);
  const elements = new Map();
  const injectedIds = new Set();
  const requestedIds = new Set();
  const unknownIds = [];

  const createElement = (id) => {
    const element = makeElement(id);
    hookInnerHtml(element, registerInjected);
    return element;
  };

  function registerInjected(markup) {
    for (const [, id] of String(markup).matchAll(/id="([^"]+)"/g)) {
      if (elements.has(id)) continue;
      elements.set(id, createElement(id));
      injectedIds.add(id);
    }
  }

  for (const id of htmlIds) elements.set(id, createElement(id));

  const documentListeners = new Map();
  const documentStub = {
    readyState,
    title: "",
    body: createElement("body"),
    documentElement: createElement("html"),
    getElementById(id) {
      requestedIds.add(id);
      const found = elements.get(id);
      if (found) return found;
      if (!selfInjectedIds.has(id)) unknownIds.push(id);
      return null;
    },
    querySelector: (selector) => makeElement(selector),
    querySelectorAll: () => [],
    createElement: (tag) => createElement(tag),
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatchEvent() { return true; },
  };

  const locationStub = {
    href: "http://127.0.0.1:3999/",
    search: "",
    origin: "http://127.0.0.1:3999",
    pathname: "/",
    hash: "",
  };

  const sessionStorage = createStorage();
  const localStorage = createStorage();

  const windowStub = {
    MORPHO_CONFIG: config,
    ethereum,
    location: locationStub,
    sessionStorage,
    localStorage,
    document: documentStub,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    alert() {},
    open() {},
  };

  const saved = new Map();
  for (const name of GLOBAL_NAMES) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const setGlobal = (name, value) => {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  setGlobal("window", windowStub);
  setGlobal("document", documentStub);
  setGlobal("location", locationStub);
  setGlobal("sessionStorage", sessionStorage);
  setGlobal("localStorage", localStorage);
  setGlobal("confirm", () => confirmResult);
  setGlobal("alert", () => {});
  setGlobal("fetch", fetchImpl);

  const restore = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    saved.clear();
    documentListeners.clear();
  };

  /** Bắn DOMContentLoaded như browser: mọi listener (thường là `init`) chạy tuần tự và await được. */
  const fireDomContentLoaded = async () => {
    const listeners = documentListeners.get("DOMContentLoaded") ?? [];
    for (const fn of listeners) await fn();
  };

  return {
    window: windowStub,
    document: documentStub,
    location: locationStub,
    sessionStorage,
    localStorage,
    elements,
    injectedIds,
    requestedIds,
    unknownIds,
    documentListeners,
    htmlIds,
    fireDomContentLoaded,
    restore,
  };
}
