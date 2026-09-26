/** Deliver notification channels independently; quota is controlled only by ntfy. */
export async function dispatchNotifications({ sendNtfy, sendVoip, voipEnabled = false }) {
  const ntfy = Promise.resolve().then(sendNtfy);
  const voip = voipEnabled && sendVoip ? Promise.resolve().then(sendVoip) : Promise.resolve();
  const [ntfyResult, voipResult] = await Promise.allSettled([ntfy, voip]);
  return {
    ntfyDelivered: ntfyResult.status === "fulfilled",
    voipDelivered: voipEnabled && voipResult.status === "fulfilled",
    ntfyError: ntfyResult.status === "rejected" ? ntfyResult.reason : null,
    voipError: voipResult.status === "rejected" ? voipResult.reason : null,
  };
}
