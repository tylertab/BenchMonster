"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ProfileEditor } from "@/components/ProfileEditor";
import { Empty, ErrorNote } from "@/components/ui";
import { api, ApiError, type Profile, type ProfileVersion, versionToConfig } from "@/lib/api";

function EditProfile() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  // ?from=N starts the editor from an older version (it still saves as a new version).
  const from = Number(useSearchParams().get("from")) || null;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [base, setBase] = useState<ProfileVersion | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.profile(id).then(
      (p) => {
        setProfile(p);
        if (!from || from === p.current_version) setBase(p.current);
        else api.profileVersion(id, from).then(setBase, (e) => setError(e.message));
      },
      (e) => setError(e.message),
    );
  }, [id, from]);

  if (!profile || !base) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;
  const fromOld = base.version !== profile.current_version;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href={`/profiles/${id}`} className="text-sm text-ink-2 hover:text-ink">
          ← {profile.name}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Edit {profile.name}</h1>
        <p className="mt-1 text-sm text-ink-2">
          {fromOld ? (
            <>
              Starting from <strong>v{base.version}</strong> (the current version is v{profile.current_version}). Saving creates v{profile.current_version + 1}; earlier versions,
              including v{base.version}, never change.
            </>
          ) : (
            <>
              Editing v{profile.current_version}. Saving creates v{profile.current_version + 1}; earlier versions never change, and their runs keep pointing at them.
            </>
          )}
        </p>
      </div>
      <ProfileEditor
        mode="edit"
        key={base.version}
        initial={{ name: profile.name, description: profile.description, config: versionToConfig(base), currentVersion: profile.current_version }}
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

export default function EditProfilePage() {
  return (
    <Suspense>
      <EditProfile />
    </Suspense>
  );
}
