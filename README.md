# Headline -> Market

A small tool that turns a news headline (plus an optional snippet) into a **settleable
prediction market draft**, or clearly says the headline **cannot become a fair market**.

Built for the Road to Devcon IX hackathon, Problem 2 ("Headline to Market").

## What it does

- Takes a headline and optional snippet.
- Asks an LLM (Anthropic API) to draft a market: question, close time, resolution
  source, YES/NO criteria, and edge cases.
- If the headline is subjective, vague, has no measurable outcome, no authoritative
  source, or no inferable deadline, the model returns an explicit **`unresolvable`**
  result instead of inventing a market.
- Persists every generation as a draft in SQLite and lets an editor review, edit,
  discard, or **explicitly approve** it.
- Only an explicit approval can publish a draft. Generation never publishes.

## Flow

```
headline (+ snippet)
  -> LLM (system prompt = instructions only; headline/snippet are delimited untrusted data)
  -> JSON.parse (try/catch, optional ```json fence stripped)
  -> Zod schema validation (safeParse)  -- model output is never used before this
  -> code close-time check (strictly future, <= 2 years)  [src/validate.ts]
  -> stored as status "draft"
  -> editor review (edit / discard / retry / draft manually)
  -> explicit approve  -- the ONLY path that sets status "published"
```

## The 10 acceptance checks

| # | Check | Implementation | Tests |
|---|-------|----------------|-------|
| 1 | Result is a discriminated union `market` \| `unresolvable`, validated by Zod | `src/schema.ts:30` (`z.discriminatedUnion("status", ...)`), `:24` (`unresolvable`) | `tests/schema.test.ts` |
| 2 | Headline/snippet are delimited and treated as untrusted; injection cannot change instructions | `src/generate.ts:80-81` (untrusted clause), `:88-91` (delimiters in the user message only) | `tests/generate.test.ts:79-99` |
| 3 | Model output is schema-validated before use | `src/generate.ts:177` (`safeParse`) then `:188` | `tests/generate.test.ts:66-69` |
| 4 | Close time is checked in code (strictly future, <= 2 years) and re-checked at approval | `src/validate.ts:17,27`; `src/generate.ts:194`; `src/server.ts:196` | `tests/validate.test.ts`; `tests/server.test.ts:108` |
| 5 | Anthropic client has an explicit timeout (20 s) and finite retry cap (`maxRetries: 2`) | `src/generate.ts:10,12,128-129,144` | `tests/generate.test.ts:90-91` |
| 6 | Generation always persists `status: "draft"`; only the approve handler publishes | `src/db.ts:93-95` (hardcoded `'draft'`), `:150-153` (`setPublished`); `src/server.ts:201` | `tests/server.test.ts:57,84,187` |
| 7 | Generation failure returns HTTP 200 with a message and fallback options, never 500 | `src/server.ts:55-73` (`fallback`), `:136` | `tests/server.test.ts:66,72` |
| 8 | Editor can edit (draft-only, re-validated), discard, and create manual drafts | `src/server.ts:155-175,209-219,225-250` | `tests/server.test.ts:121-172` |
| 9 | UI renders all model text via `textContent` (XSS-safe); published items marked and not editable | `public/app.js:14,19` (`textContent`), `:102,110,118` (draft-only edit, "Published — not editable") | no `innerHTML` in `public/app.js` (grep) |
| 10 | Offline tests + golden eval harness including prompt-injection cases | `evals/golden.json`, `evals/run.ts`; `tests/golden.test.ts` | `npx vitest run` |

## How to run

Requires **Node 22** (developed on `v22.18.0`).

```bash
npm install
cp .env.example .env          # then edit .env and set ANTHROPIC_API_KEY
npm run dev                   # start the server on http://localhost:3000
npm test                      # offline unit/integration tests (no network)
npm run typecheck             # tsc --noEmit
npm run eval                  # real-LLM eval over evals/golden.json (needs a key)
```

`.env` is git-ignored; never commit it. `.env.example` contains placeholders only.

## Eval results

**NOT RUN (2026-10-17).** No `ANTHROPIC_API_KEY` was available in the shell and `.env`
was absent, so `npm run eval` printed:

```
EVAL NOT RUN: no key
```

and exited with code 2. No eval numbers are reported because none were produced.
The eval harness refuses to fabricate results (see `evals/run.ts`).

## Design decisions

- **Discriminated union with `unresolvable`.** The model must return either a complete
  market or an explicit refusal with a reason and category — it is never allowed to
  emit a partial or fake market (`src/schema.ts`).
- **Headline is delimited and untrusted.** Instructions live only in the system prompt;
  the headline and snippet go in the user message inside `<headline>`/`<snippet>` tags,
  and the system prompt says to ignore any instructions inside those delimiters
  (`src/generate.ts`).
- **Timeout 20 s and `maxRetries: 2`.** Both are set on the client and per request so a
  slow or failing provider cannot hang the UI (`src/generate.ts`).
- **Never publish on generation.** `insertDraft` hardcodes `status 'draft'`; the only
  writer of `'published'` is `setPublished`, called exclusively from the approve handler
  (`src/db.ts`, `src/server.ts`). A source-level test enforces this
  (`tests/server.test.ts:187`).
- **Close-time sanity in code, not just in the prompt.** A prompt instruction alone is
  not trusted; `validateDraft` runs after schema validation and again at approval time.
- **Errors are first-class outcomes.** Generation failures return HTTP 200 with a human
  message and `{ draftManually, retry }` options so the UI can recover, never a 500.

## Limitations

- The LLM can still propose a **poor or low-quality resolution source**; the tool checks
  that the field is non-empty, not that the source is genuinely authoritative.
- Close-time validation is a **sanity check only** (in the future, within 2 years); it
  does not judge whether the deadline is the *right* one.
- There is **no authentication** on the editor UI/API; any client can edit or approve.
- The eval measures headline classification (market vs unresolvable) plus basic market
  sanity checks; it does not measure full market quality.
- The real-LLM eval has **not been run** here (no key), so model accuracy is unverified.
