import type { Market } from "./schema.js";

export type ValidateResult = { ok: true } | { ok: false; reason: string };

/**
 * Pure validation of a schema-valid market draft against the current time.
 * - closeTime must be strictly in the future (closeTime <= now is rejected)
 * - closeTime must not be more than 2 years away
 */
export function validateDraft(market: Market, now: Date): ValidateResult {
  const closeMs = Date.parse(market.closeTime);

  if (Number.isNaN(closeMs)) {
    return { ok: false, reason: "closeTime is not a parseable datetime" };
  }

  if (closeMs <= now.getTime()) {
    return {
      ok: false,
      reason: `closeTime (${market.closeTime}) is not strictly in the future`,
    };
  }

  const maxClose = new Date(now.getTime());
  maxClose.setUTCFullYear(maxClose.getUTCFullYear() + 2);

  if (closeMs > maxClose.getTime()) {
    return {
      ok: false,
      reason: `closeTime (${market.closeTime}) is more than 2 years away`,
    };
  }

  return { ok: true };
}
