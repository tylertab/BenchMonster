"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RunLauncher } from "@/components/RunLauncher";
import { RunsDashboard } from "@/components/RunsDashboard";
import { Button, Empty, ErrorNote } from "@/components/ui";
import { api, type Profile } from "@/lib/api";

export default function ProfileRunsPage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launch, setLaunch] = useState(false);

  useEffect(() => {
    api.profile(id).then(setProfile, (e) => setError(e.message));
  }, [id]);

  if (!profile) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Link href={`/profiles/${id}`} className="text-sm text-ink-2 hover:text-ink">
            ← {profile.name}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Runs · {profile.name}</h1>
        </div>
        <Button className="ml-auto" onClick={() => setLaunch(true)}>
          Create run (v{profile.current_version})
        </Button>
      </div>
      {launch && <RunLauncher profileId={profile.id} version={profile.current_version} isCurrent onCancel={() => setLaunch(false)} />}
      <Suspense>
        <RunsDashboard profile={{ id: profile.id, name: profile.name, current_version: profile.current_version }} />
      </Suspense>
    </div>
  );
}
