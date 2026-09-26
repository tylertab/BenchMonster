"use client";

import type { ScoringMethod } from "@/lib/api";
import { Field, inputClass } from "./ui";

export const METHODS: { value: ScoringMethod; label: string; description: string; needsExpected: boolean }[] = [
  { value: "exact", label: "Exact match", description: "Output equals the expected value (ignores case, spacing, trailing punctuation).", needsExpected: true },
  { value: "contains", label: "Contains", description: "Expected value appears anywhere in the output.", needsExpected: true },
  { value: "numeric", label: "Numeric", description: "Last number in the output matches the expected number within a tolerance.", needsExpected: true },
  { value: "regex", label: "Regex", description: "Output matches a pattern (a shared one, or each row's expected value).", needsExpected: false },
  { value: "json_schema", label: "JSON schema", description: "Output is valid JSON matching a schema; optionally equal to expected JSON.", needsExpected: false },
  { value: "json_fields", label: "JSON field match", description: "Parses JSON output and scores the fraction of fields that match the expected JSON.", needsExpected: true },
  { value: "llm_judge", label: "LLM judge", description: "A judge model grades 0–10 against the expected answer and your rubric.", needsExpected: false },
];

export type ScoringState = {
  case_sensitive: boolean;
  pattern: string;
  tolerance: string;
  rel_tolerance: string;
  schema: string;
  match_expected: boolean;
  rubric: string;
  pass_threshold: string;
  fields: string; // json_fields: comma-separated paths; empty = every expected key
  fields_schema: string; // json_fields: optional schema checked first
  fields_threshold: string;
};

export const DEFAULT_SCORING: ScoringState = {
  case_sensitive: false,
  pattern: "",
  tolerance: "0.01",
  rel_tolerance: "0",
  schema: '{\n  "type": "object",\n  "required": ["answer"]\n}',
  match_expected: false,
  rubric: "",
  pass_threshold: "0.7",
  fields: "",
  fields_schema: "",
  fields_threshold: "1",
};

const clamp01 = (v: string, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" ? Math.min(1, Math.max(0, n)) : fallback;
};

/** Build the backend scoring_config; throws with a user-facing message on bad input. */
export function buildScoringConfig(method: ScoringMethod, s: ScoringState): Record<string, unknown> {
  switch (method) {
    case "exact":
    case "contains":
      return { case_sensitive: s.case_sensitive };
    case "regex":
      if (s.pattern) new RegExp(s.pattern); // throws SyntaxError on a bad pattern
      return s.pattern ? { pattern: s.pattern, case_sensitive: s.case_sensitive } : { case_sensitive: s.case_sensitive };
    case "numeric":
      return { tolerance: Number(s.tolerance) || 0, rel_tolerance: Number(s.rel_tolerance) || 0 };
    case "json_schema":
      try {
        return { schema: JSON.parse(s.schema), match_expected: s.match_expected };
      } catch {
        throw new Error("JSON schema is not valid JSON");
      }
    case "json_fields": {
      const cfg: Record<string, unknown> = { pass_threshold: clamp01(s.fields_threshold, 1) };
      const fields = s.fields.split(",").map((f) => f.trim()).filter(Boolean);
      if (fields.length) cfg.fields = fields;
      if (s.fields_schema.trim()) {
        try {
          cfg.schema = JSON.parse(s.fields_schema);
        } catch {
          throw new Error("JSON schema is not valid JSON");
        }
      }
      return cfg;
    }
    case "llm_judge":
      return { rubric: s.rubric || undefined, pass_threshold: clamp01(s.pass_threshold, 0.7) };
  }
}

export function ScoringConfig({ method, state, onChange }: { method: ScoringMethod; state: ScoringState; onChange: (s: ScoringState) => void }) {
  const set = <K extends keyof ScoringState>(k: K, v: ScoringState[K]) => onChange({ ...state, [k]: v });
  const caseBox = (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={state.case_sensitive} onChange={(e) => set("case_sensitive", e.target.checked)} />
      Case sensitive
    </label>
  );

  switch (method) {
    case "exact":
    case "contains":
      return caseBox;
    case "regex":
      return (
        <div className="space-y-3">
          <Field label="Pattern" hint="Leave empty to use each row's expected value as the pattern">
            <input className={`${inputClass} font-mono`} value={state.pattern} onChange={(e) => set("pattern", e.target.value)} placeholder="^(yes|no)$" />
          </Field>
          {caseBox}
        </div>
      );
    case "numeric":
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Absolute tolerance">
            <input type="number" step="any" min="0" className={inputClass} value={state.tolerance} onChange={(e) => set("tolerance", e.target.value)} />
          </Field>
          <Field label="Relative tolerance" hint="0.01 = within 1%">
            <input type="number" step="any" min="0" className={inputClass} value={state.rel_tolerance} onChange={(e) => set("rel_tolerance", e.target.value)} />
          </Field>
        </div>
      );
    case "json_schema":
      return (
        <div className="space-y-3">
          <Field label="JSON schema">
            <textarea rows={7} className={`${inputClass} font-mono text-xs`} value={state.schema} onChange={(e) => set("schema", e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={state.match_expected} onChange={(e) => set("match_expected", e.target.checked)} />
            Also require output to equal the expected JSON
          </label>
        </div>
      );
    case "json_fields":
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_12rem] gap-3">
            <Field label="Fields to compare" hint="Comma-separated; dotted paths reach nested keys. Empty = every key in the expected JSON.">
              <input className={`${inputClass} font-mono`} value={state.fields} onChange={(e) => set("fields", e.target.value)} placeholder="category, priority, customer.tier" />
            </Field>
            <Field label="Pass threshold" hint="Fraction of fields (1 = all)">
              <input type="number" step="0.05" min="0" max="1" className={inputClass} value={state.fields_threshold} onChange={(e) => set("fields_threshold", e.target.value)} />
            </Field>
          </div>
          <Field label="JSON schema (optional)" hint="If set, output must validate first or it scores 0">
            <textarea rows={5} className={`${inputClass} font-mono text-xs`} value={state.fields_schema} onChange={(e) => set("fields_schema", e.target.value)} placeholder='{"type": "object", "required": ["category", "priority"]}' />
          </Field>
          <p className="text-xs text-muted">Strings ignore case and extra whitespace; lists ignore order.</p>
        </div>
      );
    case "llm_judge":
      return (
        <div className="space-y-3">
          <Field label="Rubric" hint="What makes an answer good? Defaults to correctness vs. the expected answer.">
            <textarea
              rows={4}
              className={inputClass}
              value={state.rubric}
              onChange={(e) => set("rubric", e.target.value)}
              placeholder="Answer must name the correct API and include a working code example. Penalize hallucinated parameters."
            />
          </Field>
          <Field label="Pass threshold" hint="Judge score (0–1) needed to count as a pass">
            <input type="number" step="0.05" min="0" max="1" className={inputClass} value={state.pass_threshold} onChange={(e) => set("pass_threshold", e.target.value)} />
          </Field>
        </div>
      );
  }
}

/** Inverse of buildScoringConfig: prefill the form from a stored config (clone & edit). */
export function scoringStateFrom(cfg: Record<string, unknown>, method?: ScoringMethod): ScoringState {
  const s = { ...DEFAULT_SCORING };
  if (method === "json_fields") {
    if (Array.isArray(cfg.fields)) s.fields = cfg.fields.join(", ");
    if (cfg.schema != null) s.fields_schema = JSON.stringify(cfg.schema, null, 2);
    if (cfg.pass_threshold != null) s.fields_threshold = String(cfg.pass_threshold);
    return s;
  }
  if (typeof cfg.case_sensitive === "boolean") s.case_sensitive = cfg.case_sensitive;
  if (typeof cfg.pattern === "string") s.pattern = cfg.pattern;
  if (cfg.tolerance != null) s.tolerance = String(cfg.tolerance);
  if (cfg.rel_tolerance != null) s.rel_tolerance = String(cfg.rel_tolerance);
  if (cfg.schema != null) s.schema = JSON.stringify(cfg.schema, null, 2);
  if (typeof cfg.match_expected === "boolean") s.match_expected = cfg.match_expected;
  if (typeof cfg.rubric === "string") s.rubric = cfg.rubric;
  if (cfg.pass_threshold != null) s.pass_threshold = String(cfg.pass_threshold);
  return s;
}
