"use client";

import { useState } from "react";
import type { FieldSpec, ParseAs } from "@/lib/api";
import { defaultParse, fieldKey, PARSE_LABEL, parseValue } from "@/lib/fields";
import { compactInputClass } from "./ui";

/**
 * Which columns of the record source reach the prompt, under what name, parsed how.
 * null = every column, parsed automatically.
 */
export function FieldParsing({ columns, types, value, onChange, sample, expectedColumn }: {
  columns: string[];
  types: Record<string, string | undefined>;
  value: FieldSpec[] | null;
  onChange: (f: FieldSpec[] | null) => void;
  sample: Record<string, string> | null;
  expectedColumn?: string;
}) {
  const [open, setOpen] = useState(value !== null);
  const custom = value !== null;
  const byColumn = new Map((value ?? []).map((f) => [f.column, f]));
  // Order: chosen fields in their order, then the rest.
  const rows = custom ? [...value!.map((f) => f.column), ...columns.filter((c) => !byColumn.has(c))] : columns;

  const start = () =>
    onChange(columns.filter((c) => c !== expectedColumn).map((c) => ({ column: c, parse: defaultParse(types[c]) })));
  const set = (column: string, patch: Partial<FieldSpec> | null) => {
    const current = value ?? [];
    if (patch === null) return onChange(current.filter((f) => f.column !== column));
    if (!byColumn.has(column)) return onChange([...current, { column, parse: defaultParse(types[column]), ...patch }]);
    onChange(current.map((f) => (f.column === column ? { ...f, ...patch } : f)));
  };
  const preview = (f: FieldSpec) => {
    if (!sample) return "";
    const v = parseValue(sample[f.column], f);
    return JSON.stringify(v);
  };

  return (
    <div className="rounded-md border border-line">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
        <span className="text-muted">{open ? "▾" : "▸"}</span>
        <span className="font-medium">Fields and parsing</span>
        <span className="text-ink-2">{custom ? `${value!.length} of ${columns.length} fields` : `all ${columns.length} fields, parsed automatically`}</span>
        {!open && !custom && <span className="ml-auto text-xs text-accent">Choose fields</span>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-3">
          {!custom ? (
            <p className="text-sm text-ink-2">
              Every field goes into the record JSON with its type guessed from the data.{" "}
              <button type="button" onClick={start} className="text-accent hover:underline">
                Choose fields and how each is parsed
              </button>
              {expectedColumn && (
                <>
                  {" "}
                  (starts without <code>{expectedColumn}</code>, the expected output)
                </>
              )}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="pb-1.5 pr-2 font-medium">Use</th>
                      <th className="pb-1.5 pr-2 font-medium">Column</th>
                      <th className="pb-1.5 pr-2 font-medium">Name in prompt</th>
                      <th className="pb-1.5 pr-2 font-medium">Parse as</th>
                      <th className="pb-1.5 pr-2 font-medium">Decimals</th>
                      <th className="pb-1.5 font-medium">{sample ? "Sample → parsed" : ""}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => {
                      const f = byColumn.get(c);
                      return (
                        <tr key={c} className={`border-t border-line ${f ? "" : "text-muted"}`}>
                          <td className="py-1 pr-2">
                            <input type="checkbox" checked={!!f} onChange={(e) => set(c, e.target.checked ? {} : null)} aria-label={`Use ${c}`} />
                          </td>
                          <td className="py-1 pr-2 font-mono text-xs">
                            {c}
                            {types[c] && <span className="ml-1 text-muted">{types[c]}</span>}
                            {c === expectedColumn && <span className="ml-1 rounded bg-warning/15 px-1 text-[10px] text-warning">expected output</span>}
                          </td>
                          <td className="py-1 pr-2">
                            {f && (
                              <input
                                className={`${compactInputClass} w-36 py-0.5 font-mono text-xs`}
                                value={f.name ?? ""}
                                placeholder={c}
                                onChange={(e) => set(c, { name: e.target.value || null })}
                                aria-label={`Name for ${c}`}
                              />
                            )}
                          </td>
                          <td className="py-1 pr-2">
                            {f && (
                              <select className={`${compactInputClass} py-0.5 text-xs`} value={f.parse ?? "auto"} onChange={(e) => set(c, { parse: e.target.value as ParseAs })} aria-label={`Parse ${c} as`}>
                                {(Object.keys(PARSE_LABEL) as ParseAs[]).map((p) => (
                                  <option key={p} value={p}>
                                    {PARSE_LABEL[p]}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                          <td className="py-1 pr-2">
                            {f && (f.parse === "number" || f.parse === "auto") && (
                              <input
                                type="number"
                                min={0}
                                max={10}
                                className={`${compactInputClass} w-16 py-0.5 text-xs`}
                                value={f.decimals ?? ""}
                                placeholder="all"
                                onChange={(e) => set(c, { decimals: e.target.value === "" ? null : Number(e.target.value) })}
                                aria-label={`Decimals for ${c}`}
                              />
                            )}
                          </td>
                          <td className="max-w-72 truncate py-1 font-mono text-xs text-ink-2" title={sample?.[c]}>
                            {sample && (
                              <>
                                {sample[c]}
                                {f && (
                                  <>
                                    {" "}
                                    <span className="text-muted">→</span> <span className="text-ink">{preview(f)}</span>
                                  </>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="text-muted">
                  The record JSON has {value!.length} key{value!.length === 1 ? "" : "s"}: {value!.map((f) => fieldKey(f)).join(", ") || "none"}.
                </span>
                <button type="button" onClick={() => onChange(null)} className="ml-auto text-accent hover:underline">
                  Reset to all fields
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
