/**
 * Tests cho wss-connect.mjs (production) — audit H1.
 *
 * `client.transport?.close?.()` từng là no-op: viem 2.53 KHÔNG đặt `.close`
 * trên transport; socket + keepAlive/reconnect timer nằm trong socket client
 * mà `getRpcClient()` resolve ra (Promise<SocketRpcClient>) và `getSocket()`
 * resolve ra WebSocket thô.
 */
import { describe, it, expect, vi } from "vitest";
import { closeTransport, createWssConnect } from "../wss-connect.mjs";

/** Fake viem transport: value.getRpcClient() → Promise<{ close }>. */
function viemShapedClient({ close = vi.fn(), getChainId } = {}) {
  const rpcClient = { close };
  const transport = { value: { getRpcClient: () => Promise.resolve(rpcClient) } };
  return { client: { transport, getChainId: getChainId ?? (async () => 1), watchContractEvent: vi.fn(() => vi.fn()) }, close, rpcClient };
}

describe("closeTransport (viem shape)", () => {
  it("đóng qua getRpcClient() khi nó trả Promise (viem 2.53)", async () => {
    const { client, close } = viemShapedClient();
    expect(closeTransport(client)).toBe(true);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("đóng qua getRpcClient() khi nó trả object sync (viem cũ)", () => {
    const close = vi.fn();
    const client = { transport: { value: { getRpcClient: () => ({ close }) } } };
    expect(closeTransport(client)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fallback getSocket() khi rpc client không có close", async () => {
    const socketClose = vi.fn();
    const client = {
      transport: {
        value: {
          getRpcClient: () => Promise.resolve({}),
          getSocket: () => Promise.resolve({ close: socketClose }),
        },
      },
    };
    expect(closeTransport(client)).toBe(true);
    await vi.waitFor(() => expect(socketClose).toHaveBeenCalledTimes(1));
  });

  it("không throw khi transport thiếu value hoặc getRpcClient ném", () => {
    expect(closeTransport(undefined)).toBe(false);
    expect(closeTransport({})).toBe(false);
    expect(closeTransport({ transport: { value: {} } })).toBe(false);
    expect(closeTransport({ transport: { value: { getRpcClient: () => { throw new Error("boom"); } } } })).toBe(false);
  });

  it("close trên transport phẳng (shape cũ từng được gọi) là no-op — lý do H1", () => {
    // Chứng minh bug đã sửa: transport thật không có .close, nên code cũ không đóng gì.
    const { client, close } = viemShapedClient();
    expect(client.transport.close).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    closeTransport(client);
    return vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});

describe("createWssConnect", () => {
  it("probe fail → đóng transport trước khi rethrow (không rò socket)", async () => {
    const { client, close } = viemShapedClient({ getChainId: async () => { throw new Error("no route to host"); } });
    const connect = createWssConnect({
      address: "0x" + "b".repeat(40),
      createClient: () => client,
      webSocketTransport: () => ({ value: client.transport.value }),
    });
    await expect(connect("wss://bad")).rejects.toThrow("no route to host");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("probe thành công → trả connection với close thật + watch ủy quyền cho client", async () => {
    const { client } = viemShapedClient();
    const watchContractEvent = vi.fn(() => vi.fn());
    const connect = createWssConnect({
      address: "0x" + "b".repeat(40),
      createClient: () => ({ ...client, watchContractEvent }),
      webSocketTransport: () => ({ value: client.transport.value }),
    });
    const connection = await connect("wss://good");
    expect(connection.url).toBe("wss://good");
    const unwatch = connection.watch("Supply", { id: ["0x" + "a".repeat(64)] }, () => {}, () => {});
    expect(watchContractEvent).toHaveBeenCalledTimes(1);
    expect(typeof unwatch).toBe("function");
    expect(connection.close()).toBe(true);
  });
});
