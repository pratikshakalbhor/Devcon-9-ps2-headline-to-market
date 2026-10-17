import { z } from "zod";

export const UnresolvableCategorySchema = z.enum([
  "subjective",
  "no_measurable_outcome",
  "no_deadline",
  "no_authoritative_source",
  "opinion",
  "other",
]);

export type UnresolvableCategory = z.infer<typeof UnresolvableCategorySchema>;

export const MarketSchema = z.object({
  status: z.literal("market"),
  question: z.string().min(15),
  closeTime: z.string().datetime({ offset: true }),
  resolutionSource: z.string().min(3),
  yesCriteria: z.string().min(15),
  noCriteria: z.string().min(10),
  edgeCases: z.string().min(15),
});

export const UnresolvableSchema = z.object({
  status: z.literal("unresolvable"),
  reason: z.string().min(10),
  category: UnresolvableCategorySchema,
});

export const DraftResultSchema = z.discriminatedUnion("status", [
  MarketSchema,
  UnresolvableSchema,
]);

export type Market = z.infer<typeof MarketSchema>;
export type Unresolvable = z.infer<typeof UnresolvableSchema>;
export type DraftResult = z.infer<typeof DraftResultSchema>;
