/**
 * Audit A.1 — route phục vụ module chính của webapp.
 *
 * Trước đây script chính nằm INLINE trong webapp.html nên không cần route nào.
 * Sau khi tách ra webapp-app.mjs, trang chỉ còn `<script type="module" src>`:
 * nếu route này sai (MIME, bị SPA fallback trả text/html, hoặc 404), trang tải
 * được nhưng KHÔNG có JS nào chạy — UI chết lặng mà không có gì đỏ trong repo.
 * Vì vậy nó được ghim bằng test chạy trên `createRequestHandler` thật.
 */
import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import { createRequestHandler } from "../webapp-handler.mjs";

const markets = [{ id: "0x" + "a".repeat(64) }];
const APP_SOURCE = "// app\nwindow.deleteTierFromBundle = function () {};\n";
const LOGIC_SOURCE = "// logic\nexport const wadToPercent = (wad) => wad;\n";
const RENDER_SOURCE = "// render\nexport const esc = (v) => String(v);\n";
const WALLET_SOURCE = "// wallet\nexport const getWalletProviderName = () => null;\n";

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

const withApp = await listen(createRequestHandler({
  markets,
  content: "<html>x</html>",
  appScript: APP_SOURCE,
  logicScript: LOGIC_SOURCE,
  scripts: {
    "webapp-render.mjs": RENDER_SOURCE,
    "webapp-wallet.mjs": WALLET_SOURCE,
  },
}));
const withoutApp = await listen(createRequestHandler({ markets, content: "<html>x</html>" }));
const appOnly = await listen(createRequestHandler({ markets, content: "<html>x</html>", appScript: APP_SOURCE }));
afterAll(() => Promise.all(
  [withApp, withoutApp, appOnly].map(({ server }) => new Promise((resolve) => server.close(resolve))),
));

describe("A.1 — GET /webapp-app.mjs", () => {
  it("phục vụ module với MIME đúng và không cache", async () => {
    const resp = await fetch(`http://127.0.0.1:${withApp.port}/webapp-app.mjs`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    // Module đổi giữa các lần deploy: browser giữ bản cũ sẽ chạy JS lệch HTML.
    expect(resp.headers.get("cache-control")).toBe("no-store");
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(resp.text()).resolves.toBe(APP_SOURCE);
  });

  it("không truyền appScript ⇒ 404 JSON, KHÔNG rơi vào SPA fallback (trả HTML 200)", async () => {
    const resp = await fetch(`http://127.0.0.1:${withoutApp.port}/webapp-app.mjs`);
    expect(resp.status).toBe(404);
    expect(resp.headers.get("content-type")).toContain("application/json");
  });

  it("không che các route API: /api/... vẫn trả 404 JSON của nó", async () => {
    const resp = await fetch(`http://127.0.0.1:${withApp.port}/api/khong-ton-tai`);
    expect(resp.status).toBe(404);
    expect(await resp.json()).toMatchObject({ ok: false });
  });

  it("trang chính vẫn được phục vụ như cũ (không bị route mới chen ngang)", async () => {
    const resp = await fetch(`http://127.0.0.1:${withApp.port}/`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");
    await expect(resp.text()).resolves.toBe("<html>x</html>");
  });
});

describe("A.1b — GET /webapp-logic.mjs (module logic dùng chung)", () => {
  it("phục vụ module với MIME đúng và không cache", async () => {
    const resp = await fetch(`http://127.0.0.1:${withApp.port}/webapp-logic.mjs`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(resp.headers.get("cache-control")).toBe("no-store");
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(resp.text()).resolves.toBe(LOGIC_SOURCE);
  });

  it("thiếu module logic ⇒ 404 JSON, không trả HTML 200 (browser bỏ qua import hỏng)", async () => {
    const resp = await fetch(`http://127.0.0.1:${appOnly.port}/webapp-logic.mjs`);
    expect(resp.status).toBe(404);
    expect(resp.headers.get("content-type")).toContain("application/json");
  });
});

describe("P2.7 — GET module browser tách (webapp-render / webapp-wallet)", () => {
  for (const [name, source] of [["webapp-render.mjs", RENDER_SOURCE], ["webapp-wallet.mjs", WALLET_SOURCE]]) {
    it(`phục vụ /${name} với MIME đúng và không cache`, async () => {
      const resp = await fetch(`http://127.0.0.1:${withApp.port}/${name}`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(resp.headers.get("cache-control")).toBe("no-store");
      expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
      await expect(resp.text()).resolves.toBe(source);
    });

    it(`không cấu hình /${name} ⇒ 404 JSON, không rơi vào SPA fallback`, async () => {
      const resp = await fetch(`http://127.0.0.1:${appOnly.port}/${name}`);
      expect(resp.status).toBe(404);
      expect(resp.headers.get("content-type")).toContain("application/json");
    });
  }

  it("tên module lạ có đuôi .mjs vẫn 404 JSON (route map không đoán file)", async () => {
    const resp = await fetch(`http://127.0.0.1:${withApp.port}/khong-co.mjs`);
    expect(resp.status).toBe(404);
    expect(resp.headers.get("content-type")).toContain("application/json");
  });
});
