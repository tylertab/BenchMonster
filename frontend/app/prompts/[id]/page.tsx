"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PromptEditor } from "@/components/PromptEditor";
import { Button, Card, Empty, ErrorNote } from "@/components/ui";
import { api, type Prompt } from "@/lib/api";

export default function PromptPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.prompt(id).then(setPrompt, (e) => setError(e.message));
  }, [id]);

  const remove = async () => {
    if (!prompt || !window.confirm(`Delete prompt "${prompt.name}"? Past runs keep their copy of the template.`)) return;
    await api.deletePrompt(prompt.id);
    router.replace("/prompts");
  };

  if (!prompt) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-end gap-3">
        <div>
          <Link href="/prompts" className="text-sm text-ink-2 hover:text-ink">
            ← Prompts
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{prompt.name}</h1>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={remove}>
            Delete
          </Button>
          <Link href={`/profiles/new?prompt=${prompt.id}`} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
            Use in a new profile →
          </Link>
        </div>
      </div>
      <Card title="Edit">
        <PromptEditor key={prompt.updated_at} prompt={prompt} onSaved={setPrompt} />
      </Card>
    </div>
  );
}
