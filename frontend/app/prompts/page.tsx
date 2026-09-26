"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TemplateView, VariableChips } from "@/components/TemplateView";
import { Card, Empty, ErrorNote } from "@/components/ui";
import { api, type Prompt } from "@/lib/api";
import { when } from "@/lib/format";

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.prompts().then(setPrompts, (e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Prompts</h1>
          <p className="mt-1 text-sm text-ink-2">Reusable templates. Each {"{{variable}}"} is filled from a dataset field when you run it.</p>
        </div>
        <Link href="/prompts/new" className="ml-auto rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
          New prompt
        </Link>
      </div>
      <ErrorNote error={error} />
      {prompts === null ? (
        <Empty>Loading…</Empty>
      ) : prompts.length === 0 ? (
        <Card>
          <Empty>
            No prompts yet.{" "}
            <Link href="/prompts/new" className="text-accent underline">
              Create one
            </Link>
            .
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {prompts.map((p) => (
            <Link key={p.id} href={`/prompts/${p.id}`} className="block rounded-lg border border-line bg-surface p-4 hover:border-accent/50">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
              </div>
              <div className="mt-2 rounded-md bg-surface-2/60 p-2 text-ink-2">
                <TemplateView template={p.template} clamp />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <VariableChips variables={p.variables} />
                <span className="ml-auto text-xs text-muted">edited {when(p.updated_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
