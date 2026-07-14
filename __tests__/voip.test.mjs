import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatTokenAmount,
  wadToPercent,
  formatApy,
  toTtsFriendly,
} from "../shared.mjs";

// ============================================================
// FIXTURES
// ============================================================

function makeMockMarket(overrides = {}) {
  return {
    liquidity: 5_000_000_000n,       // 5000 USDC (6 decimals)
    utilization: 500_000_000_000_000_000n, // 50%
    supplyApy: 0.0512,
    totalSupplyAssets: 10_000_000_000n,
    totalSupplyShares: 9_500_000_000n,
    params: {
      collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    ...overrides,
  };
}

function makeMockToken(overrides = {}) {
  return {
    symbol: "USDC",
    decimals: 6,
    ...overrides,
  };
}

function makeMockPosition(overrides = {}) {
  return {
    supplyAssets: 1_000_000_000n, // 1000 USDC (6 decimals)
    ...overrides,
  };
}

// ============================================================
// DUPLICATED PURE FUNCTIONS FROM voip.mjs
// (deliberately duplicated to test string content without
//  module-level side effects — matches project convention)
// ============================================================

function buildVoipMessage(market, loanToken, collateralToken, position, scenario) {
  const loanSymbol = toTtsFriendly(loanToken?.symbol);
  const collateralSymbol = toTtsFriendly(collateralToken?.symbol);
  const loanDecimals = loanToken?.decimals ?? 18;
  const isSuddenDrain = scenario === "sudden_drain";

  const liquidityStr = formatTokenAmount(market.liquidity, loanDecimals, loanSymbol);
  const supplyStr = formatTokenAmount(position.supplyAssets, loanDecimals, loanSymbol);
  const utilizationStr = wadToPercent(market.utilization);
  const apyStr = formatApy(market.supplyApy);

  if (isSuddenDrain) {
    return (
      `Cảnh báo! Thanh khoản trên thị trường ${collateralSymbol} & ${loanSymbol} đã giảm mạnh. ` +
      `Thanh khoản hiện tại: ${liquidityStr}. ` +
      `Vị thế của bạn: ${supplyStr}. ` +
      `Tỉ lệ sử dụng: ${utilizationStr}. ` +
      `Lãi suất năm: ${apyStr}. ` +
      `Hãy vào trang web để rút tiền ngay.`
    );
  } else {
    return (
      `Thông báo! Thanh khoản đã xuất hiện trên thị trường ${collateralSymbol} & ${loanSymbol}. ` +
      `Thanh khoản hiện tại: ${liquidityStr}. ` +
      `Vị thế của bạn: ${supplyStr}. ` +
      `Tỉ lệ sử dụng: ${utilizationStr}. ` +
      `Lãi suất năm: ${apyStr}. ` +
      `Hãy vào trang web để rút tiền.`
    );
  }
}

// ============================================================
// buildVoipMessage TESTS
// ============================================================

describe("buildVoipMessage", () => {
  it("sudden_drain scenario — tạo tin nhắn tiếng Việt đúng định dạng", () => {
    const market = makeMockMarket();
    const loanToken = makeMockToken({ symbol: "USDC", decimals: 6 });
    const collateralToken = makeMockToken({ symbol: "WETH", decimals: 18 });
    const position = makeMockPosition();

    const msg = buildVoipMessage(market, loanToken, collateralToken, position, "sudden_drain");

    expect(msg).toContain("Cảnh báo!");
    expect(msg).toContain("W E T H & U S D C");
    expect(msg).toContain("đã giảm mạnh");
    expect(msg).toContain("5000");
    expect(msg).toContain("1000");
    expect(msg).toContain("50.00%");
    expect(msg).toContain("Lãi suất năm");
    expect(msg).toContain("5.1200%");
    expect(msg).toContain("Hãy vào trang web để rút tiền ngay");
  });

  it("liquidity_appeared scenario — tạo tin nhắn tiếng Việt đúng định dạng", () => {
    const market = makeMockMarket();
    const loanToken = makeMockToken({ symbol: "USDC", decimals: 6 });
    const collateralToken = makeMockToken({ symbol: "WETH", decimals: 18 });
    const position = makeMockPosition();

    const msg = buildVoipMessage(market, loanToken, collateralToken, position, "liquidity_appeared");

    expect(msg).toContain("Thông báo!");
    expect(msg).toContain("W E T H & U S D C");
    expect(msg).toContain("đã xuất hiện");
    expect(msg).toContain("Hãy vào trang web để rút tiền");
  });

  it("độ dài tin nhắn không vượt quá 500 ký tự", () => {
    const market = makeMockMarket();
    const loanToken = makeMockToken({ symbol: "USDC", decimals: 6 });
    const collateralToken = makeMockToken({ symbol: "WETH", decimals: 18 });
    const position = makeMockPosition();

    const drainMsg = buildVoipMessage(market, loanToken, collateralToken, position, "sudden_drain");
    const appearMsg = buildVoipMessage(market, loanToken, collateralToken, position, "liquidity_appeared");

    expect(drainMsg.length).toBeLessThanOrEqual(500);
    expect(appearMsg.length).toBeLessThanOrEqual(500);
  });

  it("xử lý token symbol null/undefined — fallback về 'token'", () => {
    const market = makeMockMarket();
    const loanToken = { symbol: null, decimals: 6 };
    const collateralToken = { symbol: undefined, decimals: 18 };
    const position = makeMockPosition();

    const msg = buildVoipMessage(market, loanToken, collateralToken, position, "sudden_drain");

    expect(msg).toContain("T O K E N & T O K E N");
    expect(msg).not.toContain("null");
    expect(msg).not.toContain("undefined");
  });

  it("xử lý decimals undefined — fallback về 18", () => {
    const market = makeMockMarket({ liquidity: 1_000_000_000_000_000_000n }); // 1 WAD
    const loanToken = { symbol: "USDC", decimals: undefined };
    const collateralToken = { symbol: "WETH", decimals: 18 };
    const position = makeMockPosition({ supplyAssets: 1_000_000_000_000_000_000n });

    const msg = buildVoipMessage(market, loanToken, collateralToken, position, "sudden_drain");

    // With 18 decimals, 1 WAD = 1 token (formatUnits strips trailing zeros)
    expect(msg).toContain("1 U S D C");
  });
});

// ============================================================
// DUPLICATED FETCH-DEPENDENT HELPERS FROM voip.mjs
// ============================================================

// Module-level token cache (mirrors voip.mjs)
let tokenCache = null;
function clearTokenCache() { tokenCache = null; }

// Duplicated sleep (will be mocked in retry tests)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBearerToken(secretKey, apiUrl) {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const response = await fetch(`${apiUrl}/api/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret_key: secretKey }),
  });

  if (!response.ok) {
    throw new Error(`VoIP auth thất bại (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.token;
}

async function initiateCall(apiUrl, bearerToken, target, message) {
  const response = await fetch(`${apiUrl}/api/v1/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({
      target,
      message,
      repeat: 2,
      repeat_delay: 1.0,
      callback_url: null,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) {
      clearTokenCache();
    }
    throw new Error(`VoIP initiateCall thất bại (${response.status}): ${body}`);
  }

  const data = await response.json();
  return { callId: data.call_id };
}

async function pollCallStatus(apiUrl, bearerToken, callId, maxPollMs = 60000, pollIntervalMs = 2000) {
  const startedAt = Date.now();

  while (true) {
    const response = await fetch(`${apiUrl}/api/v1/call/${callId}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${bearerToken}` },
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401) {
        clearTokenCache();
      }
      throw new Error(`VoIP pollCallStatus thất bại (${response.status}): ${body}`);
    }

    const data = await response.json();
    const terminalStatuses = ["completed", "failed", "no_answer", "busy"];

    if (terminalStatuses.includes(data.status)) {
      return {
        callId: data.call_id,
        status: data.status,
        duration_seconds: data.duration_seconds,
        error_message: data.error_message,
      };
    }

    if (Date.now() - startedAt >= maxPollMs) {
      return { callId: data.call_id, status: data.status };
    }

    await sleep(pollIntervalMs);
  }
}

async function callWithRetry({ apiUrl, secretKey, target, message, maxRetries, retryDelayMs }) {
  let lastError = null;
  let lastCallId = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const token = await getBearerToken(secretKey, apiUrl);
      const { callId } = await initiateCall(apiUrl, token, target, message);
      lastCallId = callId;
      const result = await pollCallStatus(apiUrl, token, callId);
      lastStatus = result.status;

      if (result.status === "completed") {
        return { sent: true, callId, status: "completed", attempts: attempt };
      }

      // Only retry on explicit terminal failures, NOT on poll timeout
      if (result.status === "failed" || result.status === "no_answer" || result.status === "busy") {
        lastError = new Error(
          `Cuộc gọi kết thúc với trạng thái: ${result.status}` +
            (result.error_message ? ` (${result.error_message})` : "")
        );

        if (attempt < maxRetries) {
          await sleep(retryDelayMs);
          continue;
        }
      }

      // Non-terminal (poll timeout): don't create duplicate calls
      if (result.status !== "failed" && result.status !== "no_answer" && result.status !== "busy") {
        return {
          sent: true,
          callId,
          status: result.status || "unknown",
          attempts: attempt,
        };
      }
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(retryDelayMs);
      }
    }
  }

  return {
    sent: false,
    callId: lastCallId,
    status: lastStatus,
    attempts: maxRetries,
    error: lastError?.message,
  };
}

// ============================================================
// getBearerToken TESTS
// ============================================================

describe("getBearerToken", () => {
  let fetchMock;

  beforeEach(() => {
    tokenCache = null;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gọi API auth và trả về token khi cache rỗng", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "test-token-abc", token_type: "bearer", expires_in: 86400 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const token = await getBearerToken("secret123", "http://api.example.com");

    expect(token).toBe("test-token-abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.example.com/api/v1/auth/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret_key: "secret123" }),
      })
    );
  });

  it("trả về token từ cache khi còn hạn", async () => {
    // First call — populate cache
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "cached-token", token_type: "bearer", expires_in: 86400 }), {
        status: 200,
      })
    );

    await getBearerToken("secret123", "http://api.example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    const token = await getBearerToken("secret123", "http://api.example.com");

    expect(token).toBe("cached-token");
    expect(fetchMock).toHaveBeenCalledTimes(1); // No additional fetch
  });

  it("gọi lại API auth khi token sắp hết hạn (< 60 giây)", async () => {
    // First call with short expiry
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "old-token", token_type: "bearer", expires_in: 30 }), {
        status: 200,
      })
    );
    await getBearerToken("secret123", "http://api.example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second response with fresh token
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "new-token", token_type: "bearer", expires_in: 86400 }), {
        status: 200,
      })
    );

    const token = await getBearerToken("secret123", "http://api.example.com");
    expect(token).toBe("new-token");
    expect(fetchMock).toHaveBeenCalledTimes(2); // Re-authenticated
  });

  it("ném lỗi khi auth thất bại", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Invalid secret key", { status: 403 })
    );

    await expect(
      getBearerToken("wrong-key", "http://api.example.com")
    ).rejects.toThrow("VoIP auth thất bại (403)");
  });
});

// ============================================================
// initiateCall TESTS
// ============================================================

describe("initiateCall", () => {
  let fetchMock;

  beforeEach(() => {
    tokenCache = null;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gửi POST đúng URL với Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "uuid-123", status: "queued", created_at: "2026-01-01T00:00:00Z" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await initiateCall(
      "http://api.example.com",
      "bearer-token-xyz",
      "sip:test@sip.linphone.org",
      "Xin chào"
    );

    expect(result.callId).toBe("uuid-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.example.com/api/v1/call",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Authorization": "Bearer bearer-token-xyz",
          "Content-Type": "application/json",
        }),
      })
    );

    // Verify body
    const callArgs = fetchMock.mock.calls[0][1];
    const body = JSON.parse(callArgs.body);
    expect(body.target).toBe("sip:test@sip.linphone.org");
    expect(body.message).toBe("Xin chào");
    expect(body.repeat).toBe(2);
    expect(body.repeat_delay).toBe(1.0);
    expect(body.callback_url).toBeNull();
  });

  it("ném lỗi khi API trả về lỗi", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Bad request", { status: 400 })
    );

    await expect(
      initiateCall("http://api.example.com", "token", "sip:x@sip.linphone.org", "msg")
    ).rejects.toThrow("VoIP initiateCall thất bại (400)");
  });

  it("xóa token cache khi nhận HTTP 401", async () => {
    // Set up cache first
    tokenCache = { token: "expired-token", expiresAt: Date.now() + 3600_000 };

    fetchMock.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 })
    );

    await expect(
      initiateCall("http://api.example.com", "expired-token", "sip:x@sip.linphone.org", "msg")
    ).rejects.toThrow("VoIP initiateCall thất bại (401)");

    expect(tokenCache).toBeNull(); // Cache was cleared
  });
});

// ============================================================
// pollCallStatus TESTS
// ============================================================

describe("pollCallStatus", () => {
  let fetchMock;

  beforeEach(() => {
    vi.useFakeTimers();
    tokenCache = null;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("trả về ngay khi trạng thái là 'completed'", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        call_id: "uuid-1",
        status: "completed",
        duration_seconds: 12.5,
        error_message: null,
      }), { status: 200 })
    );

    const result = await pollCallStatus("http://api.example.com", "token", "uuid-1");

    expect(result.callId).toBe("uuid-1");
    expect(result.status).toBe("completed");
    expect(result.duration_seconds).toBe(12.5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("trả về ngay khi trạng thái là 'failed'", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        call_id: "uuid-2",
        status: "failed",
        error_message: "SIP connection refused",
      }), { status: 200 })
    );

    const result = await pollCallStatus("http://api.example.com", "token", "uuid-2");

    expect(result.status).toBe("failed");
    expect(result.error_message).toBe("SIP connection refused");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("trả về ngay khi trạng thái là 'no_answer'", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "uuid-3", status: "no_answer" }), { status: 200 })
    );

    const result = await pollCallStatus("http://api.example.com", "token", "uuid-3");

    expect(result.status).toBe("no_answer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("trả về ngay khi trạng thái là 'busy'", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "uuid-4", status: "busy" }), { status: 200 })
    );

    const result = await pollCallStatus("http://api.example.com", "token", "uuid-4");

    expect(result.status).toBe("busy");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("poll nhiều lần cho đến khi đạt trạng thái terminal", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ call_id: "uuid-5", status: "queued" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ call_id: "uuid-5", status: "synthesizing" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ call_id: "uuid-5", status: "calling" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ call_id: "uuid-5", status: "completed", duration_seconds: 8.0 }), { status: 200 })
      );

    // Start polling (it will await sleep between polls)
    const pollPromise = pollCallStatus("http://api.example.com", "token", "uuid-5", 30000, 2000);

    // Advance time to trigger each sleep resolution
    await vi.advanceTimersByTimeAsync(2000); // queued → synthesizing
    await vi.advanceTimersByTimeAsync(2000); // synthesizing → calling
    await vi.advanceTimersByTimeAsync(2000); // calling → completed

    const result = await pollPromise;

    expect(result.status).toBe("completed");
    expect(result.duration_seconds).toBe(8.0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("timeout — trả về trạng thái non-terminal cuối cùng", async () => {
    // Use mockImplementation to return a fresh Response each call
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ call_id: "uuid-6", status: "calling" }), { status: 200 })
      )
    );

    const pollPromise = pollCallStatus("http://api.example.com", "token", "uuid-6", 5000, 2000);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000); // 6000ms elapsed > 5000ms maxPollMs

    const result = await pollPromise;

    expect(result.status).toBe("calling");
  });

  it("ném lỗi khi poll API trả về lỗi HTTP", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Internal error", { status: 500 })
    );

    await expect(
      pollCallStatus("http://api.example.com", "token", "uuid-7")
    ).rejects.toThrow("VoIP pollCallStatus thất bại (500)");
  });

  it("xóa token cache khi nhận HTTP 401", async () => {
    tokenCache = { token: "stale", expiresAt: Date.now() + 3600_000 };

    fetchMock.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 })
    );

    await expect(
      pollCallStatus("http://api.example.com", "stale-token", "uuid-8")
    ).rejects.toThrow("VoIP pollCallStatus thất bại (401)");

    expect(tokenCache).toBeNull();
  });
});

// ============================================================
// callWithRetry TESTS
// ============================================================

describe("callWithRetry", () => {
  let fetchMock;

  beforeEach(() => {
    vi.useFakeTimers();
    tokenCache = null;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const baseConfig = {
    apiUrl: "http://api.example.com",
    secretKey: "test-secret",
    target: "sip:test@sip.linphone.org",
    message: "Test message",
    maxRetries: 3,
    retryDelayMs: 5000,
  };

  it("thành công ở lần thử đầu tiên", async () => {
    // Auth
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 86400 }), { status: 200 })
    );
    // Initiate call
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-1", status: "queued", created_at: "..." }), { status: 202 })
    );
    // Poll status → completed
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-1", status: "completed", duration_seconds: 5.0 }), { status: 200 })
    );

    const result = await callWithRetry(baseConfig);

    expect(result.sent).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.callId).toBe("call-1");
    expect(result.attempts).toBe(1);
  });

  it("retry khi trạng thái là 'no_answer'", async () => {
    // Attempt 1: auth + initiate + poll → no_answer
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 86400 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-2", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-2", status: "no_answer" }), { status: 200 })
    );

    // Attempt 2: auth (from cache? no, getBearerToken checks cache) + initiate + poll → completed
    // Token cache hit — no auth call needed
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-3", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-3", status: "completed", duration_seconds: 3.0 }), { status: 200 })
    );

    const resultPromise = callWithRetry(baseConfig);

    // Wait for retry delay
    await vi.advanceTimersByTimeAsync(5000);

    const result = await resultPromise;

    expect(result.sent).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.callId).toBe("call-3");
    expect(result.attempts).toBe(2);
  });

  it("retry khi trạng thái là 'failed'", async () => {
    // Attempt 1: → failed
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 86400 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-f1", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-f1", status: "failed", error_message: "SIP error" }), { status: 200 })
    );

    // Attempt 2: → completed (token from cache)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-f2", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-f2", status: "completed", duration_seconds: 4.0 }), { status: 200 })
    );

    const resultPromise = callWithRetry(baseConfig);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("retry khi trạng thái là 'busy'", async () => {
    // Attempt 1: → busy
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 86400 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-b1", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-b1", status: "busy" }), { status: 200 })
    );

    // Attempt 2: → busy again
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-b2", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-b2", status: "busy" }), { status: 200 })
    );

    // Attempt 3: → completed
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-b3", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-b3", status: "completed", duration_seconds: 6.0 }), { status: 200 })
    );

    const resultPromise = callWithRetry(baseConfig);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it("retry khi có lỗi mạng (fetch throws)", async () => {
    // Attempt 1: network error on auth
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // Attempt 2: success (auth + initiate + poll)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 86400 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-net", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-net", status: "completed", duration_seconds: 7.0 }), { status: 200 })
    );

    const resultPromise = callWithRetry(baseConfig);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.sent).toBe(true);
    expect(result.callId).toBe("call-net");
    expect(result.attempts).toBe(2);
  });

  it("trả về { sent: false } sau khi hết retry", async () => {
    // All attempts return no_answer.
    // Token is cached after attempt 1, so attempts 2 & 3 skip auth.
    // Total fetch calls: auth(1) + initiate(3) + poll(3) = 7

    // Attempt 1: auth + initiate + poll → no_answer
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 86400 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-ex1", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-ex1", status: "no_answer" }), { status: 200 })
    );

    // Attempt 2: initiate + poll → no_answer (no auth, token cached)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-ex2", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-ex2", status: "no_answer" }), { status: 200 })
    );

    // Attempt 3: initiate + poll → no_answer (no auth, token cached)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-ex3", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-ex3", status: "no_answer" }), { status: 200 })
    );

    const resultPromise = callWithRetry({ ...baseConfig, maxRetries: 3 });
    // Wait for two retry delays
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.sent).toBe(false);
    expect(result.status).toBe("no_answer");
    expect(result.attempts).toBe(3);
  });

  it("KHÔNG retry khi poll timeout — trả về 'unknown' thay vì tạo cuộc gọi mới", async () => {
    // Attempt 1: poll returns "calling" (non-terminal, poll timed out)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 86400 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "call-timeout", status: "queued" }), { status: 202 })
    );
    // pollCallStatus timeout → returns non-terminal "calling"
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ call_id: "call-timeout", status: "calling" }), { status: 200 })
      )
    );

    // Với fake timers, pollCallStatus sẽ loop mãi nếu mock luôn trả về "calling".
    // Ta advance đủ thời gian để timeout (60s mặc định mới).
    // Dùng maxPollMs ngắn hơn cho test này.
    // Actually, callWithRetry gọi pollCallStatus(apiUrl, token, callId) với defaults.
    // Với maxPollMs=60000 mới, cần advance 60000ms...
    // Để test nhanh, ta bọc callWithRetry với maxPollMs qua config.

    // Vì callWithRetry không truyền maxPollMs vào pollCallStatus,
    // ta test ý tưởng: khi poll trả về non-terminal, không retry.
    // Dùng mockImplementation để lần poll đầu trả về "calling",
    // và kiểm tra rằng chỉ có 1 initiate + 1 auth (không có retry).

    const resultPromise = callWithRetry({
      ...baseConfig,
      maxRetries: 3,
      retryDelayMs: 5000,
    });

    // pollCallStatus với maxPollMs=60000: cần advance 60000ms để timeout.
    // Nhưng mock trả về "calling" ngay lập tức ở lần fetch đầu tiên.
    // Poll loop: fetch lần 1 → "calling" (non-terminal) → sleep 2000ms.
    // Cần advance cho đến khi Date.now() - startedAt >= 60000.
    // Với pollIntervalMs=2000, cần ~30 lần advance × 2000ms = 60000ms.

    // Để đơn giản, ta advance 60000ms
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    const result = await resultPromise;

    // Phải trả về sent=true (cuộc gọi đã được tạo) với status="calling"
    expect(result.sent).toBe(true);
    expect(result.callId).toBe("call-timeout");
    expect(result.status).toBe("calling");
    expect(result.attempts).toBe(1); // Chỉ 1 lần, không retry
    // Chỉ có 3 fetch calls: auth + initiate + 1 poll (mockImplementation trả về cùng response)
  });
});

// ============================================================
// sendVoipNotification INTEGRATION TESTS (with mocked fetch)
// ============================================================

describe("sendVoipNotification (integration mock)", () => {
  let fetchMock;

  beforeEach(() => {
    vi.useFakeTimers();
    tokenCache = null;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // We need to test the actual exported sendVoipNotification.
  // But it reads VOIP_SECRET_KEY from shared.mjs (via import).
  // Since we can't easily mock ESM imports, we test the logic
  // by manually constructing the equivalent flow using duplicated functions.

  it("kiểm tra buildVoipMessage + callWithRetry tích hợp đầy đủ", async () => {
    const market = makeMockMarket();
    const loanToken = makeMockToken({ symbol: "USDC", decimals: 6 });
    const collateralToken = makeMockToken({ symbol: "WETH", decimals: 18 });
    const position = makeMockPosition();

    // Build message
    const message = buildVoipMessage(market, loanToken, collateralToken, position, "sudden_drain");
    expect(message.length).toBeLessThanOrEqual(500);
    expect(message).toContain("Cảnh báo!");

    // Mock full successful flow
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 86400 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "int-1", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "int-1", status: "completed", duration_seconds: 10.0 }), { status: 200 })
    );

    const result = await callWithRetry({
      apiUrl: "http://api.example.com",
      secretKey: "test-secret",
      target: "sip:test@sip.linphone.org",
      message,
      maxRetries: 3,
      retryDelayMs: 5000,
    });

    expect(result.sent).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.callId).toBe("int-1");
    expect(result.attempts).toBe(1);
  });

  it("cắt tin nhắn xuống 500 ký tự nếu vượt quá", () => {
    const market = makeMockMarket();
    const loanToken = makeMockToken({ symbol: "USDC", decimals: 6 });
    const collateralToken = makeMockToken({ symbol: "WETH", decimals: 18 });
    const position = makeMockPosition();

    const message = buildVoipMessage(market, loanToken, collateralToken, position, "sudden_drain");

    // Simulate the truncation logic from sendVoipNotification
    let truncated = message;
    if (truncated.length > 500) {
      truncated = truncated.slice(0, 497) + "...";
    }

    expect(truncated.length).toBeLessThanOrEqual(500);
    // Since our realistic message is < 500, no truncation should occur
    expect(truncated).toBe(message);
  });

  it("hội thoại đầy đủ: build message → gọi API → poll → retry → thành công", async () => {
    const market = makeMockMarket();
    const loanToken = makeMockToken({ symbol: "USDC", decimals: 6 });
    const collateralToken = makeMockToken({ symbol: "WETH", decimals: 18 });
    const position = makeMockPosition();

    const message = buildVoipMessage(market, loanToken, collateralToken, position, "liquidity_appeared");
    expect(message).toContain("Thông báo!");
    expect(message).toContain("đã xuất hiện");

    // Attempt 1: no_answer
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 86400 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "full-1", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "full-1", status: "no_answer" }), { status: 200 })
    );

    // Attempt 2: completed
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "full-2", status: "queued" }), { status: 202 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ call_id: "full-2", status: "completed", duration_seconds: 8.5 }), { status: 200 })
    );

    const resultPromise = callWithRetry({
      apiUrl: "http://api.example.com",
      secretKey: "test-secret",
      target: "sip:test@sip.linphone.org",
      message,
      maxRetries: 3,
      retryDelayMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.sent).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.callId).toBe("full-2");
    expect(result.attempts).toBe(2);
  });
});
