/**
 * Kênh cảnh báo VÒNG ĐỜI presign (audit R1) — tách hẳn khỏi cảnh báo thanh khoản.
 *
 * Cảnh báo thanh khoản đi qua `shouldNotify()` và tiêu quota ngày; cảnh báo vòng
 * đời thì KHÔNG: nó báo "bậc thang không thể tiến" — claim bị tx khác thay thế
 * (`superseded`), claim cần đối soát tay (`stuck`), hay hai claim cùng nonce
 * (`conflict`). Trước đây các tình huống này chỉ nằm trong log mỗi chu kỳ, nên
 * người vận hành không biết monitor đã ngừng broadcast.
 *
 * Audit vòng 2 (D2) thêm hai kind nữa, cũng là "bậc thang không tiến":
 *   - `invalid`: verify bundle thất bại (lỗi thuộc nội dung) ⇒ không bao giờ broadcast.
 *   - `config`:  verify thất bại vì lệch .env ⇒ TẠM DỪNG, bundle vẫn còn nguyên.
 *
 * Vì một claim kẹt lặp lại mỗi chu kỳ (mặc định 30s), phải có cooldown theo
 * (kind, id). Mọi logic ở đây là hàm thuần hoặc nhận I/O inject được: monitor.mjs
 * có side effect ở module-level (loadMarkets/setInterval) nên không import được
 * trong vitest.
 */

/** Cửa sổ chống spam cho một (kind, id): mặc định 6 giờ. */
export const LIFECYCLE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Các loại cảnh báo vòng đời: tiêu đề + tag + priority ntfy.
 * Priority "5" = max (kẹt/không thể tiến), "4" = cảnh báo mức cao.
 */
const ALERT_KINDS = {
  superseded: { title: "Morpho: presigned tx bị thay thế", tags: "warning,arrows_counterclockwise", priority: "4" },
  stuck: { title: "Morpho: presign cần xử lý TAY", tags: "rotating_light,warning", priority: "5" },
  conflict: { title: "Morpho: xung đột nonce presign", tags: "rotating_light,warning", priority: "5" },
  // Audit vòng 2 (D2): bundle verify hỏng — không bao giờ broadcast được, phải ký lại.
  invalid: { title: "Morpho: presigned bundle KHÔNG hợp lệ", tags: "rotating_light,x", priority: "5" },
  // Lệch .env: bundle vẫn tốt, monitor tạm dừng rung này cho tới khi sửa cấu hình.
  config: { title: "Morpho: cấu hình lệch bundle đã ký", tags: "warning,wrench", priority: "4" },
};

/** Rút gọn id/address cho thông báo đọc trên điện thoại. */
function short(value, head = 10, tail = 6) {
  const text = String(value ?? "?");
  return text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
}

/**
 * Quyết định có gửi cảnh báo hay không (thuần, test được).
 * @param {string} kind
 * @param {string} id - danh tính đối tượng (claim id, hoặc nonce cho conflict)
 * @param {{ lastSentAt?: number|null, now?: number, cooldownMs?: number }} [opts]
 * @returns {{ send: boolean, reason: string }}
 */
export function shouldSendLifecycleAlert(kind, id, { lastSentAt = null, now = Date.now(), cooldownMs = LIFECYCLE_ALERT_COOLDOWN_MS } = {}) {
  if (!Object.hasOwn(ALERT_KINDS, kind)) return { send: false, reason: "unknown_kind" };
  if (!id) return { send: false, reason: "missing_id" };
  if (lastSentAt != null && now - lastSentAt < cooldownMs) return { send: false, reason: "cooldown" };
  return { send: true, reason: "ok" };
}

/**
 * Nội dung cảnh báo (thuần): tiếng Việt, nêu rõ hậu quả và hành động cụ thể.
 * @returns {{ title: string, tags: string, priority: string, message: string } | null}
 */
export function buildLifecycleAlert(kind, { id, marketId, nonce, tier, detail } = {}) {
  const spec = ALERT_KINDS[kind];
  if (!spec) return null;
  const header = [
    `Market: ${short(marketId)}`,
    nonce != null ? `Nonce: ${nonce}` : null,
    tier ? `Tier: ${tier}` : null,
    `Bundle: ${short(id)}`,
  ].filter(Boolean).join("\n");

  if (kind === "superseded") {
    return {
      ...spec,
      message: [
        "**Tx đã ký bị THAY THẾ** — nonce đã bị một giao dịch khác tiêu thụ, chữ ký cũ không thể lên bảng.",
        "",
        header,
        "",
        detail ? `Bằng chứng: ${detail}` : null,
        "",
        "Monitor đã nhả claim nên bậc thang tiến tiếp được. Muốn rút tier này: mở webapp → lấy nonce mới → ký lại.",
      ].filter((line) => line !== null).join("\n"),
    };
  }
  if (kind === "invalid") {
    return {
      ...spec,
      message: [
        "**Bundle KHÔNG hợp lệ** — verify calldata thất bại nên bundle này sẽ KHÔNG BAO GIỜ được broadcast.",
        "",
        header,
        "",
        detail ? `Lỗi: ${detail}` : null,
        "",
        "Hành động: mở webapp → xoá rung này → lấy nonce mới và ký lại tier bạn muốn rút.",
      ].filter((line) => line !== null).join("\n"),
    };
  }
  if (kind === "config") {
    return {
      ...spec,
      message: [
        "**Cấu hình lệch** — bundle đã ký không khớp .env hiện tại, monitor TẠM DỪNG rung này.",
        "",
        header,
        "",
        detail ? `Chi tiết: ${detail}` : null,
        "",
        "Bundle vẫn được giữ nguyên (không bị đánh hỏng). Sửa .env cho khớp lúc ký (LENDER_ADDRESS / MORPHO_BLUE_ADDRESS) rồi khởi động lại — monitor sẽ tự broadcast tiếp.",
      ].filter((line) => line !== null).join("\n"),
    };
  }
  if (kind === "conflict") {
    return {
      ...spec,
      message: [
        "**Xung đột nonce** — hai claim cùng nonce, monitor KHÔNG gửi gì (fail closed).",
        "",
        header,
        "",
        detail ? `Chi tiết: ${detail}` : null,
        "",
        "Cần đối soát registry (data/presigned.json) trước khi ký tiếp.",
      ].filter((line) => line !== null).join("\n"),
    };
  }
  return {
    ...spec,
    message: [
      "**Claim cần xử lý tay** — bậc thang đang bị chặn (có thể không tiến được nữa).",
      "",
      header,
      "",
      detail ? `Chi tiết: ${detail}` : null,
      "",
      "Kiểm tra on-chain nonce/txHash trước khi sửa registry; xem log monitor để biết chi tiết từng chu kỳ.",
    ].filter((line) => line !== null).join("\n"),
  };
}

/** Timeout cho một lần POST ntfy — ntfy treo KHÔNG được chặn chu kỳ monitor. */
export const NTFY_ALERT_TIMEOUT_MS = 10_000;

/**
 * POST một alert lên ntfy (I/O inject được). Throw khi ntfy trả non-ok để caller
 * quyết định (không tự tiêu quota — quota chỉ thuộc cảnh báo thanh khoản).
 * `signal` bị abort sau NTFY_ALERT_TIMEOUT_MS: cảnh báo vòng đời chạy trong chu
 * kỳ checkMarkets, nên một endpoint treo không được giữ scheduler.
 */
export async function postNtfy({ fetchImpl = fetch, server, topic, alert, timeoutMs = NTFY_ALERT_TIMEOUT_MS }) {
  const response = await fetchImpl(`${server}/${topic}`, {
    method: "POST",
    headers: {
      Title: alert.title,
      Tags: alert.tags,
      Priority: alert.priority,
      Markdown: "yes",
    },
    body: alert.message,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`ntfy responded ${response.status}`);
  return { ok: true };
}

/**
 * Bọc cooldown quanh một hàm gửi. `notify` không bao giờ throw ra ngoài: lỗi gửi
 * chỉ được log (monitor không được chết vì kênh thông báo).
 */
export function createLifecycleAlerter({ send, cooldownMs = LIFECYCLE_ALERT_COOLDOWN_MS, now = () => Date.now(), logger = console } = {}) {
  const lastSent = new Map();
  return {
    /**
     * @param {string} kind - "superseded" | "stuck" | "conflict"
     * @param {{ id?: string, marketId?: string, nonce?: number|string, tier?: string, detail?: string }} info
     */
    async notify(kind, info = {}) {
      const id = info.id ?? (info.nonce != null ? `nonce-${info.nonce}` : null);
      const key = `${kind}:${id}`;
      const decision = shouldSendLifecycleAlert(kind, id, { lastSentAt: lastSent.get(key) ?? null, now: now(), cooldownMs });
      if (!decision.send) return { sent: false, reason: decision.reason };
      const alert = buildLifecycleAlert(kind, { ...info, id });
      if (!alert) return { sent: false, reason: "unknown_kind" };
      // Đánh dấu TRƯỚC khi gửi: lỗi gửi cũng không được biến thành spam mỗi chu kỳ.
      lastSent.set(key, now());
      try {
        await send(alert);
        return { sent: true, reason: "ok" };
      } catch (err) {
        logger?.error?.(`[presign] lifecycle alert (${kind}) failed: ${err?.message || err}`);
        return { sent: false, reason: "send_failed" };
      }
    },
  };
}
