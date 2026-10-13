/** Deliver notification channels independently; quota is controlled only by ntfy. */
export async function dispatchNotifications({ sendNtfy, sendVoip, voipEnabled = false, onNtfySettled, voipInFlight, voipKey }) {
  const ntfy = sendNtfy ? Promise.resolve().then(sendNtfy) : Promise.resolve();
  // Publish the quota-relevant outcome immediately. VoIP may keep polling for
  // much longer, and must not reserve ntfy capacity while it does so.
  const reportedNtfy = sendNtfy ? ntfy.then(
    (value) => { onNtfySettled?.({ ntfyDelivered: true, ntfyError: null }); return value; },
    (error) => { onNtfySettled?.({ ntfyDelivered: false, ntfyError: error }); throw error; },
  ) : ntfy;
  let voip = Promise.resolve();
  if (voipEnabled && sendVoip) {
    voip = voipInFlight && voipKey != null ? voipInFlight.get(voipKey) : null;
    if (!voip) {
      voip = Promise.resolve().then(sendVoip);
      if (voipInFlight && voipKey != null) {
        voipInFlight.set(voipKey, voip);
        // A retry of ntfy may overlap a still-ringing VoIP call. Share that
        // in-flight call rather than dial the same market twice.
        const clear = () => { if (voipInFlight.get(voipKey) === voip) voipInFlight.delete(voipKey); };
        void voip.then(clear, clear);
      }
    }
  }
  const [ntfyResult, voipResult] = await Promise.allSettled([reportedNtfy, voip]);
  const voipStatus = !voipEnabled || !sendVoip ? "disabled"
    : voipResult.status === "rejected" ? "failed"
      : (voipResult.value?.status ?? "unknown");
  return {
    ntfyDelivered: Boolean(sendNtfy) && ntfyResult.status === "fulfilled",
    voipDelivered: voipEnabled && voipResult.status === "fulfilled" && voipResult.value?.sent === true && voipStatus === "completed",
    voipStatus,
    ntfyError: ntfyResult.status === "rejected" ? ntfyResult.reason : null,
    voipError: voipResult.status === "rejected" ? voipResult.reason : null,
  };
}
