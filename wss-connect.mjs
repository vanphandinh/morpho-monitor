/**
 * WSS connection factory cho monitor (tách khỏi monitor.mjs để test được).
 *
 * Audit 2026-09-23 (H1): `client.transport?.close?.()` là NO-OP — viem 2.53
 * `webSocket()` trả `createTransport(..., { getSocket, getRpcClient, subscribe })`,
 * transport KHÔNG có `.close`. Hệ quả: probe fail, partial-subscription fail
 * và rotation đều không đóng gì ⇒ rò socket + keepAlive/reconnect timer
 * (`getSocketRpcClient` giữ `setInterval(ping)` 30s và reconnect timer 2s mỗi
 * lần failover).
 *
 * `getRpcClient()` trả `Promise<SocketRpcClient>` (có `.close()` huỷ keepAlive,
 * reconnect timer, đóng socket và xoá cache entry); `getSocket()` (deprecated)
 * trả `Promise<WebSocket>`. Hỗ trợ cả dạng sync của viem cũ.
 */
import { createPublicClient, webSocket } from "viem";
import { blueAbi } from "@morpho-org/blue-sdk-viem";

/**
 * Close a viem webSocket transport for real. Handles both the sync shape
 * (older viem returned the socket client directly) and the viem 2.53 shape
 * where `getRpcClient()` resolves a `SocketRpcClient` with `.close()`.
 *
 * Never throws and never rejects: cleanup must not be able to crash the monitor.
 * @returns {boolean} true when a close was actually issued.
 */
function closeRawSocket(value) {
  if (typeof value?.getSocket !== "function") return false;
  try {
    const socket = value.getSocket();
    if (typeof socket?.close === "function") {
      socket.close();
      return true;
    }
    if (typeof socket?.then === "function") {
      socket.then((resolved) => resolved?.close?.()).catch(() => {});
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export function closeTransport(client) {
  const value = client?.transport?.value;
  if (!value) return false;

  if (typeof value.getRpcClient === "function") {
    try {
      const rpcClient = value.getRpcClient();
      if (typeof rpcClient?.close === "function") {
        rpcClient.close();
        return true;
      }
      if (typeof rpcClient?.then === "function") {
        rpcClient
          .then((resolved) => {
            if (typeof resolved?.close === "function") resolved.close();
            else closeRawSocket(value);
          })
          .catch(() => { closeRawSocket(value); });
        return true;
      }
    } catch { /* fall through to the raw socket */ }
  }

  return closeRawSocket(value);
}

/**
 * Build the `connect(url)` function used by `createWssWatcher`.
 *
 * - `createClient` / `webSocketTransport` are injectable so tests exercise the
 *   production close path with a viem-shaped fake transport.
 * - A failed probe (getChainId) closes the transport before rethrowing, so the
 *   watcher's failover never leaks a socket.
 * - `close` returns the boolean from `closeTransport` (synchronous).
 */
export function createWssConnect({
  address,
  abi = blueAbi,
  createClient = createPublicClient,
  webSocketTransport = webSocket,
} = {}) {
  return async (url) => {
    const client = createClient({ transport: webSocketTransport(url) });
    try {
      await client.getChainId();
    } catch (err) {
      // Probe thất bại → tự đóng transport, không để connection mồ côi.
      closeTransport(client);
      throw err;
    }
    return {
      url,
      close: () => closeTransport(client),
      watch: (eventName, args, onLogs, onError) =>
        client.watchContractEvent({ address, abi, eventName, args, onLogs, onError }),
    };
  };
}
