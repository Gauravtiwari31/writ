// AG Studio console data (P0-11; owner: console stream; routes in apps/gateway/src/routes/console.ts).
// Flat rows only; the query endpoint takes a constrained filter DSL, never SQL. Field names are
// checked against a per-dataset allowlist on the gateway.
import { z } from "zod";
import { TimestampSchema } from "./common";

export const CONSOLE_DATASETS = ["purchases", "decisions", "attacks", "disputes", "writs", "budgets"] as const;
export const ConsoleDatasetNameSchema = z.enum(CONSOLE_DATASETS);
export type ConsoleDatasetName = z.infer<typeof ConsoleDatasetNameSchema>;

const CellSchema = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);
export const ConsoleRowSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), CellSchema);
export type ConsoleRow = z.infer<typeof ConsoleRowSchema>;

// GET /api/console/datasets/:name
export const ConsoleDatasetResponseSchema = z.strictObject({
  name: ConsoleDatasetNameSchema,
  /** Every row carries is_synthetic (seeded history shows a "synthetic history" badge). */
  rows: z.array(ConsoleRowSchema).max(10_000),
  generated_at: TimestampSchema,
});
export type ConsoleDatasetResponse = z.infer<typeof ConsoleDatasetResponseSchema>;

const FieldSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "a dataset column name");
const ScalarSchema = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

export const CONSOLE_FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"] as const;
export const ConsoleFilterSchema = z.strictObject({
  field: FieldSchema,
  op: z.enum(CONSOLE_FILTER_OPS),
  value: z.union([ScalarSchema, z.array(ScalarSchema).max(50)]),
});

// POST /api/console/query
export const ConsoleQueryRequestSchema = z.strictObject({
  dataset: ConsoleDatasetNameSchema,
  filters: z.array(ConsoleFilterSchema).max(10).default([]),
  group_by: z.array(FieldSchema).max(3).optional(),
  aggregate: z
    .strictObject({ op: z.enum(["count", "sum", "avg", "min", "max"]), field: FieldSchema.optional() })
    .optional(),
  order_by: z.strictObject({ field: FieldSchema, dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.int().min(1).max(1000).default(200),
});
export type ConsoleQueryRequest = z.infer<typeof ConsoleQueryRequestSchema>;
export const ConsoleQueryResponseSchema = z.strictObject({
  dataset: ConsoleDatasetNameSchema,
  rows: z.array(ConsoleRowSchema).max(1000),
  row_count: z.int().min(0),
});
export type ConsoleQueryResponse = z.infer<typeof ConsoleQueryResponseSchema>;
