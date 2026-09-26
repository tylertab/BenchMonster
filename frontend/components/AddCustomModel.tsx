"use client";

import { useState } from "react";
import { api, type Model } from "@/lib/api";
import { Button, ErrorNote, Field, inputClass } from "./ui";

const EMPTY = { display_name: "", model_id: "", base_url: "", api_key: "", input_cost_per_mtok: "0", output_cost_per_mtok: "0" };

export function AddCustomModel({ onAdded }: { onAdded: (m: Model) => void }) {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const m = await api.addModel({
        ...form,
        api_key: form.api_key || undefined,
        input_cost_per_mtok: Number(form.input_cost_per_mtok) || 0,
        output_cost_per_mtok: Number(form.output_cost_per_mtok) || 0,
      });
      setForm(EMPTY);
      onAdded(m);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Display name">
        <input required className={inputClass} value={form.display_name} onChange={set("display_name")} placeholder="My fine-tuned Llama" />
      </Field>
      <Field label="Base URL" hint="OpenAI-compatible, e.g. http://1.2.3.4:8000/v1">
        <input required type="url" className={inputClass} value={form.base_url} onChange={set("base_url")} placeholder="https://…/v1" />
      </Field>
      <Field label="Model id">
        <input required className={inputClass} value={form.model_id} onChange={set("model_id")} placeholder="meta-llama/Llama-3.1-8B-Instruct" />
      </Field>
      <Field label="API key" hint="Optional; stored server-side only">
        <input type="password" className={inputClass} value={form.api_key} onChange={set("api_key")} autoComplete="off" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="$ / 1M input">
          <input type="number" step="any" min="0" className={inputClass} value={form.input_cost_per_mtok} onChange={set("input_cost_per_mtok")} />
        </Field>
        <Field label="$ / 1M output">
          <input type="number" step="any" min="0" className={inputClass} value={form.output_cost_per_mtok} onChange={set("output_cost_per_mtok")} />
        </Field>
      </div>
      <ErrorNote error={error} />
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? "Checking endpoint…" : "Test & add model"}
      </Button>
    </form>
  );
}
