import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../src/server.js";
import { openDb, type DraftStore } from "../src/db.js";
import type { GenerateResult } from "../src/generate.js";

const NOW = new Date("2026-10-17T00:00:00.000Z");
const FUTURE_CLOSE = "2026-11-17T00:00:00+00:00";
const PAST_CLOSE = "2020-01-01T00:00:00+00:00";

const marketPayload = {
  status: "market" as const,
  question: "Will the 2026 X Cup final be played on schedule?",
  closeTime: FUTURE_CLOSE,
  resolutionSource: "Official X Cup website",
  yesCriteria: "The match kicks off on the scheduled date.",
  noCriteria: "The match is cancelled or moved.",
  edgeCases: "If postponed beyond 30 days, it resolves No.",
};

const draftResult: GenerateResult = { kind: "draft", data: marketPayload };
const unresolvableResult: GenerateResult = {
  kind: "unresolvable",
  data: { status: "unresolvable", reason: "Subjective question, no outcome.", category: "subjective" },
};
const errorResult: GenerateResult = {
  kind: "error",
  code: "invalid_output",
  message: "model returned garbage",
  raw: "not json",
};

let store: DraftStore;

function appWith(result: GenerateResult) {
  return createApp({
    store,
    now: () => NOW,
    generate: async () => result,
  });
}

beforeEach(() => {
  store = openDb(":memory:");
});

async function createDraft(result: GenerateResult = draftResult) {
  const res = await request(appWith(result))
    .post("/api/drafts")
    .send({ headline: "X Cup final scheduled for 17 November 2026" });
  return res.body.draft as Record<string, unknown>;
}

describe("POST /api/drafts", () => {
  it("inserts status draft (never published)", async () => {
    const draft = await createDraft();
    expect(draft.kind).toBe("market");
    expect(draft.status).toBe("draft");
    const all = store.listDrafts();
    expect(all).toHaveLength(1);
    expect(all.every((d) => d.status === "draft")).toBe(true);
  });

  it("rejects invalid input with 400", async () => {
    const res = await request(appWith(draftResult)).post("/api/drafts").send({ headline: "hi" });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 200 with kind error and fallback options (not 500)", async () => {
    const res = await request(appWith(errorResult))
      .post("/api/drafts")
      .send({ headline: "Some headline that fails validation in the model" });
    expect(res.status).toBe(200);
    expect(res.body.draft.kind).toBe("error");
    expect(typeof res.body.draft.message).toBe("string");
    expect(res.body.draft.fallback).toEqual({ draftManually: true, retry: true });
  });
});

describe("POST /api/drafts/:id/approve", () => {
  it("publishes a market draft", async () => {
    const draft = await createDraft();
    const res = await request(appWith(draftResult)).post(`/api/drafts/${draft.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.draft.status).toBe("published");
    expect(store.getDraft(draft.id as string)!.status).toBe("published");
  });

  it("rejects approve on an unresolvable draft with 4xx and does not publish", async () => {
    const draft = await createDraft(unresolvableResult);
    const res = await request(appWith(unresolvableResult)).post(`/api/drafts/${draft.id}/approve`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(store.getDraft(draft.id as string)!.status).toBe("draft");
  });

  it("rejects approve on an error draft with 4xx and does not publish", async () => {
    const draft = await createDraft(errorResult);
    const res = await request(appWith(errorResult)).post(`/api/drafts/${draft.id}/approve`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(store.getDraft(draft.id as string)!.status).toBe("draft");
  });

  it("rejects approve when the close time is now in the past", async () => {
    const pastResult: GenerateResult = {
      kind: "draft",
      data: { ...marketPayload, closeTime: PAST_CLOSE },
    };
    const draft = await createDraft(pastResult);
    const res = await request(appWith(pastResult)).post(`/api/drafts/${draft.id}/approve`);
    expect(res.status).toBe(400);
    expect(store.getDraft(draft.id as string)!.status).toBe("draft");
  });
});

describe("PUT /api/drafts/:id", () => {
  it("saves edited market fields", async () => {
    const draft = await createDraft();
    const res = await request(appWith(draftResult))
      .put(`/api/drafts/${draft.id}`)
      .send({ ...marketPayload, question: "Will the X Cup final definitely be played on time?" });
    expect(res.status).toBe(200);
    expect((res.body.draft.payload as { question: string }).question).toContain("definitely");
  });

  it("rejects invalid edited data with 400", async () => {
    const draft = await createDraft();
    const res = await request(appWith(draftResult))
      .put(`/api/drafts/${draft.id}`)
      .send({ ...marketPayload, question: "short" });
    expect(res.status).toBe(400);
  });

  it("rejects edits on a published draft", async () => {
    const draft = await createDraft();
    const app = appWith(draftResult);
    await request(app).post(`/api/drafts/${draft.id}/approve`);
    const res = await request(app)
      .put(`/api/drafts/${draft.id}`)
      .send({ ...marketPayload, question: "Will the X Cup final be played on time still?" });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/drafts/:id/discard", () => {
  it("marks the draft discarded", async () => {
    const draft = await createDraft();
    const res = await request(appWith(draftResult)).post(`/api/drafts/${draft.id}/discard`);
    expect(res.status).toBe(200);
    expect(res.body.draft.status).toBe("discarded");
  });
});

describe("POST /api/drafts/manual", () => {
  it("creates a manual market draft with status draft", async () => {
    const res = await request(appWith(draftResult))
      .post("/api/drafts/manual")
      .send({ headline: "Manually drafted headline for the X Cup final", ...marketPayload });
    expect(res.status).toBe(201);
    expect(res.body.draft.status).toBe("draft");
    expect(res.body.draft.kind).toBe("market");
  });

  it("rejects manual draft with invalid fields", async () => {
    const res = await request(appWith(draftResult))
      .post("/api/drafts/manual")
      .send({ headline: "Manually drafted headline for the X Cup final", question: "no" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/drafts", () => {
  it("lists drafts", async () => {
    await createDraft();
    const res = await request(appWith(draftResult)).get("/api/drafts");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.drafts)).toBe(true);
    expect(res.body.drafts).toHaveLength(1);
  });
});

describe("publish guardrail (source-level)", () => {
  it("calls setPublished only inside the approve handler", () => {
    const src = readFileSync(path.join("src", "server.ts"), "utf8");
    const approveIdx = src.indexOf('"/api/drafts/:id/approve"');
    expect(approveIdx).toBeGreaterThan(-1);

    const setPublishedMatches = [...src.matchAll(/setPublished\s*\(/g)];
    expect(setPublishedMatches).toHaveLength(1);

    const callIdx = setPublishedMatches[0].index as number;
    const nextRouteIdx = src.indexOf("app.post(", callIdx);
    const nextGetIdx = src.indexOf("app.get(", callIdx);
    const boundaries = [nextRouteIdx, nextGetIdx].filter((i) => i > -1);
    const endOfApprove = boundaries.length ? Math.min(...boundaries) : src.length;
    expect(callIdx).toBeGreaterThan(approveIdx);
    expect(callIdx).toBeLessThan(endOfApprove);

    // No direct assignment of the "published" status anywhere in server.ts.
    expect(src).not.toMatch(/status\s*[:=]\s*["']published["']/);
  });
});
