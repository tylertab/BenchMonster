"use client";

import { useEffect, useState } from "react";
import { api, type Model } from "@/lib/api";
import { num } from "@/lib/format";
import { AddCustomModel } from "./AddCustomModel";
import { Button, Empty, Field, inputClass } from "./ui";

export type RunParams = { max_tokens: number; temperature: number; concurrency: number };
export const DEFAULT_PARAMS: RunParams = { max_tokens: 4096, temperature: 0, concurrency: 8 };

export function ModelPicker({
  selected,
  onChange,
  params,
  onParamsChange,
}: {
  selected: number[];
  onChange: (ids: number[]) => void;
  params: RunParams;
  onParamsChange: (p: RunParams) => void;
}) {
  const [models, setModels] = useState<Model[] | null>(null);
  const [filter, setFilter] = useState("");
  const [showCustom, setShowCustom] = useState(false);

  useEffect(() => {
    api.models().then(setModels);
  }, []);

  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const shown = (models ?? []).filter((m) => `${m.display_name} ${m.model_id}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input className={inputClass} placeholder="Filter models…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="whitespace-nowrap text-sm text-ink-2">{selected.length} selected</span>
        <Button type="button" variant="secondary" onClick={() => setShowCustom(!showCustom)} className="whitespace-nowrap">
          {showCustom ? "Close" : "+ Custom model"}
        </Button>
      </div>

      {showCustom && (
        <div className="rounded-md border border-line bg-surface-2/50 p-4">
          <AddCustomModel
            onAdded={(m) => {
              setModels((prev) => [m, ...(prev ?? [])]);
              onChange([...selected, m.id]);
              setShowCustom(false);
            }}
          />
        </div>
      )}

      {models === null ? (
        <Empty>Loading models…</Empty>
      ) : (
        <div className="grid max-h-96 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((m) => {
            const on = selected.includes(m.id);
            return (
              <label
                key={m.id}
                className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-sm transition-colors ${
                  on ? "border-accent bg-accent/5" : "border-line hover:bg-surface-2"
                }`}
              >
                <input type="checkbox" checked={on} onChange={() => toggle(m.id)} className="mt-0.5 accent-[var(--accent)]" />
                <span className="min-w-0">
                  <span className="block font-medium">
                    {m.display_name}
                    {m.is_custom && <span className="ml-1.5 rounded bg-surface-2 px-1 text-xs text-ink-2">custom</span>}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted">{m.model_id}</span>
                  <span className="tabular block text-xs text-ink-2">
                    ${num(m.input_cost_per_mtok, 2)} in · ${num(m.output_cost_per_mtok, 2)} out / 1M
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Field label="Max tokens" hint="Reasoning models think first; keep this generous">
          <input
            type="number"
            min={16}
            max={32768}
            className={inputClass}
            value={params.max_tokens}
            onChange={(e) => onParamsChange({ ...params, max_tokens: Number(e.target.value) })}
          />
        </Field>
        <Field label="Temperature">
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            className={inputClass}
            value={params.temperature}
            onChange={(e) => onParamsChange({ ...params, temperature: Number(e.target.value) })}
          />
        </Field>
        <Field label="Concurrency / model">
          <input
            type="number"
            min={1}
            max={32}
            className={inputClass}
            value={params.concurrency}
            onChange={(e) => onParamsChange({ ...params, concurrency: Number(e.target.value) })}
          />
        </Field>
      </div>
    </div>
  );
}
