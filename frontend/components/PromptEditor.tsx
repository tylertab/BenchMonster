"use client";

import { useState } from "react";
import { api, type Prompt } from "@/lib/api";
import { templateVariables } from "@/lib/template";
import { VariableChips } from "./TemplateView";
import { Button, ErrorNote, Field, inputClass } from "./ui";

const EXAMPLE = "Answer the question using only the context.\n\nContext:\n{{context}}\n\nQuestion: {{question}}";

export function PromptEditor({ prompt, onSaved }: { prompt?: Prompt; onSaved: (p: Prompt) => void }) {
  const [name, setName] = useState(prompt?.name ?? "");
  const [systemPrompt, setSystemPrompt] = useState(prompt?.system_prompt ?? "");
  const [template, setTemplate] = useState(prompt?.template ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const variables = templateVariables(template);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, system_prompt: systemPrompt || undefined, template };
      onSaved(prompt ? await api.updatePrompt(prompt.id, body) : await api.createPrompt(body));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <Field label="Name">
        <input required className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Grounded QA" />
      </Field>
      <Field label="System prompt" hint="Optional; sent before every input">
        <textarea rows={2} className={inputClass} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="You are a precise assistant. Answer briefly." />
      </Field>
      <Field
        label="Template"
        hint={
          <>
            Use <code>{"{{variable}}"}</code> placeholders; each maps to a dataset field when you start a run. Single braces are left alone, so JSON is fine.
          </>
        }
      >
        <textarea required rows={9} className={`${inputClass} font-mono text-xs`} value={template} onChange={(e) => setTemplate(e.target.value)} placeholder={EXAMPLE} />
      </Field>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-ink-2">Variables:</span>
        {variables.length ? <VariableChips variables={variables} /> : <span className="text-critical">none yet. Add at least one {"{{variable}}"}</span>}
      </div>
      {!template && (
        <button type="button" className="text-xs text-accent hover:underline" onClick={() => setTemplate(EXAMPLE)}>
          Use an example template
        </button>
      )}
      <ErrorNote error={error} />
      {prompt && prompt.run_count > 0 && <p className="text-xs text-muted">Past runs keep the template they used; changes apply to new runs.</p>}
      <Button type="submit" disabled={busy || !name.trim() || variables.length === 0}>
        {busy ? "Saving…" : prompt ? "Save changes" : "Create prompt"}
      </Button>
    </form>
  );
}
