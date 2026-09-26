"use client";

import { useEffect, useState } from "react";
import { api, type QueryResult, type SavedQuery, type SchemaTable } from "@/lib/api";
import { Button, Card, ErrorNote, inputClass } from "./ui";

export function presetQueries(runId: number) {
  return [
    {
      label: "Leaderboard",
      sql: `select model, round(accuracy::numeric, 3) as accuracy, round(p50_latency_ms::numeric) as p50_ms,\n       total_cost_usd, cost_per_pass_usd\nfrom model_summary\nwhere run_id = ${runId}\norder by accuracy desc, total_cost_usd`,
    },
    {
      label: "Hardest cases",
      sql: `select case_idx, left(input, 80) as input, count(*) filter (where passed) as models_passed, count(*) as models\nfrom results\nwhere run_id = ${runId}\ngroup by case_idx, input\norder by models_passed, case_idx\nlimit 10`,
    },
    {
      label: "Failures",
      sql: `select model, case_idx, expected, left(output, 120) as output, error\nfrom results\nwhere run_id = ${runId} and not coalesce(passed, false)\norder by model, case_idx`,
    },
    {
      label: "Latency percentiles",
      sql: `select model,\n       percentile_cont(0.5) within group (order by latency_ms) as p50,\n       percentile_cont(0.9) within group (order by latency_ms) as p90,\n       percentile_cont(0.99) within group (order by latency_ms) as p99\nfrom results\nwhere run_id = ${runId} and error is null\ngroup by model order by p50`,
    },
    {
      label: "Reasoning overhead",
      sql: `select model, sum(reasoning_tokens) as reasoning, sum(tokens_out) as total_out,\n       round(100.0 * sum(reasoning_tokens) / nullif(sum(tokens_out), 0), 1) as reasoning_pct\nfrom results\nwhere run_id = ${runId}\ngroup by model order by reasoning_pct desc nulls last`,
    },
  ];
}

function cell(v: unknown) {
  if (v === null || v === undefined) return <span className="text-muted">null</span>;
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toPrecision(6).replace(/\.?0+$/, "");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function ResultTable({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  return (
    <div className="max-h-96 overflow-auto rounded-md border border-line">
      <table className="tabular w-full text-xs">
        <thead className="sticky top-0 bg-surface-2 text-left">
          <tr>
            {columns.map((c) => (
              <th key={c} className="whitespace-nowrap px-2 py-1.5 font-medium text-ink-2">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line align-top">
              {r.map((v, j) => (
                <td key={j} className="max-w-xs truncate px-2 py-1" title={typeof v === "string" ? v : undefined}>
                  {cell(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SqlConsole({ runId, sql, onSqlChange }: { runId: number; sql: string; onSqlChange: (s: string) => void }) {
  const [schema, setSchema] = useState<SchemaTable[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openTable, setOpenTable] = useState<string | null>("results");

  // Saved queries (shared across the org). `active` is the one loaded in the editor.
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [active, setActive] = useState<SavedQuery | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null); // non-null = save form open
  const refreshSaved = () => api.savedQueries().then(setSaved);

  const persist = async (asNew: boolean) => {
    const name = (saveName ?? "").trim();
    if (!name) return;
    setError(null);
    try {
      const q = active && !asNew ? await api.updateQuery(active.id, name, sql) : await api.saveQuery(name, sql);
      setActive(q);
      setSaveName(null);
      await refreshSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const load = (q: SavedQuery) => {
    setActive(q);
    onSqlChange(q.sql);
    run(q.sql);
  };

  const remove = async (q: SavedQuery) => {
    if (!window.confirm(`Delete saved query "${q.name}"?`)) return;
    await api.deleteQuery(q.id);
    if (active?.id === q.id) setActive(null);
    refreshSaved();
  };

  useEffect(() => {
    api.schema().then(setSchema);
    api.savedQueries().then(setSaved);
    // Show the default query's result on first load.
    api.query(sql).then(setResult, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (text = sql) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.query(text));
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const presets = presetQueries(runId);

  return (
    <Card
      title="SQL console"
      actions={<span className="text-xs text-muted">read-only · your org&apos;s data · 5s timeout</span>}
      className="flex min-w-0 flex-col"
    >
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setActive(null);
              onSqlChange(p.sql);
              run(p.sql);
            }}
            className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-[180px_1fr]">
        <aside className="max-h-80 overflow-y-auto text-xs">
          <div className="mb-1 font-medium text-muted">Saved queries</div>
          {saved.length === 0 ? (
            <p className="mb-3 text-muted">None yet. Write a query and click Save.</p>
          ) : (
            <ul className="mb-3 space-y-0.5">
              {saved.map((q) => (
                <li key={q.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => load(q)}
                    title={`${q.sql}${q.created_by ? `\n\nby ${q.created_by}` : ""}`}
                    className={`flex-1 truncate rounded px-1 py-0.5 text-left hover:bg-surface-2 ${active?.id === q.id ? "bg-accent/10 font-medium text-accent" : ""}`}
                  >
                    ★ {q.name}
                  </button>
                  <button type="button" onClick={() => remove(q)} className="invisible px-1 text-muted hover:text-critical group-hover:visible" aria-label={`Delete ${q.name}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mb-1 font-medium text-muted">Views</div>
          {schema.map((t) => (
            <div key={t.name}>
              <button type="button" className="w-full py-0.5 text-left font-mono font-medium hover:text-accent" onClick={() => setOpenTable(openTable === t.name ? null : t.name)}>
                {openTable === t.name ? "▾" : "▸"} {t.name}
              </button>
              {openTable === t.name && (
                <ul className="mb-1 ml-3">
                  {t.columns.map((c) => (
                    <li key={c.name} className="flex justify-between gap-2 font-mono">
                      <button type="button" className="truncate text-left hover:text-accent" onClick={() => onSqlChange(`${sql}${sql.endsWith(" ") || !sql ? "" : " "}${c.name}`)}>
                        {c.name}
                      </button>
                      <span className="text-muted">{c.type.replace("double precision", "float").replace("timestamp with time zone", "timestamptz")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </aside>
        <div className="min-w-0 space-y-2">
          <textarea
            value={sql}
            onChange={(e) => onSqlChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                run();
              }
            }}
            spellCheck={false}
            rows={8}
            className="w-full rounded-md border border-line bg-surface-2/40 p-2.5 font-mono text-xs outline-none focus:border-accent"
            aria-label="SQL query"
          />
          <div className="flex items-center gap-3">
            <Button onClick={() => run()} disabled={busy || !sql.trim()}>
              {busy ? "Running…" : "Run"}
            </Button>
            <span className="text-xs text-muted">⌘/Ctrl + Enter</span>
            {saveName === null ? (
              <Button variant="secondary" onClick={() => setSaveName(active?.name ?? "")} disabled={!sql.trim()}>
                {active ? "Save…" : "Save as…"}
              </Button>
            ) : (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  persist(false);
                }}
              >
                <input
                  autoFocus
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setSaveName(null)}
                  placeholder="Query name"
                  className={`${inputClass} w-44 py-1`}
                  aria-label="Saved query name"
                />
                <Button type="submit" disabled={!saveName.trim()}>
                  {active ? "Update" : "Save"}
                </Button>
                {active && (
                  <Button type="button" variant="secondary" onClick={() => persist(true)} disabled={!saveName.trim() || saveName.trim() === active.name}>
                    Save as new
                  </Button>
                )}
                <Button type="button" variant="ghost" onClick={() => setSaveName(null)}>
                  Cancel
                </Button>
              </form>
            )}
            {result && (
              <span className="ml-auto text-xs text-ink-2">
                {result.row_count} rows{result.truncated && " (truncated)"} · {result.elapsed_ms}ms
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <ErrorNote error={error} />
        {result && result.columns.length > 0 && <ResultTable columns={result.columns.map((c) => c.name)} rows={result.rows} />}
      </div>
    </Card>
  );
}
