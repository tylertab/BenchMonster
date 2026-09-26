"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { AccessBadges, ConnectionForm, connectionTarget, PROVIDER_LABEL } from "@/components/ConnectionForm";
import { Button, Card, Empty, ErrorNote } from "@/components/ui";
import { api, type Connection } from "@/lib/api";
import { when } from "@/lib/format";

export default function ConnectionsPage() {
  const { me } = useAuth();
  const owner = me?.role === "owner";
  const [items, setItems] = useState<Connection[] | null>(null);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [checking, setChecking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.connections().then(setItems, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const recheck = async (c: Connection) => {
    setChecking(c.id);
    try {
      const next = await api.recheckConnection(c.id);
      setItems((cur) => cur?.map((x) => (x.id === c.id ? next : x)) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(null);
    }
  };

  const remove = async (c: Connection) => {
    if (!window.confirm(`Delete ${c.name}? Datasets imported from it keep their rows but can't be refreshed.`)) return;
    await api.deleteConnection(c.id).catch((e) => setError(e.message));
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="mt-1 text-sm text-ink-2">
            Your own object storage and databases. Import datasets from them, and export run results to the ones you allow writes to.
          </p>
        </div>
        {owner && editing === null && (
          <Button className="ml-auto" onClick={() => setEditing("new")}>
            New connection
          </Button>
        )}
      </div>
      <ErrorNote error={error} />

      {editing !== null && (
        <Card title={editing === "new" ? "New connection" : `Edit ${editing.name}`}>
          <ConnectionForm
            key={editing === "new" ? "new" : editing.id}
            existing={editing === "new" ? undefined : editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              load();
            }}
          />
        </Card>
      )}

      <Card>
        {items === null ? (
          <Empty>Loading…</Empty>
        ) : items.length === 0 ? (
          <Empty>
            No connections yet.{" "}
            {owner ? "Add a Vultr Object Storage bucket or a Tiger Cloud database to import datasets from it." : "Ask an owner of your organization to add one."}
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/connections/${c.id}`} className="font-medium hover:text-accent">
                      {c.name}
                    </Link>
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-2">
                      {PROVIDER_LABEL[c.provider]} · {c.kind === "s3" ? "Object storage" : "Postgres"}
                    </span>
                    <AccessBadges access={c.access} allowWrite={c.allow_write} />
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-ink-2">{connectionTarget(c)}</div>
                  {c.access && (
                    <div className={`mt-0.5 text-xs ${c.access.read ? "text-muted" : "text-critical"}`}>
                      {c.access.detail} · checked {when(c.access.checked_at)}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted">
                    {c.dataset_count} dataset{c.dataset_count === 1 ? "" : "s"}
                  </span>
                  <Link href={`/connections/${c.id}`} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
                    {c.kind === "s3" ? "Browse files" : "Browse tables"}
                  </Link>
                  <Button variant="secondary" onClick={() => recheck(c)} disabled={checking === c.id}>
                    {checking === c.id ? "Checking…" : "Recheck"}
                  </Button>
                  {owner && (
                    <>
                      <Button variant="ghost" onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                      <Button variant="ghost" onClick={() => remove(c)}>
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
