import { describe, expect, it, vi } from "vitest";
import { dispatchNotifications } from "../notification-dispatch.mjs";

describe("dispatchNotifications", () => {
  it("attempts VoIP when ntfy fails", async () => {
    const voip = vi.fn().mockResolvedValue({ sent: true, status: "completed" });
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
  it.each([
    [{ sent: false, status: "busy" }, "busy"],
    [{ sent: false, status: "failed" }, "failed"],
    [{ sent: false, status: "no_answer" }, "no_answer"],
    [{ sent: true, status: "unknown" }, "unknown"],
    [undefined, "unknown"],
  ])("does not report a completed call for %j", async (response, status) => {
    const result = await dispatchNotifications({ sendNtfy: vi.fn(), sendVoip: async () => response, voipEnabled: true });
    expect(result.voipDelivered).toBe(false);
    expect(result.voipStatus).toBe(status);
    expect(result.ntfyDelivered).toBe(true);
  });
  it("returns disabled when VoIP is off", async () => {
    const result = await dispatchNotifications({ sendNtfy: vi.fn(), voipEnabled: false });
    expect(result.voipStatus).toBe("disabled");
    expect(result.voipDelivered).toBe(false);
  });
});
