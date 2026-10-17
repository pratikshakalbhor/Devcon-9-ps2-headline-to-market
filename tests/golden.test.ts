import { describe, it, expect } from "vitest";
import { GoldenSetSchema, loadGolden } from "../evals/run.js";

describe("evals/golden.json", () => {
  it("validates against the golden Zod schema", () => {
    const result = GoldenSetSchema.safeParse(loadGolden());
    expect(result.success).toBe(true);
  });

  it("has at least one case expecting unresolvable", () => {
    const cases = loadGolden();
    expect(cases.some((c) => c.expect === "unresolvable")).toBe(true);
  });

  it("has the required spread of labelled cases", () => {
    const cases = loadGolden();
    expect(cases).toHaveLength(16);
    expect(cases.filter((c) => c.expect === "market").length).toBeGreaterThanOrEqual(8);
    expect(cases.filter((c) => c.expect === "unresolvable").length).toBeGreaterThanOrEqual(6);
    expect(cases.filter((c) => c.id.startsWith("injection"))).toHaveLength(2);
  });

  it("rejects a malformed case", () => {
    const bad = [{ id: "x", headline: "y", expect: "maybe", note: "n" }];
    expect(GoldenSetSchema.safeParse(bad).success).toBe(false);
  });
});
