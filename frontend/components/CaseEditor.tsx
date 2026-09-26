"use client";

import { useState } from "react";
import { Button } from "./ui";

export type Case = { input: string; expected: string | null };

const PAGE = 25;

/** Editable list of benchmark cases, paged so large datasets stay responsive. */
export function CaseEditor({ cases, onChange }: { cases: Case[]; onChange: (c: Case[]) => void }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(cases.length / PAGE));
  const current = Math.min(page, pages - 1);
  const start = current * PAGE;

  const update = (i: number, patch: Partial<Case>) => onChange(cases.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const remove = (i: number) => onChange(cases.filter((_, j) => j !== i));
  const add = () => {
    onChange([...cases, { input: "", expected: "" }]);
    setPage(Math.floor(cases.length / PAGE));
  };

  const cell = "w-full resize-y rounded border border-transparent bg-transparent px-1.5 py-1 text-xs outline-none hover:border-line focus:border-accent focus:bg-surface";

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-xs">
          <thead className="bg-surface-2 text-left text-muted">
            <tr>
              <th className="w-10 px-2 py-1.5 font-medium">#</th>
              <th className="px-2 py-1.5 font-medium">input</th>
              <th className="w-1/3 px-2 py-1.5 font-medium">expected</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {cases.slice(start, start + PAGE).map((c, k) => {
              const i = start + k;
              return (
                <tr key={i} className="border-t border-line align-top">
                  <td className="tabular px-2 py-1.5 text-muted">{i}</td>
                  <td className="px-1 py-0.5">
                    <textarea rows={Math.min(4, Math.max(1, Math.ceil(c.input.length / 70)))} className={cell} value={c.input} onChange={(e) => update(i, { input: e.target.value })} aria-label={`Case ${i} input`} />
                  </td>
                  <td className="px-1 py-0.5">
                    <textarea rows={1} className={`${cell} text-ink-2`} value={c.expected ?? ""} onChange={(e) => update(i, { expected: e.target.value })} aria-label={`Case ${i} expected`} />
                  </td>
                  <td className="px-1 py-1">
                    <button type="button" onClick={() => remove(i)} className="px-1 text-muted hover:text-critical" aria-label={`Delete case ${i}`}>
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <Button type="button" variant="secondary" onClick={add}>
          + Add case
        </Button>
        <span>{cases.length} cases</span>
        {pages > 1 && (
          <span className="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
              ←
            </Button>
            page {current + 1} / {pages}
            <Button type="button" variant="ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              →
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
