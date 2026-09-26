"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ProfileConfigView } from "@/components/ProfileConfigView";
import { RunLauncher } from "@/components/RunLauncher";
import { Button, Card, Empty, ErrorNote } from "@/components/ui";
import { api, type Profile, type ProfileSection, type ProfileVersion } from "@/lib/api";
import { when } from "@/lib/format";

const SECTION_LABEL: Record<ProfileSection, string> = { prompt: "prompt", inputs: "inputs", scoring: "scoring", models: "models", params: "params" };

function ProfileView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [viewed, setViewed] = useState<ProfileVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launch, setLaunch] = useState(false);


  const requested = Number(params.get("version")) || null;

  useEffect(() => {
    api.profile(id).then(setProfile, (e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (!profile || !requested || requested === profile.current_version) return;
    api.profileVersion(id, requested).then(setViewed, (e) => setError(e.message));
  }, [id, profile, requested]);

  if (!profile) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;

  const isCurrent = !requested || requested === profile.current_version;
  const v = isCurrent ? profile.current : viewed?.version === requested ? viewed : null;
  const showVersion = (n: number) => {
    setLaunch(false);
    router.replace(n === profile.current_version ? `/profiles/${id}` : `/profiles/${id}?version=${n}`);
  };

  const restore = async () => {
    if (!v || !window.confirm(`Restore v${v.version} as the new current version (v${profile.current_version + 1})?`)) return;
    try {
      await api.restoreVersion(profile.id, v.version);
      setProfile(await api.profile(id));
      router.replace(`/profiles/${id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${profile.name}" and its version history? Its runs are kept.`)) return;
    await api.deleteProfile(profile.id);
    router.replace("/");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <Link href="/" className="text-sm text-ink-2 hover:text-ink">
            ← Benchmark profiles
          </Link>
          <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold tracking-tight">
            {profile.name}
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-sm font-medium text-accent">v{v?.version ?? requested}</span>
          </h1>
          {profile.description && <p className="mt-1 text-sm text-ink-2">{profile.description}</p>}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Link href={`/profiles/${id}/runs`} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
            Runs ({profile.versions.reduce((a, x) => a + x.run_count, 0)})
          </Link>
          <Link href={`/profiles/${id}/edit`} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
            Edit
          </Link>
          <Link href={`/bmquery?profile=${id}`} className="rounded-md border border-accent/50 bg-accent/5 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/10">
            Analyze this benchmark with BMQuery
          </Link>
          <Button onClick={() => setLaunch(true)} disabled={!v}>
            Run v{v?.version ?? requested}
          </Button>
        </div>
      </div>

      {!isCurrent && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <span>
            Viewing <strong>v{requested}</strong>. The current version is v{profile.current_version}.
          </span>
          <span className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={restore} disabled={!v}>
              Restore as v{profile.current_version + 1}
            </Button>
            <Button variant="ghost" onClick={() => showVersion(profile.current_version)}>
              Back to current
            </Button>
          </span>
        </div>
      )}

      {launch && v && <RunLauncher profileId={profile.id} version={v.version} isCurrent={isCurrent} onCancel={() => setLaunch(false)} />}
      <ErrorNote error={error} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        {v ? <ProfileConfigView v={v} /> : <Empty>Loading version…</Empty>}

        <Card title="Version history">
          <ol className="space-y-1">
            {profile.versions.map((ver) => {
              const selected = ver.version === (v?.version ?? requested);
              return (
                <li key={ver.version}>
                  <button
                    type="button"
                    onClick={() => showVersion(ver.version)}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${selected ? "bg-accent/10" : "hover:bg-surface-2"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`font-medium ${selected ? "text-accent" : ""}`}>v{ver.version}</span>
                      {ver.version === profile.current_version && <span className="rounded bg-good/10 px-1.5 text-xs text-good-ink">current</span>}
                      <span className="ml-auto text-xs text-muted">
                        {ver.run_count} run{ver.run_count === 1 ? "" : "s"}
                      </span>
                    </div>
                    {ver.note && <div className="truncate text-xs text-ink-2">{ver.note}</div>}
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
                      {ver.changed.map((c) => (
                        <span key={c} className="rounded bg-surface-2 px-1">
                          {SECTION_LABEL[c]}
                        </span>
                      ))}
                      <span>
                        {when(ver.created_at)}
                        {ver.created_by ? ` · ${ver.created_by}` : ""}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="mt-3 border-t border-line pt-3">
            <Button variant="ghost" onClick={remove} className="text-critical">
              Delete profile
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <Suspense>
      <ProfileView />
    </Suspense>
  );
}
