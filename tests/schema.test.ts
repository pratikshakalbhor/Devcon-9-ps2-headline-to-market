import { describe, it, expect } from "vitest";
import { DraftResultSchema, MarketSchema, UnresolvableSchema } from "../src/schema.js";

const validMarket = {
  status: "market" as const,
  question: "Will the 2026 X Cup final be played on schedule?",
  closeTime: "2026-11-17T00:00:00+00:00",
  resolutionSource: "Official X Cup website",
  yesCriteria: "The match kicks off on the scheduled date.",
  noCriteria: "The match is cancelled or moved.",
  edgeCases: "If postponed beyond 30 days, it resolves No.",
};

const validUnresolvable = {
  status: "unresolvable" as const,
  reason: "The headline expresses a subjective opinion.",
  category: "subjective" as const,
};

describe("schema", () => {
  it("accepts a valid market", () => {
    const result = MarketSchema.safeParse(validMarket);
    expect(result.success).toBe(true);
  });

  it("accepts a valid unresolvable", () => {
    const result = UnresolvableSchema.safeParse(validUnresolvable);
    expect(result.success).toBe(true);
  });

  it("rejects a market missing required fields", () => {
    const { question, ...missingQuestion } = validMarket;
    void question;
    const result = DraftResultSchema.safeParse(missingQuestion);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = DraftResultSchema.safeParse({ status: "something_else" });
    expect(result.success).toBe(false);
  });

  it("rejects a market with an invalid unresolvable category", () => {
    const bad = { ...validUnresolvable, category: "vibes" };
    const result = UnresolvableSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
