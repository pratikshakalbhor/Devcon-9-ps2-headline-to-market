import { describe, it, expect } from "vitest";
import { validateDraft } from "../src/validate.js";
import type { Market } from "../src/schema.js";

function marketWithClose(closeTime: string): Market {
  return {
    status: "market",
    question: "Will the 2026 X Cup final be played on schedule?",
    closeTime,
    resolutionSource: "Official X Cup website",
    yesCriteria: "The match kicks off on the scheduled date.",
    noCriteria: "The match is cancelled or moved.",
    edgeCases: "If postponed beyond 30 days, it resolves No.",
  };
}

const now = new Date("2026-10-17T00:00:00.000Z");

describe("validateDraft", () => {
  it("rejects a closeTime in the past", () => {
    const result = validateDraft(marketWithClose("2020-01-01T00:00:00+00:00"), now);
    expect(result.ok).toBe(false);
  });

  it("rejects a closeTime equal to now", () => {
    const result = validateDraft(marketWithClose("2026-10-17T00:00:00+00:00"), now);
    expect(result.ok).toBe(false);
  });

  it("accepts a closeTime in the future", () => {
    const result = validateDraft(marketWithClose("2026-11-17T00:00:00+00:00"), now);
    expect(result).toEqual({ ok: true });
  });

  it("rejects a closeTime more than 2 years away", () => {
    const result = validateDraft(marketWithClose("2030-11-17T00:00:00+00:00"), now);
    expect(result.ok).toBe(false);
  });
});
