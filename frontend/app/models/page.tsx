"use client";

import { useEffect, useState } from "react";
import { AddCustomModel } from "@/components/AddCustomModel";
import { Button, Card, Empty, ErrorNote } from "@/components/ui";
import { api, type Model } from "@/lib/api";
import { num } from "@/lib/format";

export default function ModelsPage() {
  const [models, setModels] = useState<Model[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = () => api.models().then(setModels, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const sync = async () => {
    setSyncing(true);
    try {
      await api.syncModels();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const remove = async (id: number) => {
    await api.removeModel(id);
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
        <p className="mt-1 text-sm text-ink-2">
          Vultr Serverless Inference models sync automatically with live prices. Add your own model behind any
          OpenAI-compatible endpoint (vLLM, Ollama, a Vultr GPU…).
        </p>
      </div>
      <ErrorNote error={error} />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card
          title="Available models"
          actions={
            <Button variant="secondary" onClick={sync} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync Vultr catalog"}
            </Button>
          }
        >
          {models === null ? (
            <Empty>Loading…</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium">Source</th>
                  <th className="pb-2 text-right font-medium">$ / 1M in</th>
                  <th className="pb-2 text-right font-medium">$ / 1M out</th>
                  <th className="pb-2 text-right font-medium">Context</th>
                  <th />
                </tr>
              </thead>
              <tbody className="tabular">
                {models.map((m) => (
                  <tr key={m.id} className="border-t border-line">
                    <td className="py-2">
                      <div className="font-medium">{m.display_name}</div>
                      <div className="font-mono text-xs text-muted">{m.model_id}</div>
                    </td>
                    <td className="py-2 text-ink-2">{m.is_custom ? "Custom endpoint" : "Vultr"}</td>
                    <td className="py-2 text-right">{num(m.input_cost_per_mtok, 3)}</td>
                    <td className="py-2 text-right">{num(m.output_cost_per_mtok, 3)}</td>
                    <td className="py-2 text-right text-ink-2">
                      {m.context_length ? `${Math.round(m.context_length / 1024)}k` : "–"}
                    </td>
                    <td className="py-2 text-right">
                      {m.is_custom && (
                        <Button variant="ghost" onClick={() => remove(m.id)} aria-label={`Remove ${m.display_name}`}>
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Add a custom model">
          <AddCustomModel onAdded={load} />
        </Card>
      </div>
    </div>
  );
}
