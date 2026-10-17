import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type DraftKind = "market" | "unresolvable" | "error";
export type DraftStatus = "draft" | "published" | "discarded";

/** Statuses that generic code (insert / edit / discard / retry) is allowed to write. */
export type NonPublishedStatus = Exclude<DraftStatus, "published">;

export interface DraftRecord {
  id: string;
  headline: string;
  snippet: string | null;
  kind: DraftKind;
  /** Parsed JSON payload (market | unresolvable | error body). */
  payload: unknown;
  status: DraftStatus;
  created_at: string;
  updated_at: string;
}

export interface InsertDraftInput {
  headline: string;
  snippet?: string | null;
  kind: DraftKind;
  payload: unknown;
}

export interface DraftStore {
  insertDraft(input: InsertDraftInput): DraftRecord;
  listDrafts(): DraftRecord[];
  getDraft(id: string): DraftRecord | undefined;
  updatePayload(
    id: string,
    kind: DraftKind,
    payload: unknown,
  ): DraftRecord | undefined;
  setStatus(id: string, status: NonPublishedStatus): DraftRecord | undefined;
  /** The ONLY writer of the "published" status. Called solely from the approve handler. */
  setPublished(id: string): DraftRecord | undefined;
  close(): void;
}

interface DraftRow {
  id: string;
  headline: string;
  snippet: string | null;
  kind: DraftKind;
  payload: string;
  status: DraftStatus;
  created_at: string;
  updated_at: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  headline TEXT NOT NULL,
  snippet TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('market','unresolvable','error')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','discarded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function rowToRecord(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    headline: row.headline,
    snippet: row.snippet,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function openDb(filename: string = process.env.MARKET_DB ?? "market.db"): DraftStore {
  const database = new Database(filename);
  database.pragma("journal_mode = WAL");
  database.exec(SCHEMA_SQL);

  const selectById = database.prepare<[string], DraftRow>(
    "SELECT * FROM drafts WHERE id = ?",
  );
  const selectAll = database.prepare<[], DraftRow>(
    "SELECT * FROM drafts ORDER BY created_at DESC",
  );

  const insert = database.prepare(
    `INSERT INTO drafts (id, headline, snippet, kind, payload, status, created_at, updated_at)
     VALUES (@id, @headline, @snippet, @kind, @payload, 'draft', @created_at, @created_at)`,
  );

  const updatePayloadStmt = database.prepare(
    `UPDATE drafts SET kind = @kind, payload = @payload, updated_at = @updated_at WHERE id = @id`,
  );

  const updateStatusStmt = database.prepare(
    `UPDATE drafts SET status = @status, updated_at = @updated_at WHERE id = @id`,
  );

  return {
    // Generation ALWAYS inserts with status "draft" (hardcoded above).
    insertDraft(input: InsertDraftInput): DraftRecord {
      const now = new Date().toISOString();
      const id = randomUUID();
      insert.run({
        id,
        headline: input.headline,
        snippet: input.snippet ?? null,
        kind: input.kind,
        payload: JSON.stringify(input.payload),
        created_at: now,
      });
      const record = this.getDraft(id);
      if (!record) {
        throw new Error("insertDraft: row vanished immediately after insert");
      }
      return record;
    },

    listDrafts(): DraftRecord[] {
      return selectAll.all().map(rowToRecord);
    },

    getDraft(id: string): DraftRecord | undefined {
      const row = selectById.get(id);
      return row ? rowToRecord(row) : undefined;
    },

    updatePayload(id: string, kind: DraftKind, payload: unknown): DraftRecord | undefined {
      updatePayloadStmt.run({
        id,
        kind,
        payload: JSON.stringify(payload),
        updated_at: new Date().toISOString(),
      });
      return this.getDraft(id);
    },

    setStatus(id: string, status: NonPublishedStatus): DraftRecord | undefined {
      updateStatusStmt.run({ id, status, updated_at: new Date().toISOString() });
      return this.getDraft(id);
    },

    setPublished(id: string): DraftRecord | undefined {
      updateStatusStmt.run({
        id,
        status: "published",
        updated_at: new Date().toISOString(),
      });
      return this.getDraft(id);
    },

    close(): void {
      database.close();
    },
  };
}
