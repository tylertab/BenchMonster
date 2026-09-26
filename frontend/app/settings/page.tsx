"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Button, Card, Empty, ErrorNote, Field, inputClass } from "@/components/ui";
import { api, type OrgDetails, type Role } from "@/lib/api";
import { when } from "@/lib/format";

function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${role === "owner" ? "bg-accent/10 text-accent" : "bg-surface-2 text-ink-2"}`}>
      {role}
    </span>
  );
}

export default function SettingsPage() {
  const { me, refresh } = useAuth();
  const router = useRouter();
  const [org, setOrg] = useState<OrgDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("admin");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [memories, setMemories] = useState<{ id: string; content: string }[] | null>(null);

  const load = useCallback(
    () =>
      api.org().then(
        (o) => {
          setOrg(o);
          setName(o.name);
        },
        (e) => setError(e.message),
      ),
    [],
  );

  useEffect(() => {
    load();
    api.memories().then(setMemories, () => setMemories([]));
  }, [load, me?.org?.id]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!org) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;
  const owner = org.role === "owner";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Organization settings</h1>
        <p className="mt-1 text-sm text-ink-2">
          Benchmarks, runs, custom models, saved queries, and the analyst&apos;s memory are shared by everyone in{" "}
          <strong className="text-ink">{org.name}</strong>. You are {owner ? "an owner" : "an admin"}.
        </p>
      </div>
      <ErrorNote error={error} />

      <Card title="General">
        <form
          className="flex items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              await api.renameOrg(name);
              await refresh();
            });
          }}
        >
          <div className="flex-1">
            <Field label="Organization name">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} disabled={!owner} />
            </Field>
          </div>
          {owner && (
            <Button type="submit" disabled={!name.trim() || name === org.name}>
              Save
            </Button>
          )}
        </form>
      </Card>

      <Card title={`Members (${org.members.length})`}>
        <ul className="divide-y divide-line">
          {org.members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {m.name} {m.id === me?.user.id && <span className="text-xs text-muted">(you)</span>}
                </div>
                <div className="text-xs text-muted">{m.email}</div>
              </div>
              {owner ? (
                <select
                  className={`${inputClass} w-auto`}
                  value={m.role}
                  onChange={(e) => act(() => api.setRole(m.id, e.target.value as Role))}
                  aria-label={`Role for ${m.name}`}
                >
                  <option value="owner">Owner</option>
                  <option value="admin">Admin</option>
                </select>
              ) : (
                <RoleBadge role={m.role} />
              )}
              {(owner || m.id === me?.user.id) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    const self = m.id === me?.user.id;
                    if (window.confirm(self ? `Leave ${org.name}?` : `Remove ${m.name} from ${org.name}?`))
                      act(async () => {
                        await api.removeMember(m.id);
                        if (self) {
                          await refresh();
                          router.push("/");
                        }
                      });
                  }}
                >
                  {m.id === me?.user.id ? "Leave" : "Remove"}
                </Button>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">Owners manage members and settings. Admins can create and run benchmarks, query results, and use the analyst.</p>
      </Card>

      {owner && (
        <Card title="Invite a member">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => {
                const r = await api.invite(inviteEmail, inviteRole);
                setInviteLink(r.url);
                setInviteEmail("");
              });
            }}
          >
            <div className="min-w-60 flex-1">
              <Field label="Email">
                <input type="email" required className={inputClass} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
              </Field>
            </div>
            <Field label="Role">
              <select className={inputClass} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </select>
            </Field>
            <Button type="submit">Create invite link</Button>
          </form>
          {inviteLink && (
            <div className="mt-3 rounded-md border border-accent/30 bg-accent/5 p-3 text-sm">
              <div className="mb-1 font-medium">Share this link. It&apos;s shown once and expires in 7 days.</div>
              <div className="flex gap-2">
                <input readOnly value={inviteLink} className={`${inputClass} font-mono text-xs`} onFocus={(e) => e.target.select()} />
                <Button type="button" variant="secondary" onClick={() => navigator.clipboard.writeText(inviteLink)}>
                  Copy
                </Button>
              </div>
            </div>
          )}
          {org.invitations.length > 0 && (
            <ul className="mt-4 divide-y divide-line border-t border-line text-sm">
              {org.invitations.map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-2">
                  <span className="flex-1">{i.email}</span>
                  <RoleBadge role={i.role} />
                  <span className="text-xs text-muted">expires {when(i.expires_at)}</span>
                  <Button variant="ghost" onClick={() => act(() => api.revokeInvite(i.id))}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="Analyst memory" actions={<span className="text-xs text-muted">shared by this organization · Backboard</span>}>
        {memories === null ? (
          <Empty>Loading…</Empty>
        ) : memories.length === 0 ? (
          <Empty>Nothing remembered yet. The analyst saves findings as you review runs.</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {memories.map((m) => (
              <li key={m.id} className="flex items-start gap-3 py-2">
                <span className="flex-1">🧠 {m.content}</span>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await api.forget(m.id);
                    setMemories((ms) => ms?.filter((x) => x.id !== m.id) ?? null);
                  }}
                >
                  Forget
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
