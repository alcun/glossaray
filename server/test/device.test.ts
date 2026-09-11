import { describe, expect, test } from "bun:test";
import { deviceIsAuthorized } from "../src/device";

describe("device socket authentication", () => {
  test("accepts only the configured bearer credential", () => {
    expect(deviceIsAuthorized("Bearer device-secret", "device-secret")).toBe(true);
    expect(deviceIsAuthorized("Bearer wrong", "device-secret")).toBe(false);
    expect(deviceIsAuthorized(null, "device-secret")).toBe(false);
  });

  test("an empty server credential never admits a device", () => {
    expect(deviceIsAuthorized("Bearer ", "")).toBe(false);
  });
});
