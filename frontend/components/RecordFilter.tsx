"use client";

import { useEffect, useState } from "react";
import { api, type Dataset, type FilterRule, type RecordSelection, type SelectionPreview } from "@/lib/api";
import { cleanSelection, isDefaultSelection, NO_VALUE, OPS } from "@/lib/selection";
import { compactInputClass } from "./ui";

/**
 * Which records of the record file a run uses: filter rules, one per field value,
 * and first / random N. Shows a live count from the server.
 */
export function RecordFilter({ dataset, value, onChange }: { dataset: Dataset; value: RecordSelection; onChange: (s: RecordSelection) => void }) {
  const [open, setOpen] = useState(!isDefaultSelection(value));
  const [preview, setPreview] = useState<SelectionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rules = value.rules ?? [];
  const pick = value.pick ?? "all";
  const key = JSON.stringify(cleanSelection(value));

  useEffect(() => {
    const t = setTimeout(() => {
      api.previewSelection(dataset.id, JSON.parse(key)).then(
        (p) => {
          setPreview(p);
          setError(null);
        },
        (e) => setError(e.message),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [dataset.id, key]);

  const set = (patch: Partial<RecordSelection>) => onChange({ ...value, ...patch });
  const setRule = (i: number, patch: Partial<FilterRule>) => set({ rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const addRule = () => set({ rules: [...rules, { field: dataset.columns[0] ?? "", op: "eq", value: "" }] });
  const count = preview && !error ? preview.selected : null;

  return (
    <div className="rounded-md border border-line">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
        <span className="text-muted">{open ? "▾" : "▸"}</span>
        <span className="font-medium">Records to use</span>
        <span className="text-ink-2">
          {count == null ? "…" : count === dataset.row_count ? `all ${count.toLocaleString()}` : `${count.toLocaleString()} of ${dataset.row_count.toLocaleString()}`}
        </span>
        {!isDefaultSelection(value) && preview?.description && <span className="min-w-0 truncate text-xs text-muted">· {preview.description}</span>}
        {!open && isDefaultSelection(value) && <span className="ml-auto text-xs text-accent">Filter or sample</span>}
      </button>

      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3 text-sm">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted">
              Keep records where
              {rules.length > 1 && (
                <select className={compactInputClass} value={value.match ?? "all"} onChange={(e) => set({ match: e.target.value as "all" | "any" })} aria-label="Match all or any">
                  <option value="all">all rules match</option>
                  <option value="any">any rule matches</option>
                </select>
              )}
              {rules.length === 0 && <span>(no filters: every record)</span>}
            </div>
            {rules.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select className={compactInputClass} value={r.field} onChange={(e) => setRule(i, { field: e.target.value })} aria-label="Filter field">
                  {dataset.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select className={compactInputClass} value={r.op} onChange={(e) => setRule(i, { op: e.target.value as FilterRule["op"] })} aria-label="Filter operator">
                  {OPS.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {!NO_VALUE.includes(r.op) && (
                  <input
                    className={`${compactInputClass} w-48 font-mono`}
                    value={r.value}
                    onChange={(e) => setRule(i, { value: e.target.value })}
                    placeholder={OPS.find((o) => o.op === r.op)?.hint ?? "value"}
                    aria-label="Filter value"
                  />
                )}
                <button type="button" onClick={() => set({ rules: rules.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-critical" aria-label="Remove filter">
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={addRule} className="text-xs text-accent hover:underline">
              + Add filter
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 text-xs text-ink-2">
              One record per
              <select className={compactInputClass} value={value.dedupe_on ?? ""} onChange={(e) => set({ dedupe_on: e.target.value || null })} aria-label="Dedupe field">
                <option value="">(keep duplicates)</option>
                {dataset.columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-2">
              Then use
              <select className={compactInputClass} value={pick} onChange={(e) => set({ pick: e.target.value as RecordSelection["pick"], n: value.n ?? 10 })} aria-label="Which records">
                <option value="all">all of them</option>
                <option value="first">the first</option>
                <option value="random">a random sample of</option>
              </select>
              {pick !== "all" && (
                <input type="number" min={1} max={10000} className={`${compactInputClass} w-20`} value={value.n ?? ""} onChange={(e) => set({ n: e.target.value ? Number(e.target.value) : null })} aria-label="Number of records" />
              )}
            </label>
            {pick === "random" && (
              <label className="flex items-center gap-2 text-xs text-ink-2" title="The same seed picks the same records every run">
                seed
                <input type="number" min={0} className={`${compactInputClass} w-20`} value={value.seed ?? 1} onChange={(e) => set({ seed: Number(e.target.value) || 0 })} aria-label="Random seed" />
              </label>
            )}
          </div>

          {error ? (
            <p className="text-xs text-critical">{error}</p>
          ) : (
            preview && (
              <div className="space-y-1.5">
                <p className="text-xs text-ink-2">
                  {preview.total.toLocaleString()} records
                  {rules.length > 0 && <> → {preview.matched.toLocaleString()} match the filters</>}
                  {value.dedupe_on && <> → {preview.unique.toLocaleString()} unique</>}
                  {pick !== "all" && <> → {preview.selected.toLocaleString()} used</>}
                  {preview.selected === 0 && <span className="text-critical"> · no records left to run</span>}
                </p>
                {preview.rows.length > 0 && !isDefaultSelection(value) && (
                  <div className="overflow-x-auto rounded border border-line">
                    <table className="w-full text-xs">
                      <thead className="bg-surface-2 text-left text-muted">
                        <tr>
                          <th className="px-2 py-1 font-medium">#</th>
                          {dataset.columns.map((c) => (
                            <th key={c} className="px-2 py-1 font-mono font-medium">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((r) => (
                          <tr key={r.idx} className="border-t border-line">
                            <td className="tabular px-2 py-1 text-muted">{r.idx}</td>
                            {dataset.columns.map((c) => (
                              <td key={c} className="max-w-48 truncate px-2 py-1" title={r[c]}>
                                {r[c]}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {preview.selected > preview.rows.length && <div className="px-2 py-1 text-[11px] text-muted">first {preview.rows.length} of {preview.selected.toLocaleString()} shown</div>}
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
