"use client";

import { useState } from "react";
import { api, type Connection, type ConnectionAccess, type ConnectionIn, type ConnectionKind, type ConnectionProvider, type PgConfig, type S3Config } from "@/lib/api";
import { when } from "@/lib/format";
import { Button, ErrorNote, Field, inputClass } from "./ui";

type Preset = { provider: ConnectionProvider; kind: ConnectionKind; label: string; hint: string };
export const PRESETS: Preset[] = [
  { provider: "vultr", kind: "s3", label: "Vultr Object Storage", hint: "S3-compatible buckets" },
  { provider: "tiger", kind: "postgres", label: "Tiger Cloud", hint: "Postgres / TimescaleDB" },
  { provider: "aws", kind: "s3", label: "AWS S3", hint: "or any S3-compatible storage" },
  { provider: "other", kind: "postgres", label: "Other Postgres", hint: "Supabase, RDS, Neon…" },
];
export const PROVIDER_LABEL: Record<ConnectionProvider, string> = { vultr: "Vultr", tiger: "Tiger Cloud", aws: "AWS", other: "Other" };
const VULTR_REGIONS = ["ewr1", "sjc1", "ams1", "sgp1", "blr1", "del1"];

const defaults = (p: Preset): S3Config | PgConfig =>
  p.kind === "s3"
    ? { endpoint: p.provider === "vultr" ? "https://ewr1.vultrobjects.com" : p.provider === "aws" ? "https://s3.us-east-1.amazonaws.com" : "", region: "us-east-1", bucket: "", prefix: "" }
    : { host: "", port: 5432, database: p.provider === "tiger" ? "tsdb" : "postgres", user: p.provider === "tiger" ? "tsdbadmin" : "", sslmode: "require", schema: "public" };

/** "bucket/folder · endpoint" or "user@host:port/db". */
export function connectionTarget(c: Connection): string {
  if (c.kind === "s3") {
    const s = c.config as S3Config;
    return `${s.bucket}${s.prefix ? `/${s.prefix.replace(/^\/|\/$/g, "")}` : ""} · ${s.endpoint.replace(/^https?:\/\//, "")}`;
  }
  const p = c.config as PgConfig;
  return `${p.user}@${p.host}:${p.port}/${p.database}`;
}

/** Read / Write badges for a connection's last access check. */
export function AccessBadges({ access, allowWrite }: { access: ConnectionAccess | null; allowWrite: boolean }) {
  if (!access) return <span className="text-xs text-muted">not checked</span>;
  const badge = (ok: boolean | null, label: string, off?: string) => (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${ok === true ? "bg-good/15 text-good-ink" : ok === false ? "bg-critical/10 text-critical" : "bg-surface-2 text-muted"}`}
      title={off}
    >
      {ok === true ? "✓" : ok === false ? "✕" : "–"} {label}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5">
      {badge(access.read, "Read")}
      {allowWrite ? badge(access.write, "Write") : badge(null, "Read only", "Set as read-only: BenchMonster never writes here")}
    </span>
  );
}

export function ConnectionForm({ existing, onSaved, onCancel }: { existing?: Connection; onSaved: (c: Connection) => void; onCancel: () => void }) {
  const [preset, setPreset] = useState<Preset>(
    existing ? PRESETS.find((p) => p.provider === existing.provider && p.kind === existing.kind) ?? { ...PRESETS[existing.kind === "s3" ? 2 : 3], provider: existing.provider } : PRESETS[0],
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [config, setConfig] = useState<S3Config | PgConfig>(existing?.config ?? defaults(PRESETS[0]));
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [allowWrite, setAllowWrite] = useState(existing?.allow_write ?? false);
  const [test, setTest] = useState<ConnectionAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const kind = preset.kind;
  const s3 = config as S3Config;
  const pg = config as PgConfig;
  const set = (patch: Partial<S3Config> | Partial<PgConfig>) => {
    setConfig({ ...config, ...patch } as S3Config | PgConfig);
    setTest(null);
  };
  const hasSecret = kind === "s3" ? !!(secret.access_key && secret.secret_key) : !!secret.password;
  const body = (): ConnectionIn => ({ name: name.trim(), kind, provider: preset.provider, config, secret: hasSecret ? secret : null, allow_write: allowWrite });

  const run = async (what: "test" | "save") => {
    setBusy(what);
    setError(null);
    try {
      if (what === "test") setTest(await api.testConnection(body()));
      else onSaved(existing ? await api.updateConnection(existing.id, body()) : await api.createConnection(body()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {!existing && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setPreset(p);
                setConfig(defaults(p));
                setSecret({});
                setTest(null);
              }}
              className={`rounded-md border px-3 py-2 text-left text-sm ${preset.label === p.label ? "border-accent bg-accent/5" : "border-line hover:bg-surface-2"}`}
            >
              <div className="font-medium">{p.label}</div>
              <div className="text-xs text-muted">{p.hint}</div>
            </button>
          ))}
        </div>
      )}

      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "s3" ? "Benchmark data bucket" : "Analytics warehouse"} />
      </Field>

      {kind === "s3" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {preset.provider === "vultr" ? (
            <Field label="Region" hint="Shown on the bucket's page in the Vultr console">
              <select
                className={inputClass}
                value={VULTR_REGIONS.find((r) => s3.endpoint === `https://${r}.vultrobjects.com`) ?? ""}
                onChange={(e) => set({ endpoint: `https://${e.target.value}.vultrobjects.com` })}
              >
                {!VULTR_REGIONS.some((r) => s3.endpoint === `https://${r}.vultrobjects.com`) && <option value="">{s3.endpoint || "choose"}</option>}
                {VULTR_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}.vultrobjects.com
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Endpoint URL">
              <input className={`${inputClass} font-mono text-xs`} value={s3.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://s3.us-east-1.amazonaws.com" />
            </Field>
          )}
          <Field label="Bucket">
            <input className={`${inputClass} font-mono text-xs`} value={s3.bucket} onChange={(e) => set({ bucket: e.target.value })} placeholder="my-bucket" />
          </Field>
          {preset.provider !== "vultr" && (
            <Field label="Region">
              <input className={inputClass} value={s3.region} onChange={(e) => set({ region: e.target.value })} />
            </Field>
          )}
          <Field label="Folder" hint="Optional; BenchMonster only sees files under it">
            <input className={`${inputClass} font-mono text-xs`} value={s3.prefix} onChange={(e) => set({ prefix: e.target.value })} placeholder="benchmarks/" />
          </Field>
          <Field label="Access key">
            <input className={`${inputClass} font-mono text-xs`} value={secret.access_key ?? ""} onChange={(e) => setSecret({ ...secret, access_key: e.target.value })} placeholder={existing ? "saved (leave blank to keep)" : ""} autoComplete="off" />
          </Field>
          <Field label="Secret key">
            <input type="password" className={`${inputClass} font-mono text-xs`} value={secret.secret_key ?? ""} onChange={(e) => setSecret({ ...secret, secret_key: e.target.value })} placeholder={existing ? "saved (leave blank to keep)" : ""} autoComplete="new-password" />
          </Field>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
          <Field label="Host" hint={preset.provider === "tiger" ? "From the service's connection info in Tiger Cloud" : undefined}>
            <input className={`${inputClass} font-mono text-xs`} value={pg.host} onChange={(e) => set({ host: e.target.value })} placeholder={preset.provider === "tiger" ? "abc123.xyz.tsdb.cloud.timescale.com" : "db.example.com"} />
          </Field>
          <Field label="Port">
            <input type="number" className={inputClass} value={pg.port} onChange={(e) => set({ port: Number(e.target.value) || 5432 })} />
          </Field>
          <Field label="Database">
            <input className={`${inputClass} font-mono text-xs`} value={pg.database} onChange={(e) => set({ database: e.target.value })} />
          </Field>
          <Field label="SSL">
            <select className={inputClass} value={pg.sslmode} onChange={(e) => set({ sslmode: e.target.value as PgConfig["sslmode"] })}>
              <option value="require">require</option>
              <option value="verify-full">verify-full</option>
              <option value="prefer">prefer</option>
              <option value="disable">disable</option>
            </select>
          </Field>
          <Field label="User" hint="A read-only role is safest unless you export results here">
            <input className={`${inputClass} font-mono text-xs`} value={pg.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Schema" hint="For exported tables">
            <input className={`${inputClass} font-mono text-xs`} value={pg.schema} onChange={(e) => set({ schema: e.target.value })} />
          </Field>
          <Field label="Password">
            <input type="password" className={`${inputClass} font-mono text-xs`} value={secret.password ?? ""} onChange={(e) => setSecret({ password: e.target.value })} placeholder={existing ? "saved (leave blank to keep)" : ""} autoComplete="new-password" />
          </Field>
        </div>
      )}

      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-sm font-medium">Access</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" className="mt-1" checked={!allowWrite} onChange={() => {
              setAllowWrite(false);
              setTest(null);
            }} />
          <span>
            <strong className="font-medium">Read only</strong>
            <span className="block text-xs text-ink-2">Import datasets from it. BenchMonster never writes here.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" className="mt-1" checked={allowWrite} onChange={() => {
              setAllowWrite(true);
              setTest(null);
            }} />
          <span>
            <strong className="font-medium">Read and write</strong>
            <span className="block text-xs text-ink-2">Also export run results here ({kind === "s3" ? "files in the bucket" : "tables in the schema"}). The check confirms the credentials really can write.</span>
          </span>
        </label>
      </fieldset>

      {test && (
        <div className={`rounded-md border px-3 py-2 text-sm ${test.read && (test.write !== false) ? "border-good/30 bg-good/10" : "border-critical/30 bg-critical/10"}`}>
          <div className="mb-1">
            <AccessBadges access={test} allowWrite={allowWrite} />
          </div>
          <div className="text-xs text-ink-2">{test.detail}</div>
        </div>
      )}
      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" onClick={() => run("test")} disabled={busy !== null || !hasSecret} title={hasSecret ? undefined : "Enter the credentials to test"}>
          {busy === "test" ? "Testing…" : "Test connection"}
        </Button>
        <Button type="button" onClick={() => run("save")} disabled={busy !== null || !name.trim() || (!existing && !hasSecret)}>
          {busy === "save" ? "Checking & saving…" : existing ? "Save changes" : "Save connection"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {existing?.access && <span className="ml-auto text-xs text-muted">last checked {when(existing.access.checked_at)}</span>}
      </div>
      <p className="text-xs text-muted">Credentials are encrypted before they&apos;re stored and are never shown again.</p>
    </div>
  );
}

