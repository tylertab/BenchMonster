"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ProfileEditor } from "@/components/ProfileEditor";
import { Empty, ErrorNote } from "@/components/ui";
import { api, ApiError, type Profile, versionToConfig } from "@/lib/api";

export default function EditProfilePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.profile(id).then(setProfile, (e) => setError(e.message));
  }, [id]);

  if (!profile) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href={`/profiles/${id}`} className="text-sm text-ink-2 hover:text-ink">
          ← {profile.name}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Edit {profile.name}</h1>
        <p className="mt-1 text-sm text-ink-2">
          Editing v{profile.current_version}. Saving creates v{profile.current_version + 1}; runs of earlier versions keep pointing at them.
        </p>
      </div>
      <ProfileEditor
        mode="edit"
        initial={{ name: profile.name, description: profile.description, config: versionToConfig(profile.current), currentVersion: profile.current_version }}
        onSubmit={async (d) => {
          const metaChanged = d.name !== profile.name || (d.description || null) !== (profile.description || null);
          if (metaChanged) await api.updateProfileMeta(profile.id, { name: d.name, description: d.description || null });
          try {
            await api.saveVersion(profile.id, d.config);
          } catch (e) {
            // Renaming alone doesn't create a version.
            if (!(metaChanged && e instanceof ApiError && e.status === 400 && e.message.startsWith("nothing changed"))) throw e;
          }
          router.push(`/profiles/${id}`);
        }}
      />
    </div>
  );
}
