"use client";

import { Suspense } from "react";
import { RunsDashboard } from "@/components/RunsDashboard";

export default function RunsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <p className="mt-1 text-sm text-ink-2">Every run across your benchmark profiles, newest first.</p>
      </div>
      <Suspense>
        <RunsDashboard />
      </Suspense>
    </div>
  );
}
