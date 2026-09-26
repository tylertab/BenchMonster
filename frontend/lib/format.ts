export const pct = (v: number | null | undefined, digits = 0) =>
  v == null ? "–" : `${(Number(v) * 100).toFixed(digits)}%`;

export const ms = (v: number | null | undefined) => {
  if (v == null) return "–";
  const n = Number(v);
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n).toLocaleString()}ms`;
};

export const usd = (v: number | null | undefined) => {
  if (v == null) return "–";
  const n = Number(v);
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toPrecision(2)}`;
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
};

export const num = (v: number | null | undefined, digits = 0) =>
  v == null ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });

export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`).toLocaleString() : "–";
