export function fmt(n: number, d = 0): string {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })
}

export function formatUSD(n: number): string {
  return `$${fmt(n, 2)}`
}

export function formatPercent(n: number): string {
  return `${fmt(n, 2)}%`
}
