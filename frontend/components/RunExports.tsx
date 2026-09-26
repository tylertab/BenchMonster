"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Connection, type RunExport } from "@/lib/api";
import { when } from "@/lib/format";
import { Button, Card, compactInputClass, ErrorNote } from "./ui";

export const defaultTarget = (c: Connection | undefined) => (c?.kind === "postgres" ? "benchmonster" : "benchmonster/runs");
export const targetHint = (c: Connection | undefined) =>
  c?.kind === "postgres" ? "table prefix: writes <prefix>_results and <prefix>_model_summary" : "folder: writes <folder>/<run id>/results.jsonl and summary.json";

/** Connections this org lets BenchMonster write to (and whose last check didn't fail writing). */
export const writable = (cs: Connection[]) => cs.filter((c) => c.allow_write && c.access?.write !== false);

/** Copy a finished run's results to a connection, and the history of exports. */
export function RunExports({ runId, finished }: { runId: number; finished: boolean }) {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [history, setHistory] = useState<RunExport[]>([]);
  const [connId, setConnId] = useState<number | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = () => api.runExports(runId).then(setHistory);
  useEffect(() => {
    api.connections().then((cs) => {
      const w = writable(cs);
      setConns(w);
      if (w.length) setConnId(w[0].id);
    });
    api.runExports(runId).then(setHistory);
  }, [runId]);

  const conn = conns?.find((c) => c.id === connId);
  const run = async () => {
    if (!connId) return;
    setBusy(true);
    setError(null);
    try {
      await api.exportRun(runId, { connection_id: connId, target: target.trim() || null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await loadHistory();
      setBusy(false);
    }
  };

  return (
    <Card title="Export results" actions={<span className="text-xs text-muted">copy every prediction and the per-model summary to your storage</span>}>
      {conns === null ? null : conns.length === 0 ? (
        <p className="text-sm text-ink-2">
          No connection allows writes yet.{" "}
          <Link href="/connections" className="text-accent hover:underline">
            Set one up as read and write →
          </Link>
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select className={compactInputClass} value={connId ?? ""} onChange={(e) => setConnId(Number(e.target.value))} aria-label="Export to">
              {conns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.kind === "s3" ? "files" : "Postgres"})
                </option>
              ))}
            </select>
            <input
              className={`${compactInputClass} w-56 font-mono text-xs`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={defaultTarget(conn)}
              aria-label="Export target"
            />
            <Button onClick={run} disabled={busy || !finished} title={finished ? undefined : "Wait for the run to finish"}>
              {busy ? "Exporting…" : "Export"}
            </Button>
          </div>
          <p className="text-xs text-muted">{targetHint(conn)}. Exporting again replaces this run&apos;s rows.</p>
        </div>
      )}
      <ErrorNote error={error} />
      {history.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-3 text-xs">
          {history.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-2">
              <span className={e.status === "ok" ? "text-good-ink" : "text-critical"}>{e.status === "ok" ? "✓" : "✕"}</span>
              <span className="font-medium">{e.connection_name}</span>
              <span className="font-mono text-ink-2">{e.target}</span>
              <span className="text-ink-2">{e.detail}</span>
              <span className="ml-auto text-muted">
                {e.automatic ? "automatic" : e.created_by ?? ""} · {when(e.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Export every finished run of a profile to a connection automatically. */
export function ProfileAutoExport({ profileId, connectionId, target }: { profileId: number; connectionId: number | null; target: string | null }) {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [saved, setSaved] = useState({ connectionId, target: target ?? "" });
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.connections().then((cs) => setConns(writable(cs)));
  }, []);

  const conn = conns?.find((c) => c.id === draft.connectionId);
  const dirty = draft.connectionId !== saved.connectionId || draft.target.trim() !== saved.target;
  const save = async () => {
    setError(null);
    try {
      const r = await api.setProfileExport(profileId, { connection_id: draft.connectionId, target: draft.target.trim() || null });
      const next = { connectionId: r.export_connection_id, target: r.export_target ?? "" };
      setSaved(next);
      setDraft(next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Card title="Auto-export">
      {conns === null ? null : conns.length === 0 && !saved.connectionId ? (
        <p className="text-xs text-ink-2">
          Export every run&apos;s results to your storage.{" "}
          <Link href="/connections" className="text-accent hover:underline">
            Add a read-and-write connection →
          </Link>
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          <select
            className={`${compactInputClass} w-full`}
            value={draft.connectionId ?? ""}
            onChange={(e) => setDraft({ ...draft, connectionId: e.target.value ? Number(e.target.value) : null })}
            aria-label="Auto-export connection"
          >
            <option value="">Off</option>
            {conns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {draft.connectionId && (
            <input
              className={`${compactInputClass} w-full font-mono text-xs`}
              value={draft.target}
              onChange={(e) => setDraft({ ...draft, target: e.target.value })}
              placeholder={defaultTarget(conn)}
              aria-label="Auto-export target"
              title={targetHint(conn)}
            />
          )}
          <p className="text-xs text-muted">{draft.connectionId ? "Each finished run is copied there; see the run page for status." : "Runs aren't exported automatically."}</p>
          {dirty && (
            <Button variant="secondary" onClick={save}>
              Save
            </Button>
          )}
          <ErrorNote error={error} />
        </div>
      )}
    </Card>
  );
}
