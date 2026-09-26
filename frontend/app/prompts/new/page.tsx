"use client";

import { useRouter } from "next/navigation";
import { PromptEditor } from "@/components/PromptEditor";
import { Card } from "@/components/ui";

export default function NewPromptPage() {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">New prompt</h1>
      <Card>
        <PromptEditor onSaved={(p) => router.replace(`/prompts/${p.id}`)} />
      </Card>
    </div>
  );
}
