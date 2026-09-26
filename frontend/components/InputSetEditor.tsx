"use client";

import { useState } from "react";
import { api, type Dataset } from "@/lib/api";
import { Button, compactInputClass, Empty, inputClass } from "./ui";

export type ExpectedSource = "none" | "column" | "dataset";

/** Editor state for one input set (an input dataset + where its expected outputs come from). */
export type InputSet = {
  key: string;
  input: Dataset;
  mapping: Record<string, string>;
  expectedSource: ExpectedSource;
  expectedColumn: string; // column in the input file (source "column") or in the expected dataset
  expectedDataset: Dataset | null;
  matchBy: "key" | "order";
  inputKey: string;
  expectedKey: string;
  expectedValue: "row" | "column";
};

const EXPECTED_GUESSES = ["expected", "expected_output", "answer", "output", "target", "label", "gold", "reference"];
export const guessExpected = (columns: string[]) => columns.find((c) => EXPECTED_GUESSES.includes(c.toLowerCase())) ?? "";

/** A column both files share, preferring id-like names; used to match rows. */
export function guessKey(a: string[], b: string[]): string {
  const shared = a.filter((c) => b.includes(c));
  return shared.find((c) => /(^|_)id$/i.test(c)) ?? shared.find((c) => /id|key/i.test(c)) ?? shared[0] ?? "";
}

export function FormatBadge({ format }: { format: string | null | undefined }) {
  if (!format) return null;
  return <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-2">{format}</span>;
}

/** Choose a dataset from the library, or upload one. */
export function DatasetPicker({ datasets, onPick, onUploaded, onCancel, title }: {
  datasets: Dataset[];
  onPick: (d: Dataset) => void;
  onUploaded: (d: Dataset) => void;
  onCancel: () => void;
  title: string;
}) {
  const [filter, setFilter] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = datasets.filter((d) => `${d.name} ${d.filename} ${d.description ?? ""}`.toLowerCase().includes(filter.toLowerCase()));

  const upload = async (files: FileList) => {
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) onUploaded(await api.uploadDataset(f));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-accent/40 bg-accent/5 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{title}</span>
        <label className="ml-auto cursor-pointer rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2">
          <input type="file" accept=".csv,.jsonl,.ndjson,.json" className="sr-only" onChange={(e) => e.target.files?.length && upload(e.target.files)} />
          {uploading ? "Uploading…" : "Upload file"}
        </label>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-critical">{error}</p>}
      {datasets.length > 6 && <input className={inputClass} placeholder="Filter datasets…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {shown.length === 0 ? (
        <Empty>No datasets yet. Upload a CSV, JSON, or JSONL file.</Empty>
      ) : (
        <div className="grid max-h-64 gap-1.5 overflow-y-auto sm:grid-cols-2">
          {shown.map((d) => (
            <button key={d.id} type="button" onClick={() => onPick(d)} className="rounded-md border border-line bg-surface p-2 text-left text-xs hover:border-accent">
              <div className="flex items-center gap-1.5">
                <FormatBadge format={d.format} />
                <span className="truncate font-mono font-medium">{d.filename}</span>
                <span className="ml-auto shrink-0 text-muted">{d.row_count.toLocaleString()} rows</span>
              </div>
              {d.description && <div className="mt-0.5 line-clamp-1 text-ink-2">{d.description}</div>}
              <div className="mt-0.5 truncate font-mono text-muted">{d.columns.join(", ")}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A record source: each row becomes one prompt. Shows what each record variable reads from this file. */
export function InputFileCard({ set, variables, wholeRecordVars = [], onChange, onRemove }: {
  set: InputSet;
  variables: string[]; // variables read from one column of each record
  wholeRecordVars?: string[]; // variables that receive the whole record as JSON
  onChange: (s: InputSet) => void;
  onRemove: () => void;
}) {
  const props = set.input.schema?.properties ?? {};
  const cols = set.input.columns;
  const leaks = wholeRecordVars.length > 0 && set.expectedSource === "column" && set.expectedColumn;
  const usedBy = (col: string) => [
    ...variables.filter((v) => set.mapping[v] === col),
    ...wholeRecordVars,
  ];

  return (
    <div className="rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FormatBadge format={set.input.format} />
        <span className="font-mono font-medium">{set.input.filename}</span>
        <span className="text-xs text-ink-2">
          {set.input.row_count.toLocaleString()} record{set.input.row_count === 1 ? "" : "s"} → {set.input.row_count.toLocaleString()} prompt
          {set.input.row_count === 1 ? "" : "s"}
        </span>
        <button type="button" className="ml-auto text-xs text-muted hover:text-critical" onClick={onRemove}>
          Remove
        </button>
      </div>
      {set.input.description && <p className="mt-0.5 text-xs text-muted">{set.input.description}</p>}

      <table className="mt-2 w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="w-40 pb-1 font-medium">Variable</th>
            <th className="pb-1 font-medium">Value from each record of this file</th>
          </tr>
        </thead>
        <tbody>
          {wholeRecordVars.map((v) => (
            <tr key={v} className="border-t border-line">
              <td className="py-1.5">
                <code className="text-accent">{`{{${v}}}`}</code>
              </td>
              <td className="py-1.5 text-ink-2">
                the whole record: all {cols.length} columns as a JSON object
              </td>
            </tr>
          ))}
          {variables.map((v) => (
            <tr key={v} className="border-t border-line">
              <td className="py-1.5">
                <code className="text-accent">{`{{${v}}}`}</code>
              </td>
              <td className="py-1">
                <span className="mr-2 text-xs text-ink-2">column</span>
                <select
                  className={`${compactInputClass} ${set.mapping[v] ? "" : "border-critical"}`}
                  value={set.mapping[v] ?? ""}
                  onChange={(e) => onChange({ ...set, mapping: { ...set.mapping, [v]: e.target.value } })}
                  aria-label={`Column for ${v} in ${set.input.filename}`}
                >
                  <option value="">choose column…</option>
                  {cols.map((c) => (
                    <option key={c} value={c}>
                      {c}
                      {props[c]?.type ? ` (${props[c].type})` : ""}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {leaks && (
        <p className="mt-2 text-xs text-critical">
          The whole record includes the expected column <code>{set.expectedColumn}</code>, so the answer would be in the prompt. Put expected outputs in a separate file, or use record fields instead.
        </p>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted">Columns in this file ({cols.length})</summary>
        <table className="mt-1 w-full text-xs">
          <tbody>
            {cols.map((c) => {
              const used = usedBy(c);
              return (
                <tr key={c} className="border-t border-line">
                  <td className="w-44 py-1 font-mono">{c}</td>
                  <td className="w-20 py-1 text-muted">{props[c]?.type ?? ""}</td>
                  <td className="py-1 text-ink-2">
                    {used.length ? `→ ${used.map((v) => `{{${v}}}`).join(", ")}` : <span className="text-muted">not used</span>}
                    {props[c]?.description && <span className="ml-2 text-muted">· {props[c].description}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Section 3 card: where an input's expected outputs come from, and how rows are matched. */
export function ExpectedOutputCard({ set, datasets, onChange, onUploaded }: {
  set: InputSet;
  datasets: Dataset[];
  onChange: (s: InputSet) => void;
  onUploaded: (d: Dataset) => void;
}) {
  const [picking, setPicking] = useState(false);
  const exp = set.expectedDataset;
  const pickExpected = (d: Dataset) => {
    const key = guessKey(set.input.columns, d.columns);
    onChange({ ...set, expectedSource: "dataset", expectedDataset: d, matchBy: key ? "key" : "order", inputKey: key, expectedKey: key, expectedValue: "row", expectedColumn: "" });
    setPicking(false);
  };

  return (
    <div className="rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-muted">For</span>
        <span className="font-mono text-xs font-medium">{set.input.filename}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {(["dataset", "column", "none"] as ExpectedSource[]).map((src) => (
            <button
              key={src}
              type="button"
              onClick={() =>
                src === "dataset" && !exp
                  ? setPicking(true)
                  : onChange({ ...set, expectedSource: src, expectedColumn: src === "column" ? set.expectedColumn || guessExpected(set.input.columns) : set.expectedColumn })
              }
              className={`rounded-full border px-2.5 py-0.5 text-xs ${set.expectedSource === src ? "border-accent bg-accent/10 text-accent" : "border-line text-ink-2 hover:bg-surface-2"}`}
            >
              {src === "dataset" ? "Separate file" : src === "column" ? "Column in the input file" : "None"}
            </button>
          ))}
        </span>
      </div>

      {picking && (
        <div className="mt-2">
          <DatasetPicker
            title="Choose the expected-output file"
            datasets={datasets.filter((d) => d.id !== set.input.id)}
            onPick={pickExpected}
            onUploaded={(d) => {
              onUploaded(d);
              pickExpected(d);
            }}
            onCancel={() => setPicking(false)}
          />
        </div>
      )}

      {set.expectedSource === "none" && !picking && (
        <p className="mt-2 text-xs text-muted">No expected outputs: only an LLM judge with a rubric (or regex / JSON schema checks) can score these.</p>
      )}

      {set.expectedSource === "column" && (
        <label className="mt-2 flex items-center gap-2 text-sm">
          <span className="text-xs text-ink-2">Column</span>
          <select className={compactInputClass} value={set.expectedColumn} onChange={(e) => onChange({ ...set, expectedColumn: e.target.value })} aria-label="Expected column">
            <option value="">choose…</option>
            {set.input.columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      )}

      {set.expectedSource === "dataset" && exp && !picking && (
        <div className="mt-2 space-y-2 rounded-md bg-surface-2/50 p-2.5 text-sm">
          <div className="flex items-center gap-2">
            <FormatBadge format={exp.format} />
            <span className="font-mono font-medium">{exp.filename}</span>
            <span className="text-xs text-muted">{exp.row_count.toLocaleString()} rows</span>
            <button type="button" className="ml-auto text-xs text-accent hover:underline" onClick={() => setPicking(true)}>
              Change
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs text-ink-2">Match rows</span>
            <select
              className={compactInputClass}
              value={set.matchBy}
              onChange={(e) => {
                const matchBy = e.target.value as "key" | "order";
                const key = guessKey(set.input.columns, exp.columns);
                onChange({ ...set, matchBy, inputKey: set.inputKey || key, expectedKey: set.expectedKey || key });
              }}
              aria-label="Match rows by"
            >
              <option value="key">by key column</option>
              <option value="order">by row order</option>
            </select>
            {set.matchBy === "key" && (
              <>
                <select className={`${compactInputClass} ${set.inputKey ? "" : "border-critical"}`} value={set.inputKey} onChange={(e) => onChange({ ...set, inputKey: e.target.value })} aria-label="Input key column">
                  <option value="">input column…</option>
                  {set.input.columns.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <span className="text-muted">=</span>
                <select className={`${compactInputClass} ${set.expectedKey ? "" : "border-critical"}`} value={set.expectedKey} onChange={(e) => onChange({ ...set, expectedKey: e.target.value })} aria-label="Expected key column">
                  <option value="">expected column…</option>
                  {exp.columns.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs text-ink-2">Expected value</span>
            <select className={compactInputClass} value={set.expectedValue} onChange={(e) => onChange({ ...set, expectedValue: e.target.value as "row" | "column" })} aria-label="Expected value">
              <option value="row">whole row as JSON{set.matchBy === "key" && set.expectedKey ? ` (without ${set.expectedKey})` : ""}</option>
              <option value="column">one column</option>
            </select>
            {set.expectedValue === "column" && (
              <select className={`${compactInputClass} ${set.expectedColumn ? "" : "border-critical"}`} value={set.expectedColumn} onChange={(e) => onChange({ ...set, expectedColumn: e.target.value })} aria-label="Expected value column">
                <option value="">choose…</option>
                {exp.columns.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Convert editor state to the API's input-set reference. */
export function toRef(s: InputSet, mapping: Record<string, string>) {
  const fromDataset = s.expectedSource === "dataset" && s.expectedDataset;
  return {
    dataset_id: s.input.id,
    mapping,
    expected_column:
      s.expectedSource === "column" ? s.expectedColumn || null : fromDataset && s.expectedValue === "column" ? s.expectedColumn || null : null,
    expected_dataset_id: fromDataset ? s.expectedDataset!.id : null,
    input_key: fromDataset && s.matchBy === "key" ? s.inputKey || null : null,
    expected_key: fromDataset && s.matchBy === "key" ? s.expectedKey || null : null,
  };
}

/** Problems that would stop the input set from running. */
export function inputSetProblems(s: InputSet, needsExpected: boolean, label: string): string[] {
  const p: string[] = [];
  const name = s.input.filename;
  if (s.expectedSource === "column" && !s.expectedColumn) p.push(`${name}: choose the expected column.`);
  if (s.expectedSource === "dataset") {
    if (!s.expectedDataset) p.push(`${name}: choose the expected-output file.`);
    else {
      if (s.matchBy === "key" && (!s.inputKey || !s.expectedKey)) p.push(`${name}: choose both key columns.`);
      if (s.expectedValue === "column" && !s.expectedColumn) p.push(`${name}: choose the expected value column.`);
    }
  }
  if (needsExpected && s.expectedSource === "none") p.push(`${name}: ${label} scoring needs expected outputs.`);
  return p;
}
