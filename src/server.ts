import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MarketSchema, type Market } from "./schema.js";
import { validateDraft } from "./validate.js";
import { generateMarket, type GenerateInput, type GenerateResult } from "./generate.js";
import { openDb, type DraftRecord, type DraftStore } from "./db.js";

export interface AppOptions {
  store?: DraftStore;
  generate?: (input: GenerateInput) => Promise<GenerateResult>;
  now?: () => Date;
  publicDir?: string;
}

const HUMAN_ERROR: Record<string, string> = {
  invalid_output:
    "The model returned something we could not turn into a market. Draft it manually or retry.",
  timeout:
    "The model took too long to respond. Draft it manually or retry.",
  api_error:
    "The model provider returned an error. Draft it manually or retry.",
  stale_close_time:
    "The model proposed a close time that is not valid. Draft it manually or retry.",
};

/** Body shape of a market as sent by the editor (no "status" field). */
function coerceMarketPayload(body: unknown): unknown {
  if (body === null || typeof body !== "object") return body;
  return { ...(body as Record<string, unknown>), status: "market" };
}

function validateMarketPayload(payload: unknown, now: Date):
  | { ok: true; market: Market }
  | { ok: false; reason: string } {
  const parsed = MarketSchema.safeParse(coerceMarketPayload(payload));
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  const timeCheck = validateDraft(parsed.data, now);
  if (!timeCheck.ok) return { ok: false, reason: timeCheck.reason };
  return { ok: true, market: parsed.data };
}

/** Serialize a stored record for the API, adding fallbacks for error drafts. */
function serialize(record: DraftRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: record.id,
    headline: record.headline,
    snippet: record.snippet,
    kind: record.kind,
    status: record.status,
    payload: record.payload,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  if (record.kind === "error") {
    const payload = (record.payload ?? {}) as { code?: string; message?: string };
    base.message =
      HUMAN_ERROR[payload.code ?? ""] ??
      payload.message ??
      "Generation failed.";
    base.fallback = { draftManually: true, retry: true };
  }
  return base;
}

function parseHeadline(body: unknown): { headline: string; snippet?: string } | null {
  if (body === null || typeof body !== "object") return null;
  const { headline, snippet } = body as { headline?: unknown; snippet?: unknown };
  if (typeof headline !== "string") return null;
  const trimmedHeadline = headline.trim();
  if (trimmedHeadline.length < 5 || trimmedHeadline.length > 300) return null;
  let trimmedSnippet: string | undefined;
  if (snippet !== undefined && snippet !== null) {
    if (typeof snippet !== "string") return null;
    trimmedSnippet = snippet.trim();
    if (trimmedSnippet.length > 1000) return null;
    if (trimmedSnippet.length === 0) trimmedSnippet = undefined;
  }
  return trimmedSnippet === undefined
    ? { headline: trimmedHeadline }
    : { headline: trimmedHeadline, snippet: trimmedSnippet };
}

export function createApp(options: AppOptions = {}): Express {
  const store = options.store ?? openDb();
  const runGenerate =
    options.generate ?? ((input: GenerateInput) => generateMarket(input));
  const now = options.now ?? (() => new Date());
  const publicDir =
    options.publicDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  const notFound = (res: Response): void => {
    res.status(404).json({ error: "draft not found" });
  };

  // POST /api/drafts -- generate and persist as status "draft"
  app.post("/api/drafts", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = parseHeadline(req.body);
      if (!input) {
        res.status(400).json({
          error:
            "headline must be a string of 5..300 characters; snippet must be <= 1000 characters",
        });
        return;
      }
      const result = await runGenerate(input);
      let record: DraftRecord;
      if (result.kind === "draft") {
        record = store.insertDraft({ ...input, kind: "market", payload: result.data });
      } else if (result.kind === "unresolvable") {
        record = store.insertDraft({ ...input, kind: "unresolvable", payload: result.data });
      } else {
        record = store.insertDraft({
          ...input,
          kind: "error",
          payload: { code: result.code, message: result.message, raw: result.raw },
        });
      }
      // Generation errors are a normal, handled outcome -> HTTP 200.
      res.status(200).json({ draft: serialize(record) });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/drafts
  app.get("/api/drafts", (_req: Request, res: Response) => {
    res.json({ drafts: store.listDrafts().map(serialize) });
  });

  // GET /api/drafts/:id
  app.get("/api/drafts/:id", (req: Request, res: Response) => {
    const record = store.getDraft(String(req.params.id));
    if (!record) return notFound(res);
    res.json({ draft: serialize(record) });
  });

  // PUT /api/drafts/:id -- editor edits market fields while status is "draft"
  app.put("/api/drafts/:id", (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = store.getDraft(String(req.params.id));
      if (!record) return notFound(res);
      if (record.status !== "draft") {
        res.status(409).json({ error: `cannot edit a ${record.status} draft` });
        return;
      }
      if (record.kind !== "market") {
        res.status(400).json({
          error: "only market drafts can be edited; use POST /api/drafts/manual instead",
        });
        return;
      }
      const check = validateMarketPayload(req.body, now());
      if (!check.ok) {
        res.status(400).json({ error: check.reason });
        return;
      }
      const updated = store.updatePayload(record.id, "market", check.market);
      res.json({ draft: serialize(updated!) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/drafts/:id/approve -- the ONLY place a draft becomes "published"
  app.post("/api/drafts/:id/approve", (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = store.getDraft(String(req.params.id));
      if (!record) return notFound(res);
      if (record.status !== "draft") {
        res.status(409).json({ error: `cannot approve a ${record.status} draft` });
        return;
      }
      if (record.kind !== "market") {
        res.status(400).json({
          error: `cannot approve a draft of kind "${record.kind}"; only "market" drafts can be published`,
        });
        return;
      }
      const check = validateMarketPayload(record.payload, now());
      if (!check.ok) {
        res.status(400).json({ error: check.reason });
        return;
      }
      const published = store.setPublished(record.id);
      res.json({ draft: serialize(published!) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/drafts/:id/discard
  app.post("/api/drafts/:id/discard", (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = store.getDraft(String(req.params.id));
      if (!record) return notFound(res);
      if (record.status === "published") {
        res.status(409).json({ error: "published drafts cannot be discarded" });
        return;
      }
      const discarded = store.setStatus(record.id, "discarded");
      res.json({ draft: serialize(discarded!) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/drafts/manual -- editor creates a market draft by hand after a failure
  app.post("/api/drafts/manual", (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const headline = typeof body.headline === "string" ? body.headline.trim() : "";
      if (headline.length < 5 || headline.length > 300) {
        res.status(400).json({ error: "headline must be a string of 5..300 characters" });
        return;
      }
      const check = validateMarketPayload(body, now());
      if (!check.ok) {
        res.status(400).json({ error: check.reason });
        return;
      }
      const snippet =
        typeof body.snippet === "string" && body.snippet.trim().length > 0
          ? body.snippet.trim().slice(0, 1000)
          : null;
      const record = store.insertDraft({
        headline,
        snippet,
        kind: "market",
        payload: check.market,
      });
      res.status(201).json({ draft: serialize(record) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/drafts/:id/retry -- re-run generation for the same headline
  app.post("/api/drafts/:id/retry", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = store.getDraft(String(req.params.id));
      if (!record) return notFound(res);
      if (record.status === "published") {
        res.status(409).json({ error: "a published draft cannot be retried" });
        return;
      }
      const input: GenerateInput =
        record.snippet === null
          ? { headline: record.headline }
          : { headline: record.headline, snippet: record.snippet };
      const result = await runGenerate(input);
      const kind = result.kind === "draft" ? "market" : result.kind;
      const payload =
        result.kind === "error"
          ? { code: result.code, message: result.message, raw: result.raw }
          : result.data;
      store.setStatus(record.id, "draft");
      const updated = store.updatePayload(record.id, kind, payload);
      res.json({ draft: serialize(updated!) });
    } catch (err) {
      next(err);
    }
  });

  // Static UI
  app.use(express.static(publicDir));

  // 404 for unknown API routes
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });

  // Global error handler -- never leak a 500 for handled/validation paths.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const isBodyParseError = err instanceof SyntaxError && "body" in err;
    if (isBodyParseError) {
      res.status(400).json({ error: "invalid JSON body" });
      return;
    }
    const message = err instanceof Error ? err.message : "internal error";
    res.status(500).json({ error: "internal server error", detail: message });
  });

  return app;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`listening on http://localhost:${port}`);
  });
}
