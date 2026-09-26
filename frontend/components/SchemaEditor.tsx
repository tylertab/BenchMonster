"use client";

import { useState } from "react";
import { api, type JsonSchema, type ValidationReport } from "@/lib/api";
import { Button, compactInputClass, ErrorNote, inputClass } from "./ui";

const TYPES = ["string", "integer", "number", "boolean", "object", "array"];

/**
 * Edit a dataset's row schema: per-column type, required, and description in a
 * table, with the full JSON Schema available for anything more (enums, patterns).
 */
export function SchemaEditor({ datasetId, columns, initial, onSaved }: {
  datasetId: number;
  columns: string[];
  initial: JsonSchema;
  onSaved: (s: JsonSchema) => Promise<void>;
}) {
  const [schema, setSchema] = useState<JsonSchema>(initial);
  const [raw, setRaw] = useState<string | null>(null); // non-null = JSON view
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const setProp = (col: string, patch: Record<string, unknown>) =>
    setSchema({ ...schema, properties: { ...props, [col]: { ...(props[col] ?? {}), ...patch } } });
  const setRequired = (col: string, on: boolean) =>
    setSchema({ ...schema, required: on ? [...required, col] : [...required].filter((c) => c !== col) });

  const current = (): JsonSchema => {
    if (raw === null) return schema;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Schema JSON is not valid JSON");
    }
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            if (raw === null) setRaw(JSON.stringify(schema, null, 2));
            else
              act(async () => {
                const s = current();
                setSchema(s);
                setRaw(null);
              });
          }}
        >
          {raw === null ? "Edit as JSON" : "Back to table"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            act(async () => {
              const s = await api.inferSchema(datasetId);
              setSchema(s);
              if (raw !== null) setRaw(JSON.stringify(s, null, 2));
              setReport(null);
            })
          }
          disabled={busy}
        >
          Re-infer from data
        </Button>
        <span className="ml-auto flex gap-2">
          <Button type="button" variant="secondary" onClick={() => act(async () => setReport(await api.validateDataset(datasetId, current())))} disabled={busy}>
            Validate all rows
          </Button>
          <Button
            type="button"
            onClick={() =>
              act(async () => {
                const s = current();
                await onSaved(s);
                setSchema(s);
              })
            }
            disabled={busy}
          >
            Save schema
          </Button>
        </span>
      </div>

      {raw !== null ? (
        <textarea rows={14} spellCheck={false} className={`${inputClass} font-mono text-xs`} value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="Schema JSON" />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-2 py-1.5 font-medium">Column</th>
                <th className="px-2 py-1.5 font-medium">Type</th>
                <th className="px-2 py-1.5 font-medium">Required</th>
                <th className="px-2 py-1.5 font-medium">Description</th>
                <th className="px-2 py-1.5 font-medium">Other rules</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c) => {
                const p = props[c] ?? {};
                const extra = Object.keys(p).filter((k) => !["type", "description"].includes(k));
                return (
                  <tr key={c} className="border-t border-line">
                    <td className="px-2 py-1.5 font-mono text-xs">{c}</td>
                    <td className="px-2 py-1">
                      <select className={compactInputClass} value={typeof p.type === "string" ? p.type : ""} onChange={(e) => setProp(c, { type: e.target.value || undefined })} aria-label={`Type of ${c}`}>
                        <option value="">any</option>
                        {TYPES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <input type="checkbox" checked={required.has(c)} onChange={(e) => setRequired(c, e.target.checked)} aria-label={`${c} required`} />
                    </td>
                    <td className="px-2 py-1">
                      <input className={`${inputClass} py-1`} value={typeof p.description === "string" ? p.description : ""} onChange={(e) => setProp(c, { description: e.target.value || undefined })} placeholder="What this column holds" />
                    </td>
                    <td className="px-2 py-1.5 font-mono text-xs text-muted">{extra.length ? extra.join(", ") : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">Values are stored as text; validation converts them to each column&apos;s type first. Use JSON view for enums, patterns, or nested objects.</p>
      <ErrorNote error={error} />
      {report && (
        <div className={`rounded-md border px-3 py-2 text-sm ${report.invalid ? "border-critical/30 bg-critical/10" : "border-good/30 bg-good/10"}`}>
          {report.invalid ? (
            <>
              <div className="font-medium text-critical">
                ✕ {report.invalid} of {report.checked} rows don&apos;t match
              </div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {report.errors.map((e, i) => (
                  <li key={i}>
                    row {e.row} · <code>{e.field}</code>: {e.message}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span className="font-medium text-good-ink">✓ All {report.checked} rows match the schema</span>
          )}
        </div>
      )}
    </div>
  );
}
