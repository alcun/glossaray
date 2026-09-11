import { expect, test, describe } from "bun:test";
import { createGate } from "../src/gate";
import { limits } from "../src/config";

describe("the session gate", () => {
  test("admits up to the ceiling and then says busy", () => {
    const gate = createGate();
    for (let i = 0; i < limits.maxSessions; i++) {
      expect(gate.admit(`10.0.0.${i}`)).toBeNull();
    }
    expect(gate.admit("10.0.0.99")).toBe("busy");
  });

  test("a released slot is reusable, so a quiet box does not stay full", () => {
    const gate = createGate();
    for (let i = 0; i < limits.maxSessions; i++) gate.admit(`10.0.0.${i}`);
    gate.release();
    expect(gate.admit("10.0.0.99")).toBeNull();
  });

  test("release cannot drive the count negative and invent capacity", () => {
    const gate = createGate();
    for (let i = 0; i < 5; i++) gate.release();
    expect(gate.stats().live).toBe(0);
    for (let i = 0; i < limits.maxSessions; i++) expect(gate.admit(`10.0.0.${i}`)).toBeNull();
    expect(gate.admit("10.0.0.99")).toBe("busy");
  });

  test("one address cannot open unlimited sessions over time", () => {
    let clock = 0;
    const gate = createGate(() => clock);
    let refused: string | null = null;
    for (let i = 0; i < limits.rateLimit + 5; i++) {
      const error = gate.admit("10.0.0.1");
      if (error === "rate_limited") { refused = error; break; }
      gate.release();
    }
    expect(refused).toBe("rate_limited");
  });

  test("the window expires, so a rate limit is not a permanent ban", () => {
    let clock = 0;
    const gate = createGate(() => clock);
    for (let i = 0; i < limits.rateLimit; i++) { gate.admit("10.0.0.1"); gate.release(); }
    expect(gate.admit("10.0.0.1")).toBe("rate_limited");
    clock += limits.rateWindowMs + 1;
    expect(gate.admit("10.0.0.1")).toBeNull();
  });

  test("the global provider-session budget is finite and resets", () => {
    let clock = 0;
    const gate = createGate(() => clock);
    for (let i = 0; i < limits.dailySessions; i++) {
      expect(gate.admit(`address-${i}`)).toBeNull();
      gate.release();
    }
    expect(gate.admit("one-more")).toBe("provider_budget");
    clock += 86_400_001;
    expect(gate.admit("tomorrow")).toBeNull();
  });

  test("a rejected start does not spend the provider-session budget", () => {
    const gate = createGate();
    expect(gate.admit("address")).toBeNull();
    gate.reject();
    expect(gate.stats().dailyStarts).toBe(0);
    expect(gate.stats().live).toBe(0);
  });
});
