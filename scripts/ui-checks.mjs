#!/usr/bin/env node
/**
 * Cổng UI THẬT bằng browser thật (Tầng B của plan "test và check lỗi UI trên CI trước khi merge",
 * 2026-09-26).
 *
 * VÌ SAO CẦN: toàn bộ `npm run check` chạy trên DOM giả (`__tests__/helpers/dom-stub.mjs`) — không có
 * layout, không có module thật được nạp, không có JS của trang chạy. Lỗi "nút xoá tier quá to và không
 * đồng đều" (nút 🗑 rộng 255px/324px, hàng cao 80px) KHÔNG một test nào trong đó có thể thấy. Cổng này
 * bù đúng hai khoảng trống đó:
 *
 *   1. LỖI RUNTIME thật: exception không bắt được (`pageerror`), `console.error`, request thất bại,
 *      HTTP ≥ 400 — với danh sách trắng NÊU TÊN, không có kiểu "bỏ qua mọi lỗi".
 *   2. BẤT BIẾN LAYOUT thật, đo bằng `getBoundingClientRect()` ở hai viewport (644×1355 — đúng cảnh
 *      trong báo lỗi — và 1280×900).
 *
 * Ba thứ nó cố tình dùng ĐÚNG production: `webapp-server.mjs` thật (spawn tiến trình con), `webapp.html`
 * thật + toàn bộ module browser thật, và đường đăng nhập HMAC thật (`createSessionToken`). Không có đồ
 * giả nào cho phần UI — chỉ registry và market là fixture.
 *
 * RPC trỏ vào `http://127.0.0.1:1` (cổng chết) là CHỦ Ý: mục "Bundle Hiện Tại Trên Server" đọc từ
 * server chứ không cần RPC, nên phép đo không phụ thuộc mạng ngoài và không tốn quota. Mọi lỗi liên
 * quan tới đúng địa chỉ đó nằm trong danh sách trắng có ghi lý do (xem `WHITELIST`).
 *
 * Dùng:
 *   npm run ui:check                 chạy headless, exit 0/1, ghi `test-results/ui/`
 *   npm run ui:check -- --keep-open  giữ server + browser mở để soi bằng mắt (in cả URL + token)
 *   UI_HEADED=1 npm run ui:check     mở browser thật (cần `npx playwright install chromium`)
 *
 * Nguyên tắc fail closed (bài học D10 của repo): nếu không QUAN SÁT ĐƯỢC UI (không thấy nút, không thấy
 * rung, mục bundle không hiện) thì ĐỎ — "không thấy gì" không bao giờ được tính là "không có lỗi".
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(ROOT, "ci-fixture");
const ENV_FILE = path.join(FIXTURE_DIR, ".env");
const MARKETS_FILE = path.join(FIXTURE_DIR, "markets.json");
const REGISTRY_FILE = path.join(FIXTURE_DIR, "presigned.json");
const OUT_DIR = path.join(ROOT, "test-results", "ui");

// ---- Fixture (khớp đúng cảnh trong ảnh báo lỗi của người dùng) ----
const MARKET_ID = "0x" + "a".repeat(64);
const LENDER_ADDRESS = "0x" + "1".repeat(40);
/** Mật khẩu fixture — KHÔNG phải secret của deployment, chỉ để đi đúng đường HMAC thật của server. */
const FIXTURE_PASSWORD = "ci-fixture-secret";
const DEAD_RPC = "http://127.0.0.1:1";
const SHARES_WEI = "415352576301950512";

// ---- Ngưỡng, lấy từ SỐ ĐO THẬT (browser thật, viewport 644px) ----
/** Nút phụ trong hàng: đo được 28–29px = 5–6% bề rộng hàng; lỗi là 49%/63%. */
const MAX_BUTTON_PCT_OF_ROW = 25;
/** Chiều cao nút: đo được 22px; lỗi (padding 14px + margin 8px 0) là 51px. */
const MAX_BUTTON_HEIGHT_PX = 40;
/** Chiều cao hàng đầu rung: đo được 35–39px; lỗi là 80px. */
const MAX_RUNG_ROW_HEIGHT_PX = 48;
/** Hai nút cùng loại phải "đồng đều": đo được lệch 0–1px; lỗi là 255 vs 324 (lệch 69px). */
const UNIFORM_TOLERANCE_PX = 2;
/** Vùng bấm tối thiểu của control đang hiển thị (bắt control bị che/0×0). */
const MIN_HIT_AREA_PX = 16;
/** Fail closed: bậc thang hai rung phải cho ra 5 nút xoá (3 ✕ + 2 🗑). */
const MIN_REMOVE_BUTTONS = 5;

const VIEWPORTS = [
  { name: "mobile", width: 644, height: 1355 },
  { name: "desktop", width: 1280, height: 900 },
];

const argv = process.argv.slice(2);
const KEEP_OPEN = argv.includes("--keep-open") || /^(1|true)$/i.test(process.env.UI_KEEP_OPEN || "");
const HEADED = argv.includes("--headed") || /^(1|true)$/i.test(process.env.UI_HEADED || "");

// ============================================================
// Báo cáo
// ============================================================
const checks = [];
const problems = [];

function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  return Boolean(ok);
}

/**
 * Danh sách trắng NÊU TÊN — mỗi mục phải kèm lý do. Không có mục "bỏ qua tất cả".
 * `url` khớp tiền tố, hoặc `text` khớp chuỗi con.
 */
const WHITELIST = [
  {
    url: DEAD_RPC,
    reason: "RPC công khai trỏ vào cổng chết có chủ ý (bundle đọc từ server, không cần RPC)",
  },
  {
    url: "/favicon.ico",
    reason: "favicon không phải một phần của UI; thiếu file không làm hỏng trang",
  },
  {
    text: DEAD_RPC,
    reason: "thông báo lỗi RPC có nhắc đúng địa chỉ cổng chết ở trên",
  },
  {
    text: "ERR_UNSAFE_PORT",
    reason: "Chromium từ chối cổng 1 (unsafe port) — hệ quả của cổng chết ở trên, không phải lỗi UI",
  },
];

const whitelisted = ({ url = "", text = "" }) =>
  WHITELIST.find((w) => (w.url && url.includes(w.url)) || (w.text && text.includes(w.text)));

// ============================================================
// Fixture + server thật
// ============================================================
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Registry seed: ĐÚNG hai rung `pending` như ảnh báo lỗi (2553 có tier tiền + all-shares). */
function writeFixture(port) {
  fs.mkdirSync(path.join(FIXTURE_DIR, "config"), { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tier = (label, amountWei, amountFormatted) => ({
    label, amountWei, amountFormatted, txHash: "0x" + "1".repeat(64),
  });
  const allShares = {
    type: "all-shares",
    sharesWei: SHARES_WEI,
    amountWei: "0",
    amountFormatted: "Toàn bộ shares",
    label: "Rút toàn bộ shares",
    txHash: "0x" + "0".repeat(64),
  };
  const bundles = {
    [`${MARKET_ID}@2553`]: {
      marketId: MARKET_ID, nonce: 2553, status: "pending",
      withdrawals: [tier("100 USDC", "100000000", "100 USDC"), allShares],
    },
    [`${MARKET_ID}@2554`]: {
      marketId: MARKET_ID, nonce: 2554, status: "pending",
      withdrawals: [allShares],
    },
  };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ version: 2, bundles }, null, 2));

  fs.writeFileSync(MARKETS_FILE, JSON.stringify({
    version: 1,
    markets: [{ id: MARKET_ID, minLiquidity: "100", suddenDrainMultiplier: 2 }],
  }, null, 2));

  // Cấu hình tối thiểu để webapp-server chạy được. `WEBAPP_PASSWORD` có mặt ⇒ đi đúng đường HMAC
  // thật (không dùng dev mode "mọi request đều đã xác thực") và không cần WEBAPP_ALLOW_INSECURE.
  fs.writeFileSync(ENV_FILE, [
    `LENDER_ADDRESS=${LENDER_ADDRESS}`,
    `PROXY_RPC_URL=${DEAD_RPC}`,
    `PUBLIC_RPC_URLS=${DEAD_RPC}`,
    `WEBAPP_PORT=${port}`,
    `WEBAPP_PASSWORD=${FIXTURE_PASSWORD}`,
    "MARKETS_FILE=./ci-fixture/markets.json",
    "PRESIGNED_FILE=./ci-fixture/presigned.json",
    "",
  ].join("\n"));
}

function startServer() {
  const child = spawn(process.execPath, [`--env-file=${ENV_FILE}`, path.join(ROOT, "webapp-server.mjs")], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  const collect = (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 400) logs.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return { child, logs, tail: () => logs.join("") };
}

async function waitForServer(baseUrl, server, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`webapp-server thoát sớm (exit ${server.child.exitCode}):\n${server.tail()}`);
    }
    try {
      const resp = await fetch(baseUrl + "/");
      if (resp.ok) return;
    } catch {
      // chưa listen — thử lại
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`webapp-server không trả lời sau ${timeoutMs}ms:\n${server.tail()}`);
}

// ============================================================
// Phép đo trong trang
// ============================================================
/**
 * Chạy TRONG trang. Trả về mọi thứ cần cho các khẳng định (thuần dữ liệu, không assert ở đây để thông
 * báo lỗi nằm phía Node).
 */
function measureInPage() {
  const round = (n) => Math.round(n);
  const box = (el) => el.getBoundingClientRect();
  const visible = (el) => {
    const r = box(el);
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };

  const ladder = document.getElementById("presign-existing-info");
  const section = document.getElementById("presign-existing");
  const rows = [...ladder.querySelectorAll(":scope > div")].filter((el) => el.querySelector(".btn-remove"));
  const removeButtons = [...ladder.querySelectorAll(".btn-remove")];

  const rungRows = [...ladder.querySelectorAll(":scope > div > .row")].filter(
    (row) => !row.classList.contains("bundle-tier-row") && row.querySelector(".btn-remove")
  );

  const controls = [...ladder.querySelectorAll("button")]
    .filter(visible)
    .map((el) => ({ text: el.textContent.trim(), ...size(el) }));

  function size(el) {
    const r = box(el);
    return { w: round(r.width), h: round(r.height) };
  }

  return {
    sectionDisplay: section ? getComputedStyle(section).display : "missing",
    rungCount: rows.length,
    overflow: {
      scrollWidth: document.scrollingElement.scrollWidth,
      clientWidth: document.scrollingElement.clientWidth,
    },
    buttons: removeButtons.map((el) => {
      const row = el.closest(".row");
      const rowHeight = row ? round(box(row).height) : null;
      const rowWidth = row ? round(box(row).width) : null;
      const s = size(el);
      return {
        text: el.textContent.trim(),
        rowClass: row ? row.className : "",
        ...s,
        rowHeight,
        pctOfRow: rowWidth ? Math.round((s.w / rowWidth) * 100) : null,
        visible: visible(el),
      };
    }),
    rungRowHeights: rungRows.map((row) => round(box(row).height)),
    controls,
  };
}

// ============================================================
// Khẳng định
// ============================================================
function assertMeasurement(label, m) {
  check(`${label}: mục bundle HIỆN (display:block)`, m.sectionDisplay === "block", `display=${m.sectionDisplay}`);
  check(`${label}: ≥ 1 rung đọc được từ server`, m.rungCount >= 1, `${m.rungCount} rung`);
  check(
    `${label}: đủ nút xoá để đo (fail closed)`,
    m.buttons.length >= MIN_REMOVE_BUTTONS,
    `${m.buttons.length} nút (cần ≥ ${MIN_REMOVE_BUTTONS})`
  );
  check(
    `${label}: không tràn ngang`,
    m.overflow.scrollWidth <= m.overflow.clientWidth + 1,
    `scrollWidth=${m.overflow.scrollWidth} clientWidth=${m.overflow.clientWidth}`
  );

  const byText = new Map();
  for (const b of m.buttons) {
    const where = `"${b.text}" trong .${b.rowClass || "(không hàng)"}`;
    check(
      `${label}: ${where} không giãn toàn khối`,
      b.pctOfRow !== null && b.pctOfRow <= MAX_BUTTON_PCT_OF_ROW,
      `rộng ${b.w}px = ${b.pctOfRow}% bề rộng hàng (ngưỡng ${MAX_BUTTON_PCT_OF_ROW}%)`
    );
    check(
      `${label}: ${where} không cao như nút khối`,
      b.h <= MAX_BUTTON_HEIGHT_PX,
      `cao ${b.h}px (ngưỡng ${MAX_BUTTON_HEIGHT_PX}px)`
    );
    byText.set(b.text, [...(byText.get(b.text) || []), b]);
  }

  for (const rowHeight of m.rungRowHeights) {
    check(
      `${label}: hàng đầu rung không bị nút đội lên`,
      rowHeight <= MAX_RUNG_ROW_HEIGHT_PX,
      `cao ${rowHeight}px (ngưỡng ${MAX_RUNG_ROW_HEIGHT_PX}px)`
    );
  }

  // "Không đồng đều" là triệu chứng thứ hai trong báo lỗi: cùng một nút, hai rung cho hai bề rộng.
  for (const [text, group] of byText) {
    const widths = group.map((b) => b.w);
    const spread = Math.max(...widths) - Math.min(...widths);
    check(
      `${label}: nút "${text}" ĐỒNG ĐỀU giữa các rung`,
      group.length < 2 || spread <= UNIFORM_TOLERANCE_PX,
      `${group.length} nút, bề rộng ${widths.join("/")} (lệch ${spread}px, ngưỡng ${UNIFORM_TOLERANCE_PX}px)`
    );
  }

  for (const c of m.controls) {
    check(
      `${label}: control "${c.text}" có vùng bấm thật`,
      c.w >= MIN_HIT_AREA_PX && c.h >= MIN_HIT_AREA_PX,
      `${c.w}×${c.h}px (cần ≥ ${MIN_HIT_AREA_PX}×${MIN_HIT_AREA_PX})`
    );
  }
}

// ============================================================
// Chạy
// ============================================================
async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  writeFixture(port);

  // ⚠️ `shared.mjs` đọc env LÚC MODULE LOAD ⇒ phải set trước khi import `auth.mjs`, nếu không token
  // được ký bằng secret khác với secret của server và mọi request trả 401.
  process.env.WEBAPP_PASSWORD = FIXTURE_PASSWORD;
  const { createSessionToken } = await import("../auth.mjs");
  const token = createSessionToken(LENDER_ADDRESS, 60 * 60 * 1000);

  const server = startServer();
  let browser;
  const measurements = {};
  try {
    await waitForServer(baseUrl, server);
    console.log(`▶ webapp thật đang chạy tại ${baseUrl} (fixture: ${path.relative(ROOT, FIXTURE_DIR)})`);

    browser = await chromium.launch({ headless: !HEADED });
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      // Đăng nhập trước khi script của trang chạy — cùng khoá mà `webapp-shell.mjs` đọc.
      await context.addInitScript((t) => {
        sessionStorage.setItem("morpho-session-token", t);
        sessionStorage.setItem("morpho-session-expires", String(Date.now() + 3600_000));
      }, token);
      const page = await context.newPage();

      page.on("pageerror", (err) => problems.push({ kind: "pageerror", text: err.message }));
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const url = msg.location()?.url || "";
        problems.push({ kind: "console", text: msg.text(), url });
      });
      page.on("requestfailed", (req) => problems.push({ kind: "requestfailed", url: req.url(), text: req.failure()?.errorText || "" }));
      page.on("response", (resp) => {
        if (resp.status() < 400) return;
        problems.push({ kind: "http", status: resp.status(), url: resp.url() });
      });

      const label = `${viewport.name} ${viewport.width}×${viewport.height}`;
      await page.goto(`${baseUrl}/?market=${MARKET_ID}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof window.switchTab === "function", null, { timeout: 15_000 });
      await page.evaluate(async () => {
        await window.switchTab("presign");
        await window.fetchExistingBundle();
      });
      await page.waitForSelector("#presign-existing-info .btn-remove", { timeout: 15_000 });

      assertMeasurement(`${label} (lần đầu)`, await page.evaluate(measureInPage));

      // Chuyển tab rồi quay lại: mục bundle phải tự dựng lại (đường hồi quy của chẩn đoán D18) và
      // layout sau khi dựng lại phải giống hệt — đo lần hai, không tin lần đầu.
      await page.evaluate(async () => {
        await window.switchTab("withdraw");
      });
      await page.evaluate(async () => {
        await window.switchTab("presign");
        await window.fetchExistingBundle();
      });
      await page.waitForSelector("#presign-existing-info .btn-remove", { timeout: 15_000 });
      const second = await page.evaluate(measureInPage);
      assertMeasurement(`${label} (sau khi chuyển tab)`, second);

      measurements[viewport.name] = second;
      fs.mkdirSync(OUT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(OUT_DIR, `${viewport.name}.png`) });
      await context.close();
    }

    // Lỗi runtime: lọc qua danh sách trắng NÊU TÊN, rồi khẳng định phần còn lại rỗng.
    const unexpected = problems.filter((p) => !whitelisted(p));
    for (const p of problems) {
      const w = whitelisted(p);
      if (w) console.log(`  ⏭  bỏ qua (có chủ ý): ${p.kind} ${p.url || ""} ${p.text || ""} — ${w.reason}`);
    }
    check(
      "không có lỗi runtime ngoài danh sách trắng (pageerror / console.error / request lỗi / HTTP≥400)",
      unexpected.length === 0,
      unexpected.length === 0
        ? "0 lỗi"
        : `${unexpected.length} lỗi:\n${unexpected.map((p) => `      - ${p.kind} ${p.status || ""} ${p.url || ""} ${p.text || ""}`).join("\n")}`
    );
  } finally {
    const report = {
      baseUrl,
      fixture: { market: MARKET_ID, lender: LENDER_ADDRESS, registry: path.relative(ROOT, REGISTRY_FILE) },
      thresholds: {
        MAX_BUTTON_PCT_OF_ROW, MAX_BUTTON_HEIGHT_PX, MAX_RUNG_ROW_HEIGHT_PX,
        UNIFORM_TOLERANCE_PX, MIN_HIT_AREA_PX, MIN_REMOVE_BUTTONS,
      },
      measurements,
      problems,
      checks,
      serverLogTail: server.tail().slice(-4000),
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));

    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) console.log(`  ${c.ok ? "✅" : "❌"} ${c.name} — ${c.detail}`);
    console.log(`\n${checks.length - failed.length}/${checks.length} khẳng định đạt · báo cáo: ${path.relative(ROOT, path.join(OUT_DIR, "report.json"))}`);

    if (failed.length > 0) {
      console.error(`\n❌ Cổng UI ĐỎ — ${failed.length} khẳng định không đạt:`);
      for (const c of failed) console.error(`   - ${c.name} — ${c.detail}`);
      console.error(`\n   Ảnh chụp + số đo: ${path.relative(ROOT, OUT_DIR)}`);
    }

    if (KEEP_OPEN) {
      console.log(`\n🔎 --keep-open: server vẫn chạy tại ${baseUrl}/?market=${MARKET_ID}`);
      console.log(`   Token fixture (dán vào sessionStorage["morpho-session-token"] nếu cần): ${token}`);
      console.log("   Ctrl+C để dừng.");
      await new Promise((resolve) => process.on("SIGINT", resolve));
    }

    if (browser) await browser.close().catch(() => {});
    server.child.kill("SIGTERM");
    setTimeout(() => server.child.kill("SIGKILL"), 2000).unref();

    if (failed.length > 0) process.exitCode = 1;
  }
}

await main();
