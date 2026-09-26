import type { FilterOp, RecordSelection } from "./api";

export const OPS: { op: FilterOp; label: string; hint?: string }[] = [
  { op: "eq", label: "=" },
  { op: "neq", label: "≠" },
  { op: "in", label: "is one of", hint: "comma-separated" },
  { op: "not_in", label: "is not one of", hint: "comma-separated" },
  { op: "contains", label: "contains" },
  { op: "not_contains", label: "doesn't contain" },
  { op: "gt", label: ">" },
  { op: "gte", label: "≥" },
  { op: "lt", label: "<" },
  { op: "lte", label: "≤" },
  { op: "empty", label: "is empty" },
  { op: "not_empty", label: "is not empty" },
  { op: "regex", label: "matches regex" },
];
export const NO_VALUE: FilterOp[] = ["empty", "not_empty"];
const LABEL = Object.fromEntries(OPS.map((o) => [o.op, o.label]));

export const isDefaultSelection = (s: RecordSelection | null | undefined) => !s || (!s.rules?.length && !s.dedupe_on && (s.pick ?? "all") === "all");

/** Drop empty parts so an untouched selection saves as {} (and doesn't count as a change). */
export function cleanSelection(s: RecordSelection): RecordSelection {
  if (isDefaultSelection(s)) return {};
  const out: RecordSelection = {};
  if (s.rules?.length) {
    out.rules = s.rules;
    if (s.match === "any") out.match = "any";
  }
  if (s.dedupe_on) out.dedupe_on = s.dedupe_on;
  if (s.pick && s.pick !== "all") {
    out.pick = s.pick;
    out.n = s.n ?? null;
    if (s.pick === "random" && s.seed != null && s.seed !== 1) out.seed = s.seed;
  }
  return out;
}

/** "where tier = 'pro', one per sku, random 50 (seed 1)", matching the backend's wording. */
export function describeSelection(s: RecordSelection | null | undefined): string {
  if (!s || isDefaultSelection(s)) return "";
  const parts: string[] = [];
  if (s.rules?.length) {
    parts.push(
      "where " +
        s.rules.map((r) => `${r.field} ${LABEL[r.op]}${NO_VALUE.includes(r.op) ? "" : ` '${r.value}'`}`).join(s.match === "any" ? " or " : " and "),
    );
  }
  if (s.dedupe_on) parts.push(`one per ${s.dedupe_on}`);
  if (s.pick && s.pick !== "all" && s.n) parts.push(s.pick === "first" ? `first ${s.n}` : `random ${s.n} (seed ${s.seed ?? 1})`);
  return parts.join(", ");
}
