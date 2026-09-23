import { describe, expect, it, vi } from "vitest";
import { dispatchNotifications } from "../notification-dispatch.mjs";

describe("dispatchNotifications", () => {
  it("attempts VoIP when ntfy fails", async () => {
    const voip = vi.fn().mockResolvedValue(undefined);
    const result = await dispatchNotifications({ sendNtfy: () => Promise.reject(new Error("ntfy")), sendVoip: voip, voipEnabled: true });
    expect(voip).toHaveBeenCalledOnce();
    expect(result.ntfyDelivered).toBe(false);
    expect(result.voipDelivered).toBe(true);
  });
  it("keeps ntfy success when VoIP fails", async () => {
    const result = await dispatchNotifications({ sendNtfy: vi.fn(), sendVoip: () => Promise.reject(new Error("voip")), voipEnabled: true });
    expect(result.ntfyDelivered).toBe(true);
    expect(result.voipDelivered).toBe(false);
  });
});
