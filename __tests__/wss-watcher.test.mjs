/**
 * Tests for WebSocket watcher logic (hybrid trigger).
 *
 * Các hàm trong monitor.mjs (debouncedCheck, startWsWatcher, stopWsWatcher)
 * sử dụng module-level state và import từ viem nên không thể import trực tiếp.
 * File test này dupliate logic thuật toán cốt lõi để verify behavior,
 * theo pattern tương tự như presign-broadcast.test.mjs và ntfy.test.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================
// Duplicate: debouncedCheck logic từ monitor.mjs
// ============================================================

/**
 * Factory tạo debouncedCheck giống hệt logic trong monitor.mjs.
 * Tách biệt với module-level state để test độc lập.
 */
function createDebouncedCheck(checkFn, debounceMs, getCheckInProgress) {
  let debounceTimer = null;

  return function debouncedCheck() {
    if (getCheckInProgress()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      checkFn();
    }, debounceMs);
  };
}

describe("debouncedCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gọi checkFn sau đúng debounce window (3000ms)", () => {
    const checkFn = vi.fn();
    const getCheckInProgress = () => false;
    const debounced = createDebouncedCheck(checkFn, 3000, getCheckInProgress);

    debounced();
    expect(checkFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2999);
    expect(checkFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(checkFn).toHaveBeenCalledTimes(1);
  });

  it("gộp nhiều calls trong debounce window thành 1 lần gọi checkFn", () => {
    const checkFn = vi.fn();
    const getCheckInProgress = () => false;
    const debounced = createDebouncedCheck(checkFn, 3000, getCheckInProgress);

    // 5 events trong vòng 2 giây — chỉ trigger 1 lần check
    debounced();
    vi.advanceTimersByTime(500);
    debounced();
    vi.advanceTimersByTime(500);
    debounced();
    vi.advanceTimersByTime(500);
    debounced();
    vi.advanceTimersByTime(500);
    debounced();

    expect(checkFn).not.toHaveBeenCalled();

    // Sau debounce window, chỉ gọi 1 lần
    vi.advanceTimersByTime(3000);
    expect(checkFn).toHaveBeenCalledTimes(1);
  });

  it("mỗi call reset lại debounce timer về đầu", () => {
    const checkFn = vi.fn();
    const getCheckInProgress = () => false;
    const debounced = createDebouncedCheck(checkFn, 3000, getCheckInProgress);

    debounced();
    vi.advanceTimersByTime(2500); // sắp hết debounce window
    debounced();                   // reset timer!
    vi.advanceTimersByTime(2500); // mới chỉ 2500ms sau lần reset
    expect(checkFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);  // đủ 3000ms sau lần reset
    expect(checkFn).toHaveBeenCalledTimes(1);
  });

  it("không gọi checkFn nếu checkInProgress = true", () => {
    const checkFn = vi.fn();
    const getCheckInProgress = () => true;
    const debounced = createDebouncedCheck(checkFn, 3000, getCheckInProgress);

    debounced();
    vi.advanceTimersByTime(3000);
    expect(checkFn).not.toHaveBeenCalled();
  });

  it("checkInProgress guard kiểm tra tại thời điểm gọi debounce, không phải tại thời điểm timeout chạy", () => {
    // Mô phỏng: lúc gọi debounce thì checkInProgress=false,
    // nhưng lúc timeout chạy thì checkInProgress đã thành true.
    // Hàm vẫn gọi checkFn vì guard chỉ check lúc debounce() được gọi.
    const checkFn = vi.fn();
    let inProgress = false;
    const getCheckInProgress = () => inProgress;
    const debounced = createDebouncedCheck(checkFn, 100, getCheckInProgress);

    debounced(); // inProgress = false → được phép
    inProgress = true; // sau đó checkInProgress thành true

    vi.advanceTimersByTime(100);
    expect(checkFn).toHaveBeenCalledTimes(1);
  });

  it("debounce với window khác (1000ms)", () => {
    const checkFn = vi.fn();
    const getCheckInProgress = () => false;
    const debounced = createDebouncedCheck(checkFn, 1000, getCheckInProgress);

    debounced();
    vi.advanceTimersByTime(999);
    expect(checkFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(checkFn).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Duplicate: sequential failover logic từ monitor.mjs
// ============================================================

/**
 * Mô phỏng logic sequential failover trong startWsWatcher.
 * Thử từng URL theo thứ tự, dừng lại khi kết nối thành công.
 */
async function sequentialConnect(urls, connectFn) {
  for (const url of urls) {
    try {
      const result = await connectFn(url);
      return { success: true, url, result };
    } catch {
      // Thử URL tiếp theo
    }
  }
  return { success: false, url: null, result: null };
}

describe("WSS sequential failover", () => {
  it("thử URL đầu tiên → thành công → dừng ngay", async () => {
    const triedUrls = [];
    const connectFn = async (url) => {
      triedUrls.push(url);
      return { client: "mock", unwatch: () => {} };
    };

    const urls = ["wss://good.example.com", "wss://never-tried.example.com"];
    const result = await sequentialConnect(urls, connectFn);

    expect(result.success).toBe(true);
    expect(result.url).toBe("wss://good.example.com");
    expect(triedUrls).toEqual(["wss://good.example.com"]);
  });

  it("thử URL 1 thất bại → URL 2 thành công → dừng", async () => {
    const triedUrls = [];
    const connectFn = async (url) => {
      triedUrls.push(url);
      if (url === "wss://bad.example.com") throw new Error("Connection refused");
      return { client: "mock", unwatch: () => {} };
    };

    const urls = [
      "wss://bad.example.com",
      "wss://good.example.com",
      "wss://never-tried.example.com",
    ];
    const result = await sequentialConnect(urls, connectFn);

    expect(result.success).toBe(true);
    expect(result.url).toBe("wss://good.example.com");
    expect(triedUrls).toEqual(["wss://bad.example.com", "wss://good.example.com"]);
  });

  it("tất cả URLs thất bại → trả về success=false", async () => {
    const triedUrls = [];
    const connectFn = async (url) => {
      triedUrls.push(url);
      throw new Error("Connection failed");
    };

    const urls = ["wss://bad1.example.com", "wss://bad2.example.com"];
    const result = await sequentialConnect(urls, connectFn);

    expect(result.success).toBe(false);
    expect(result.url).toBeNull();
    expect(triedUrls).toEqual(urls);
  });

  it("danh sách URLs rỗng → không thử gì cả, trả về false ngay", async () => {
    const connectFn = vi.fn();
    const result = await sequentialConnect([], connectFn);

    expect(result.success).toBe(false);
    expect(connectFn).not.toHaveBeenCalled();
  });

  it("1 URL duy nhất thất bại → trả về false", async () => {
    const connectFn = async () => { throw new Error("Connection timeout"); };
    const result = await sequentialConnect(["wss://only.example.com"], connectFn);

    expect(result.success).toBe(false);
  });

  it("lỗi khác nhau ở mỗi URL không ảnh hưởng đến URL tiếp theo", async () => {
    const errors = [];
    const connectFn = async (url) => {
      if (url.includes("dns")) throw new Error("ENOTFOUND");
      if (url.includes("refused")) throw new Error("ECONNREFUSED");
      if (url.includes("timeout")) throw new Error("ETIMEDOUT");
      return { client: "mock", unwatch: () => {} };
    };

    const urls = [
      "wss://dns-fail.example.com",
      "wss://refused.example.com",
      "wss://timeout.example.com",
      "wss://good.example.com",
    ];
    const result = await sequentialConnect(urls, connectFn);

    expect(result.success).toBe(true);
    expect(result.url).toBe("wss://good.example.com");
  });
});

// ============================================================
// Duplicate: stopWsWatcher cleanup logic
// ============================================================

describe("stopWsWatcher cleanup", () => {
  it("gọi unwatch và clearTimeout khi cleanup", () => {
    let unwatchCalled = false;
    let timerCleared = false;

    const mockUnwatch = () => { unwatchCalled = true; };
    const mockClearTimeout = () => { timerCleared = true; };

    // Mô phỏng logic stopWsWatcher
    const state = { unwatch: mockUnwatch };
    let timer = 123; // mock timer ID

    if (state?.unwatch) {
      try { state.unwatch(); } catch { /* ignore */ }
      state.unwatch = null; // mark as cleaned
    }
    mockClearTimeout();
    timer = null;

    expect(unwatchCalled).toBe(true);
    expect(state.unwatch).toBeNull();
    expect(timerCleared).toBe(true);
    expect(timer).toBeNull();
  });

  it("không throw nếu unwatch bị lỗi", () => {
    const state = {
      unwatch: () => { throw new Error("Already closed"); },
    };

    let threw = false;
    try {
      if (state?.unwatch) {
        try { state.unwatch(); } catch { /* ignore */ }
        state.unwatch = null;
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(state.unwatch).toBeNull();
  });

  it("không làm gì nếu state là null (chưa từng kết nối)", () => {
    const state = null;
    let threw = false;

    try {
      if (state?.unwatch) {
        state.unwatch();
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });
});
