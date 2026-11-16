export type Day = [date: string, pe: number | null, close: number | null];
export type Cap = { date: string; value: number; count: number };
export type FundQuote = { date: string; cap: number; turnover: number; price: number | null; change: number | null };
export type IndexData = {
  daily: Day[];
  memberDate: string | null;
  members: string[];
  cap: Cap | null;
  financial: { count: number; series: [date: string, revenue: number, profit: number][] } | null;
};
export type Snapshot = { asOf: string; indices: Record<string, IndexData>; funds: Record<string, FundQuote> };
export type Update = { daily: Record<string, Day[]>; funds: Record<string, FundQuote>; cap?: Cap; failed: string[] };
export const shanghaiDate = (time = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(time);

export function valuation(days: Day[], years: number) {
  const latest = days.findLast((row) => typeof row[1] === "number" && row[1] > 0);
  if (!latest) return null;
  const cutoff = String(Number(latest[0].slice(0, 4)) - years) + latest[0].slice(4);
  const points = days.filter((row): row is [string, number, number | null] =>
    row[0] >= cutoff && row[0] <= latest[0] && typeof row[1] === "number" && row[1] > 0);
  if (points.length < 20) return null;
  const mean = points.reduce((sum, row) => sum + row[1], 0) / points.length;
  const sigma = Math.sqrt(points.reduce((sum, row) => sum + (row[1] - mean) ** 2, 0) / points.length);
  return {
    points, mean, low: mean - sigma, high: mean + sigma, date: latest[0], pe: latest[1] as number,
    percentile: points.filter((row) => row[1] < (latest[1] as number)).length / points.length,
  };
}
