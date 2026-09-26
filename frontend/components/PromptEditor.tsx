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
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const templateVars = templateVariables(template);
  const variables = [...new Set([...templateVars, ...templateVariables(systemPrompt)])];
  // Changed text becomes a new version; a rename alone doesn't.
  const textChanged = !!prompt && (systemPrompt.trim() !== (prompt.system_prompt ?? "") || template !== prompt.template);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, system_prompt: systemPrompt || undefined, template, note: note.trim() || undefined };
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
      <Field label="System prompt" hint="Optional; sent as the system message. It can use {{variables}} that a profile sets to a Value or a Dataset">
        <textarea rows={6} className={inputClass} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="You are a precise assistant. Answer briefly." />
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
        {templateVars.length ? <VariableChips variables={variables} /> : <span className="text-critical">none in the template yet. Add at least one {"{{variable}}"}</span>}
      </div>
      {!template && (
        <button type="button" className="text-xs text-accent hover:underline" onClick={() => setTemplate(EXAMPLE)}>
          Use an example template
        </button>
      )}
      {(textChanged || !prompt) && (
        <Field label="What changed?" hint={prompt ? `Saved with v${prompt.current_version + 1}; optional` : "Optional note for v1"}>
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder={prompt ? "Stricter output format" : "First draft"} />
        </Field>
      )}
      <ErrorNote error={error} />
      {prompt && <p className="text-xs text-muted">Earlier versions stay as they are; profiles keep the text they were saved with.</p>}
      <Button type="submit" disabled={busy || !name.trim() || templateVars.length === 0 || (!!prompt && !textChanged && name.trim() === prompt.name)}>
        {busy ? "Saving…" : !prompt ? "Create prompt (v1)" : textChanged ? `Save as v${prompt.current_version + 1}` : "Save name"}
      </Button>
    </form>
  );
}
