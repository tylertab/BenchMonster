"use client";

import { useRef, useState, type ReactNode } from "react";

// Mark specs (dataviz reference): bars <= 24px with a 4px rounded data end and a
// square baseline, hairline recessive grid, one series color, hover tooltips,
// text in ink tokens (never the series color).

type Tip = { x: number; y: number; content: ReactNode } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg"
      style={{ left: tip.x, top: tip.y - 8 }}
    >
      {tip.content}
    </div>
  );
}

function useTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip>(null);
  const show = (e: React.MouseEvent, content: ReactNode) => {
    const box = ref.current!.getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, content });
  };
  return { ref, tip, show, hide: () => setTip(null) };
}

// Bar with a 4px rounded data end (right) and a square baseline (left).
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w, h / 2);
  if (w <= 0) return "";
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}

export type BarDatum = { label: string; value: number; display: string; detail?: ReactNode };

export function HBarChart({ data, max, better }: { data: BarDatum[]; max?: number; better: "higher" | "lower" }) {
  const { ref, tip, show, hide } = useTip();
  const sorted = [...data].sort((a, b) => (better === "higher" ? b.value - a.value : a.value - b.value));
  const labelW = 150;
  const valueW = 70;
  const width = 520;
  const rowH = 34;
  const barH = 20;
  const plotW = width - labelW - valueW;
  const top = Math.max(max ?? 0, ...sorted.map((d) => d.value)) || 1;
  const height = sorted.length * rowH + 8;

  return (
    <div ref={ref} className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={sorted.map((d) => `${d.label}: ${d.display}`).join(", ")}>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={labelW + f * plotW} x2={labelW + f * plotW} y1={0} y2={height - 8} stroke="var(--grid)" strokeWidth={1} />
        ))}
        <line x1={labelW} x2={labelW} y1={0} y2={height - 8} stroke="var(--axis)" strokeWidth={1} />
        {sorted.map((d, i) => {
          const y = i * rowH + (rowH - barH) / 2;
          const w = (d.value / top) * plotW;
          return (
            <g key={d.label} onMouseMove={(e) => show(e, <><div className="font-medium">{d.label}</div><div className="tabular text-ink-2">{d.display}</div>{d.detail}</>)} onMouseLeave={hide}>
              {/* Hit target spans the whole row, larger than the mark */}
              <rect x={0} y={i * rowH} width={width} height={rowH} fill="transparent" />
              <text x={labelW - 8} y={y + barH / 2} dy="0.35em" textAnchor="end" fontSize={12} fill="var(--ink-2)">
                {d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label}
              </text>
              <path d={barPath(labelW, y, Math.max(w, 1), barH)} fill="var(--series-1)" />
              <text x={labelW + w + 6} y={y + barH / 2} dy="0.35em" fontSize={12} fill="var(--ink)" className="tabular">
                {d.display}
              </text>
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

export type PointDatum = { label: string; x: number; y: number; xDisplay: string; yDisplay: string };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

export function ScatterChart({ data, xLabel, yLabel, xFormat, yMax = 1 }: { data: PointDatum[]; xLabel: string; yLabel: string; xFormat: (v: number) => string; yMax?: number }) {
  const { ref, tip, show, hide } = useTip();
  const width = 520;
  const height = 280;
  const m = { l: 48, r: 110, t: 12, b: 36 };
  const xMax = niceMax(Math.max(...data.map((d) => d.x)) * 1.05);
  const sx = (v: number) => m.l + (v / xMax) * (width - m.l - m.r);
  const sy = (v: number) => height - m.b - (v / yMax) * (height - m.t - m.b);

  // Direct labels only where the label box hits no other label or dot; the rest
  // live in the tooltip. Text width is estimated at ~6.2px per char at 11px.
  const shortLabel = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);
  const placed: { x1: number; x2: number; y: number }[] = [];
  const labeled = new Set<string>();
  for (const d of [...data].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const x1 = sx(d.x) + 8;
    const x2 = x1 + shortLabel(d.label).length * 6.2;
    const y = sy(d.y);
    const hitsLabel = placed.some((p) => Math.abs(p.y - y) < 14 && x1 < p.x2 && p.x1 < x2);
    const hitsDot = data.some((o) => o !== d && Math.abs(sy(o.y) - y) < 12 && sx(o.x) > x1 - 6 && sx(o.x) < x2 + 6);
    if (!hitsLabel && !hitsDot) {
      placed.push({ x1, x2, y });
      labeled.add(d.label);
    }
  }

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * xMax);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  return (
    <div ref={ref} className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={`${yLabel} vs ${xLabel}`}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
            <text x={m.l - 6} y={sy(t)} dy="0.35em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular">
              {Math.round((t / yMax) * 100)}%
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={sx(t)} y={height - m.b + 16} textAnchor="middle" fontSize={11} fill="var(--muted)" className="tabular">
            {xFormat(t)}
          </text>
        ))}
        <text x={(m.l + width - m.r) / 2} y={height - 4} textAnchor="middle" fontSize={11} fill="var(--ink-2)">
          {xLabel} →
        </text>
        <text transform={`translate(12 ${(m.t + height - m.b) / 2}) rotate(-90)`} textAnchor="middle" fontSize={11} fill="var(--ink-2)">
          {yLabel} →
        </text>
        {data.map((d) => (
          <g key={d.label} onMouseMove={(e) => show(e, <><div className="font-medium">{d.label}</div><div className="tabular text-ink-2">{yLabel}: {d.yDisplay}</div><div className="tabular text-ink-2">{xLabel}: {d.xDisplay}</div></>)} onMouseLeave={hide}>
            <circle cx={sx(d.x)} cy={sy(d.y)} r={14} fill="transparent" />
            <circle cx={sx(d.x)} cy={sy(d.y)} r={5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
            {labeled.has(d.label) && (
              <text x={sx(d.x) + 9} y={sy(d.y)} dy="0.35em" fontSize={11} fill="var(--ink-2)">
                {shortLabel(d.label)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 truncate text-sm text-ink-2">{sub}</div>}
    </div>
  );
}

export function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}
