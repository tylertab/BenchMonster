"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AccessBadges, connectionTarget, PROVIDER_LABEL } from "@/components/ConnectionForm";
import { FormatBadge } from "@/components/InputSetEditor";
import { RuleRows } from "@/components/RecordFilter";
import { Button, Card, compactInputClass, Empty, ErrorNote, inputClass } from "@/components/ui";
import { api, type BrowseResult, type Connection, type Dataset, type FilterRule, type ImportIn, type PgTable } from "@/lib/api";
import { when } from "@/lib/format";

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/** Name + "refresh before every run" + Import, shared by files, tables and queries. */
function ImportBar({ defaultName, onImport, busy }: { defaultName: string; onImport: (b: Pick<ImportIn, "name" | "auto_refresh">) => void; busy: boolean }) {
  const [name, setName] = useState(defaultName);
  const [auto, setAuto] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className={`${compactInputClass} w-64`} value={name} onChange={(e) => setName(e.target.value)} aria-label="Dataset name" placeholder="Dataset name" />
      <label className="flex items-center gap-1.5 text-xs text-ink-2" title="Re-read the source before every run that uses this dataset">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        refresh before every run
      </label>
      <Button onClick={() => onImport({ name, auto_refresh: auto })} disabled={busy || !name.trim()}>
        {busy ? "Importing…" : "Import as dataset"}
      </Button>
    </div>
  );
}

function FileBrowser({ conn, imported, onImport, busy }: { conn: Connection; imported: Dataset[]; onImport: (b: ImportIn) => void; busy: boolean }) {
  const [folder, setFolder] = useState("");
  const [data, setData] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    api.browseConnection(conn.id, folder).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(e.message),
    );
  }, [conn.id, folder]);

  const parts = folder ? folder.split("/") : [];
  const importedPaths = new Map(imported.filter((d) => d.source?.path).map((d) => [d.source!.path!, d]));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1 font-mono text-sm">
        <button type="button" className="text-accent hover:underline" onClick={() => setFolder("")}>
          {(conn.config as { bucket: string }).bucket}
        </button>
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-muted">/</span>
            <button type="button" className="text-accent hover:underline" onClick={() => setFolder(parts.slice(0, i + 1).join("/"))}>
              {p}
            </button>
          </span>
        ))}
      </div>
      <ErrorNote error={error} />
      {!data ? (
        !error && <Empty>Loading…</Empty>
      ) : data.folders.length + data.files.length === 0 ? (
        <Empty>No folders or .csv / .jsonl / .json files here.</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {data.folders.map((f) => (
            <li key={f}>
              <button type="button" onClick={() => setFolder(f)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2">
                <span aria-hidden>📁</span>
                <span className="font-mono">{f.split("/").pop()}/</span>
              </button>
            </li>
          ))}
          {data.files.map((f) => {
            const name = f.path.split("/").pop()!;
            const existing = importedPaths.get(f.path);
            return (
              <li key={f.path} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <FormatBadge format={name.split(".").pop()} />
                  <span className="font-mono">{name}</span>
                  <span className="text-xs text-muted">
                    {size(f.size)} · modified {when(f.modified)}
                  </span>
                  {existing && (
                    <Link href={`/datasets/${existing.id}`} className="text-xs text-accent hover:underline">
                      imported as {existing.name}
                    </Link>
                  )}
                  <Button variant={chosen === f.path ? "ghost" : "secondary"} className="ml-auto" onClick={() => setChosen(chosen === f.path ? null : f.path)}>
                    {chosen === f.path ? "Cancel" : "Import…"}
                  </Button>
                </div>
                {chosen === f.path && (
                  <div className="mt-2">
                    <ImportBar defaultName={name.replace(/\.[^.]+$/, "")} busy={busy} onImport={(b) => onImport({ ...b, path: f.path })} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data?.truncated && <p className="text-xs text-muted">Showing the first 1,000 entries.</p>}
    </div>
  );
}

function TableBrowser({ conn, onImport, busy }: { conn: Connection; onImport: (b: ImportIn) => void; busy: boolean }) {
  const [tables, setTables] = useState<PgTable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"table" | "query">("table");
  const [table, setTable] = useState<PgTable | null>(null);
  const [rules, setRules] = useState<FilterRule[]>([]);
  const [match, setMatch] = useState<"all" | "any">("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    api.connectionTables(conn.id).then(setTables, (e) => setError(e.message));
  }, [conn.id]);

  const full = (t: PgTable) => `${t.schema}.${t.name}`;
  return (
    <div className="space-y-3">
      <div className="flex gap-1 text-sm">
        {(["table", "query"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={`rounded-md px-3 py-1 ${mode === m ? "bg-accent/10 font-medium text-accent" : "text-ink-2 hover:bg-surface-2"}`}>
            {m === "table" ? "From a table" : "From a SQL query"}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      {mode === "table" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]">
          <ul className="max-h-96 overflow-y-auto rounded-md border border-line text-sm">
            {tables === null && !error && <li className="px-3 py-2 text-muted">Loading…</li>}
            {tables?.length === 0 && <li className="px-3 py-2 text-muted">No tables this user can read.</li>}
            {tables?.map((t) => (
              <li key={full(t)}>
                <button
                  type="button"
                  onClick={() => {
                    setTable(t);
                    setRules([]);
                  }}
                  className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-surface-2 ${table && full(table) === full(t) ? "bg-accent/10 text-accent" : ""}`}
                >
                  <span className="min-w-0 break-all font-mono text-xs">{t.schema === "public" ? t.name : full(t)}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted">{t.type === "VIEW" ? "view" : t.approx_rows ? `~${t.approx_rows.toLocaleString()} rows` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
          {table ? (
            <div className="space-y-3">
              <div>
                <div className="font-mono text-sm font-medium">{full(table)}</div>
                <div className="mt-0.5 break-words font-mono text-xs text-muted">{table.columns.join(", ")}</div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted">
                  Import rows where
                  {rules.length > 1 && (
                    <select className={compactInputClass} value={match} onChange={(e) => setMatch(e.target.value as "all" | "any")} aria-label="Match all or any">
                      <option value="all">all rules match</option>
                      <option value="any">any rule matches</option>
                    </select>
                  )}
                  {rules.length === 0 && <span>(no filters: every row, up to 5,000)</span>}
                </div>
                <RuleRows columns={table.columns} rules={rules} onChange={setRules} />
                <button type="button" onClick={() => setRules([...rules, { field: table.columns[0], op: "eq", value: "" }])} className="text-xs text-accent hover:underline">
                  + Add filter
                </button>
                <p className="text-xs text-muted">Filters run in the database, so only matching rows are copied.</p>
              </div>
              <ImportBar key={full(table)} defaultName={table.name} busy={busy} onImport={(b) => onImport({ ...b, table: full(table), rules, match })} />
            </div>
          ) : (
            <Empty>Choose a table or view.</Empty>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <textarea
            rows={7}
            spellCheck={false}
            className={`${inputClass} font-mono text-xs`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={"select ticket_id, subject, body\nfrom support_tickets\nwhere created_at > now() - interval '30 days'"}
            aria-label="SQL query"
          />
          <p className="text-xs text-muted">Runs as a read-only SELECT in your database (15 s limit, up to 5,000 rows).</p>
          <ImportBar defaultName="query results" busy={busy} onImport={(b) => onImport({ ...b, query })} />
        </div>
      )}
    </div>
  );
}

export default function ConnectionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [conn, setConn] = useState<Connection | null>(null);
  const [imported, setImported] = useState<Dataset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.connections().then(
      (cs) => {
        const c = cs.find((x) => x.id === Number(id));
        if (c) setConn(c);
        else setError("Connection not found");
      },
      (e) => setError(e.message),
    );
    api.datasets().then((ds) => setImported(ds.filter((d) => d.source?.connection_id === Number(id))));
  }, [id]);

  const doImport = async (body: ImportIn) => {
    setBusy(true);
    setError(null);
    try {
      const { id: datasetId } = await api.importFromConnection(Number(id), body);
      router.push(`/datasets/${datasetId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (!conn) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/connections" className="text-sm text-ink-2 hover:text-ink">
          ← Connections
        </Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
          {conn.name}
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-ink-2">
            {PROVIDER_LABEL[conn.provider]} · {conn.kind === "s3" ? "Object storage" : "Postgres"}
          </span>
          <AccessBadges access={conn.access} allowWrite={conn.allow_write} />
        </h1>
        <p className="mt-1 font-mono text-xs text-ink-2">{connectionTarget(conn)}</p>
      </div>
      <ErrorNote error={error} />

      <Card title={conn.kind === "s3" ? "Files" : "Tables"} actions={<span className="text-xs text-muted">importing copies the rows into a dataset you can refresh later</span>}>
        {conn.kind === "s3" ? <FileBrowser conn={conn} imported={imported} onImport={doImport} busy={busy} /> : <TableBrowser conn={conn} onImport={doImport} busy={busy} />}
      </Card>

      <Card title={`Datasets imported from ${conn.name}`}>
        {imported.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {imported.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                <FormatBadge format={d.format} />
                <Link href={`/datasets/${d.id}`} className="font-medium hover:text-accent">
                  {d.name}
                </Link>
                <span className="font-mono text-xs text-muted">{d.source?.path ?? d.source?.table ?? "SQL query"}</span>
                <span className="text-xs text-muted">{d.row_count.toLocaleString()} rows</span>
                {d.source?.auto_refresh && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">refreshes before runs</span>}
                <span className="ml-auto text-xs text-muted">synced {d.source?.synced_at ? when(d.source.synced_at) : "–"}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
