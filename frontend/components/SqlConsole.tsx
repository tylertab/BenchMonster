"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Connection, type QueryResult, type SavedQuery, type SchemaTable } from "@/lib/api";
import { saveBlob } from "@/lib/download";
import { Button, Card, compactInputClass, ErrorNote, inputClass } from "./ui";

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

const SHORT_TYPES: Record<string, string> = {
  "double precision": "float",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "character varying": "varchar",
  integer: "int",
  bigint: "int8",
  boolean: "bool",
};
const shortType = (t: string) => SHORT_TYPES[t] ?? t;

/** Lets the page load (and optionally run) a query on a source named by the analyst. */
export type ConsoleHandle = { open: (sql: string, sourceName: string | null, run: boolean) => void };

export function SqlConsole({ sql, onSqlChange, registerConsole, onAskFix }: {
  sql: string;
  onSqlChange: (s: string) => void;
  registerConsole?: (handle: ConsoleHandle) => void;
  /** Send a failed query and its error to the analyst. */
  onAskFix?: (sql: string, error: string, sourceName: string | null) => void;
}) {
  const [schema, setSchema] = useState<SchemaTable[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ranSql, setRanSql] = useState(""); // last query run (for "ask the analyst to fix")
  const [openTable, setOpenTable] = useState<string | null>("results");
  // Where queries run: BenchMonster's own data (null) or a Postgres connection.
  const [source, setSource] = useState<number | null>(null);
  const [pgConns, setPgConns] = useState<Connection[]>([]);
  const sourceConn = pgConns.find((c) => c.id === source);
  // Latest editor text, so a slow schema load doesn't overwrite what was typed meanwhile.
  const sqlRef = useRef(sql);
  const pgConnsRef = useRef<Connection[]>([]);
  const sourceRef = useRef<number | null>(null);
  useEffect(() => {
    sqlRef.current = sql;
    pgConnsRef.current = pgConns;
    sourceRef.current = source;
  }, [sql, pgConns, source]);

  // Saved queries (shared across the org). `active` is the one loaded in the editor.
  // "Save as…" always creates a new query; only "Update" overwrites the active one.
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [resultSql, setResultSql] = useState("");
  const [exporting, setExporting] = useState<"csv" | "json" | null>(null);

  const run = async (text = sql, on = source) => {
    setBusy(true);
    setError(null);
    setRanSql(text);
    try {
      setResult(await api.query(text, on));
      setResultSql(text);
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const download = async (format: "csv" | "json") => {
    setExporting(format);
    setError(null);
    try {
      const f = await api.exportQuery(resultSql, format, active && resultSql === active.sql ? active.name : undefined, source);
      saveBlob(f.blob, f.filename);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(null);
    }
  };
  const [active, setActive] = useState<SavedQuery | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null); // non-null = "Save as" form open
  const refreshSaved = () => api.savedQueries().then(setSaved);
  const dirty = active !== null && sql !== active.sql;

  const saveAsNew = async () => {
    const name = (saveName ?? "").trim();
    if (!name) return;
    setError(null);
    try {
      let q: SavedQuery;
      try {
        q = await api.saveQuery(name, sql, source);
      } catch (e) {
        const existing = saved.find((s) => s.name.toLowerCase() === name.toLowerCase());
        if (!(e instanceof ApiError && e.status === 409 && existing)) throw e;
        if (!window.confirm(`A saved query named "${existing.name}" already exists. Replace it?`)) return;
        q = await api.updateQuery(existing.id, existing.name, sql, source);
      }
      setActive(q);
      setSaveName(null);
      await refreshSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const updateActive = async () => {
    if (!active) return;
    setError(null);
    try {
      setActive(await api.updateQuery(active.id, active.name, sql, source));
      await refreshSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rename = async (q: SavedQuery) => {
    const name = window.prompt("Rename saved query", q.name)?.trim();
    if (!name || name === q.name) return;
    setError(null);
    try {
      const updated = await api.updateQuery(q.id, name, q.sql, q.connection_id);
      if (active?.id === q.id) setActive(updated);
      await refreshSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const load = (q: SavedQuery) => {
    setActive(q);
    onSqlChange(q.sql);
    if (q.connection_id !== source) switchSource(q.connection_id, false);
    run(q.sql, q.connection_id);
  };

  /** Point the console at another source; its schema replaces the sidebar. */
  const switchSource = (id: number | null, sample = true) => {
    const before = sql;
    setSource(id);
    setResult(null);
    setError(null);
    setSchema([]);
    api.schema(id).then(
      (tables) => {
        setSchema(tables);
        setOpenTable(id === null ? "results" : tables[0]?.name ?? null);
        if (sample && id !== null && tables[0] && sqlRef.current === before) {
          setActive(null);
          onSqlChange(`select *\nfrom ${tables[0].name}\nlimit 100`);
        }
      },
      (e) => setError(e.message),
    );
  };

  const remove = async (q: SavedQuery) => {
    if (!window.confirm(`Delete saved query "${q.name}"?`)) return;
    await api.deleteQuery(q.id);
    if (active?.id === q.id) setActive(null);
    refreshSaved();
  };

  useEffect(() => {
    registerConsole?.({
      open: (text, name, andRun) => {
        const id = name ? (pgConnsRef.current.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id ?? null) : null;
        if (id !== sourceRef.current) switchSource(id, false);
        setActive(null);
        onSqlChange(text);
        if (andRun) run(text, id);
      },
    });
  });
  useEffect(() => {
    api.schema().then(setSchema);
    api.savedQueries().then(setSaved);
    api.connections().then((cs) => setPgConns(cs.filter((c) => c.kind === "postgres" && c.access?.read)), () => {});
    // Show the default query's result on first load.
    api.query(sql).then((r) => {
      setResult(r);
      setResultSql(sql);
    }, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



  return (
    <Card
      title="SQL console"
      actions={
        <span className="flex items-center gap-2 text-xs text-muted">
          {pgConns.length > 0 && (
            <select className={`${compactInputClass} max-w-52 py-0.5 text-xs`} value={source ?? ""} onChange={(e) => switchSource(e.target.value ? Number(e.target.value) : null)} aria-label="Query source">
              <option value="">BenchMonster data</option>
              {pgConns.map((c) => (
                <option key={c.id} value={c.id}>
                  ⇄ {c.name}
                </option>
              ))}
            </select>
          )}
          {sourceConn ? "read-only · 15s timeout" : <>read-only · your org&apos;s data · 5s timeout</>}
        </span>
      }
      className="flex min-w-0 flex-col"
    >
      <div className="grid gap-3 md:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)]">
        <aside className="max-h-96 min-w-0 overflow-y-auto pr-3 text-xs [scrollbar-gutter:stable]">
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
                    {q.connection_name && <span className="text-muted"> ⇄ {q.connection_name}</span>}
                    {active?.id === q.id && dirty && <span className="text-muted"> •</span>}
                  </button>
                  <button type="button" onClick={() => rename(q)} className="invisible px-0.5 text-muted hover:text-ink group-hover:visible" aria-label={`Rename ${q.name}`}>
                    ✎
                  </button>
                  <button type="button" onClick={() => remove(q)} className="invisible px-0.5 text-muted hover:text-critical group-hover:visible" aria-label={`Delete ${q.name}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mb-1 font-medium text-muted">{sourceConn ? `Tables in ${sourceConn.name}` : "Views"}</div>
          {schema.map((t) => (
            <div key={t.name}>
              <button type="button" className="flex w-full gap-1 py-0.5 text-left font-mono font-medium hover:text-accent" title={t.name} onClick={() => setOpenTable(openTable === t.name ? null : t.name)}>
                <span className="shrink-0">{openTable === t.name ? "▾" : "▸"}</span>
                <span className="min-w-0 break-all">{t.name}</span>
              </button>
              {openTable === t.name && (
                <ul className="mb-1 ml-3">
                  {t.columns.map((c) => (
                    <li key={c.name} className="flex items-baseline justify-between gap-2 font-mono">
                      <button type="button" className="min-w-0 break-all text-left hover:text-accent" title={`${c.name} (${c.type})`} onClick={() => onSqlChange(`${sql}${sql.endsWith(" ") || !sql ? "" : " "}${c.name}`)}>
                        {c.name}
                      </button>
                      <span className="shrink-0 text-muted">{shortType(c.type)}</span>
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
              <>
                {dirty && (
                  <Button variant="secondary" onClick={updateActive} title={`Overwrite "${active.name}" with the query in the editor`}>
                    Update “{active.name.length > 18 ? `${active.name.slice(0, 17)}…` : active.name}”
                  </Button>
                )}
                <Button variant="secondary" onClick={() => setSaveName("")} disabled={!sql.trim()}>
                  Save as…
                </Button>
              </>
            ) : (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveAsNew();
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
                  Save
                </Button>
                <Button type="button" variant="ghost" onClick={() => setSaveName(null)}>
                  Cancel
                </Button>
              </form>
            )}
            {result && (
              <span className="ml-auto text-xs text-ink-2">
                {result.row_count} rows{result.truncated && " (showing first 1,000)"} · {result.elapsed_ms}ms
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <ErrorNote error={error} />
        {error && onAskFix && ranSql && (
          <button type="button" className="mb-2 text-xs text-accent hover:underline" onClick={() => onAskFix(ranSql, error, sourceConn?.name ?? null)}>
            Ask the analyst to fix this query →
          </button>
        )}
        {result && result.columns.length > 0 && (
          <>
            <div className="mb-1.5 flex items-center justify-end gap-2 text-xs">
              <span className="text-muted">Download{result.truncated ? " all rows (up to 50,000)" : ""}:</span>
              <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => download("csv")} disabled={exporting !== null}>
                {exporting === "csv" ? "…" : "⬇ CSV"}
              </Button>
              <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => download("json")} disabled={exporting !== null}>
                {exporting === "json" ? "…" : "⬇ JSON"}
              </Button>
            </div>
            <ResultTable columns={result.columns.map((c) => c.name)} rows={result.rows} />
          </>
        )}
      </div>
    </Card>
  );
}
