import type { FieldSpec, ParseAs } from "./api";

/** Mirrors backend/app/fields.py so the editor's prompt preview matches what the run sends. */

export const PARSE_LABEL: Record<ParseAs, string> = {
  auto: "auto",
  text: "text",
  integer: "integer",
  number: "number",
  boolean: "true / false",
  json: "JSON",
};

/** A sensible parse for a Postgres column type (or a dataset schema type). */
export function defaultParse(type: string | undefined): ParseAs {
  if (!type) return "auto";
  if (/^(smallint|integer|bigint|integer)$/.test(type)) return "integer";
  if (/^(real|double precision|numeric|number)$/.test(type)) return "number";
  if (type === "boolean") return "boolean";
  if (/^(json|jsonb|object|array)$/.test(type)) return "json";
  if (/(char|text|string|uuid|date|time)/.test(type)) return "text";
  return "auto";
}

const TRUE = new Set(["true", "t", "yes", "y", "1"]);
const FALSE = new Set(["false", "f", "no", "n", "0"]);

function auto(raw: string): unknown {
  const s = raw.trim();
  if (s === "true" || s === "false") return s === "true";
  if (s !== "" && !Number.isNaN(Number(s)) && Number.isFinite(Number(s))) return Number(s);
  return raw;
}

export function parseValue(raw: string | null | undefined, spec: FieldSpec): unknown {
  if (raw == null) return null;
  const s = raw.trim();
  const parse = spec.parse ?? "auto";
  if (parse === "text") return raw;
  if (parse !== "auto" && s === "") return null;
  let v: unknown;
  if (parse === "auto") v = auto(raw);
  else if (parse === "integer") v = Number.isFinite(Number(s)) ? Math.trunc(Number(s)) : raw;
  else if (parse === "number") v = Number.isFinite(Number(s)) ? Number(s) : raw;
  else if (parse === "boolean") v = TRUE.has(s.toLowerCase()) ? true : FALSE.has(s.toLowerCase()) ? false : raw;
  else {
    try {
      v = JSON.parse(s);
    } catch {
      v = raw;
    }
  }
  if (typeof v === "number" && !Number.isInteger(v) && spec.decimals != null) {
    const f = 10 ** spec.decimals;
    v = Math.round(v * f) / f;
  }
  return v;
}

export function asText(value: unknown, spec: FieldSpec): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && spec.decimals != null && !Number.isInteger(value)) return value.toFixed(spec.decimals);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export const fieldKey = (f: FieldSpec) => (f.name ?? "").trim() || f.column;

/** Record JSON and {{field}} values for a preview row, given the field spec (null = every column, auto). */
export function renderRow(row: Record<string, string>, columns: string[], fields: FieldSpec[] | null) {
  const specs = fields ?? columns.map((c) => ({ column: c }));
  const byColumn = new Map(specs.map((f) => [f.column, f]));
  return {
    record: () => JSON.stringify(Object.fromEntries(specs.map((f) => [fieldKey(f), parseValue(row[f.column], f)]))),
    value: (column: string) => {
      const spec = byColumn.get(column) ?? { column };
      return asText(parseValue(row[column], spec), spec);
    },
  };
}

/** "age (integer), introversion ← introversion_score (number, 2 dp), …" */
export function describeFields(fields: FieldSpec[] | null | undefined): string {
  if (!fields) return "";
  return fields
    .map((f) => {
      const name = fieldKey(f) === f.column ? f.column : `${fieldKey(f)} ← ${f.column}`;
      const how = [f.parse && f.parse !== "auto" ? PARSE_LABEL[f.parse] : "", f.decimals != null ? `${f.decimals} dp` : ""].filter(Boolean).join(", ");
      return how ? `${name} (${how})` : name;
    })
    .join(", ");
}
