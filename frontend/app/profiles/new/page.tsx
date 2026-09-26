"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ProfileEditor } from "@/components/ProfileEditor";
import { api } from "@/lib/api";

function NewProfile() {
  const router = useRouter();
  const params = useSearchParams();
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New benchmark profile</h1>
        <p className="mt-1 text-sm text-ink-2">Define the prompt, input sets, and output expectations once, then run it and iterate. Every edit becomes a new version.</p>
      </div>
      <ProfileEditor
        mode="create"
        prefill={{ promptId: Number(params.get("prompt")) || undefined, datasetId: Number(params.get("dataset")) || undefined }}
        onSubmit={async (d) => {
          const p = await api.createProfile({ name: d.name, description: d.description || undefined, config: d.config });
          router.push(`/profiles/${p.id}`);
        }}
      />
    </div>
  );
}

export default function NewProfilePage() {
  return (
    <Suspense>
      <NewProfile />
    </Suspense>
  );
}
