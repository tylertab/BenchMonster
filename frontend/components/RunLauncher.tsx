"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button, ErrorNote, Field, inputClass } from "./ui";

/** "Create run" for a profile version, with optional run name and predictions file name. */
export function RunLauncher({ profileId, version, isCurrent, onCancel }: { profileId: number; version: number; isCurrent: boolean; onCancel?: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.runProfile(profileId, { version, name: name.trim() || undefined, output_name: output.trim() || undefined });
      router.push(`/runs/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={start} className="space-y-3 rounded-lg border border-accent/40 bg-accent/5 p-4">
      <div className="text-sm font-medium">
        Create a run of v{version}
        {isCurrent ? " (current)" : ""}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Run name" hint="Optional">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Baseline" />
        </Field>
        <Field label="Predictions file name" hint="Optional; generated from the profile and time">
          <input className={`${inputClass} font-mono`} value={output} onChange={(e) => setOutput(e.target.value)} placeholder="…-predictions.csv" />
        </Field>
      </div>
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Starting…" : "Start run"}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
