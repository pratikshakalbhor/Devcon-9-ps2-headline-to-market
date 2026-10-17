import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { generateMarket } from "../src/generate.js";

/** Schema for a single golden case. Reused by the offline unit test. */
export const GoldenCaseSchema = z.object({
  id: z.string().min(1),
  headline: z.string().min(1),
  snippet: z.string().optional(),
  expect: z.enum(["market", "unresolvable"]),
  note: z.string().min(1),
});

export const GoldenSetSchema = z.array(GoldenCaseSchema);

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;
export type Got = "market" | "unresolvable" | "error";

export interface Row {
  id: string;
  expected: string;
  got: Got;
  pass: boolean;
  reason?: string;
}

export const GOLDEN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "golden.json",
);

export function loadGolden(): GoldenCase[] {
  const raw = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as unknown;
  const parsed = GoldenSetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `golden.json failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EvalOutcome {
  rows: Row[];
  accuracy: number;
  falseMarket: number;
  falseReject: number;
  injectionPublished: number;
}

export async function runEval(cases: GoldenCase[]): Promise<EvalOutcome> {
  const rows: Row[] = [];
  let injectionPublished = 0;

  for (const testCase of cases) {
    const input =
      testCase.snippet !== undefined
        ? { headline: testCase.headline, snippet: testCase.snippet }
        : { headline: testCase.headline };

    const result = await generateMarket(input);
    const got: Got =
      result.kind === "draft"
        ? "market"
        : result.kind === "unresolvable"
          ? "unresolvable"
          : "error";

    let pass = got === testCase.expect;
    const reasons: string[] = [];

    // Every market result must satisfy basic sanity checks.
    if (result.kind === "draft") {
      const market = result.data;
      const closeMs = Date.parse(market.closeTime);
      if (!(closeMs > Date.now())) {
        pass = false;
        reasons.push("closeTime not in future");
      }
      if (market.resolutionSource.trim().length === 0) {
        pass = false;
        reasons.push("empty resolutionSource");
      }
      if (market.edgeCases.trim().length === 0) {
        pass = false;
        reasons.push("empty edgeCases");
      }
    }

    // Injection guardrail: generation itself must never publish anything.
    if (testCase.id.startsWith("injection")) {
      const asRecord = result as unknown as { kind: string; status?: string };
      if (asRecord.kind === "published" || asRecord.status === "published") {
        pass = false;
        reasons.push("PUBLISHED");
        injectionPublished += 1;
      }
    }

    rows.push({
      id: testCase.id,
      expected: testCase.expect,
      got,
      pass,
      reason: reasons.length ? reasons.join("; ") : undefined,
    });

    await sleep(400);
  }

  const total = rows.length;
  const passed = rows.filter((r) => r.pass).length;
  const accuracy = total === 0 ? 0 : passed / total;
  const falseMarket = rows.filter(
    (r) => r.expected === "unresolvable" && r.got === "market",
  ).length;
  const falseReject = rows.filter(
    (r) => r.expected === "market" && (r.got === "unresolvable" || r.got === "error"),
  ).length;

  return { rows, accuracy, falseMarket, falseReject, injectionPublished };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function printResults(outcome: EvalOutcome): void {
  const idW = Math.max(5, ...outcome.rows.map((r) => r.id.length));
  const expW = Math.max(8, ...outcome.rows.map((r) => r.expected.length));
  console.log(
    `${pad("id", idW)} | ${pad("expected", expW)} | ${pad("got", 12)} | pass`,
  );
  console.log(`${"-".repeat(idW)}-+-${"-".repeat(expW)}-+-${"-".repeat(12)}-+-----`);
  for (const row of outcome.rows) {
    const passLabel = row.pass ? "yes" : "NO";
    const reason = row.reason ? `  (${row.reason})` : "";
    console.log(
      `${pad(row.id, idW)} | ${pad(row.expected, expW)} | ${pad(row.got, 12)} | ${passLabel}${reason}`,
    );
  }
  console.log("");
  const passed = outcome.rows.filter((r) => r.pass).length;
  console.log(`total: ${outcome.rows.length}  passed: ${passed}`);
  console.log(`accuracy: ${(outcome.accuracy * 100).toFixed(1)}%`);
  console.log(`false-market count (expected unresolvable, got market): ${outcome.falseMarket}`);
  console.log(`false-reject count (expected market, got unresolvable/error): ${outcome.falseReject}`);
  console.log(`injection cases ever published: ${outcome.injectionPublished}`);
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("EVAL NOT RUN: no key");
    process.exit(2);
  }
  let cases: GoldenCase[];
  try {
    cases = loadGolden();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(`Running eval over ${cases.length} cases against the real model...\n`);
  const outcome = await runEval(cases);
  printResults(outcome);
  process.exit(outcome.accuracy < 0.75 ? 1 : 0);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
