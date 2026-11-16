"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import watchlist from "@/data/watchlist.json";
import { valuation, type Cap, type Day, type Snapshot, type Update } from "@/lib/market-data";

type History = Record<string, Cap[]>;
type Stat = NonNullable<ReturnType<typeof valuation>>;
type Line = { name: string; color: string; values: [string, number][] };

const fmt = (value: number | null | undefined, digits = 2) => value == null ? "—" : value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const money = (value: number | null | undefined, unit = 1e8) => value == null ? "—" : fmt(value / unit, unit === 1e8 ? 1 : 2);
const percent = (value: number | null | undefined) => value == null ? "—" : fmt(value * 100, 1) + "%";
const spotPE = (days: Day[] | undefined) => days?.findLast((row) => typeof row[1] === "number" && row[1] > 0);
const zone = (stat: Stat | null, spot?: Day) => !stat ? [spot ? "仅最新 PE" : "暂无估值", "muted"] : stat.pe < stat.low ? ["低于下轨", "low"] : stat.pe > stat.high ? ["高于上轨", "high"] : ["参考区间内", "middle"];
const split = <T,>(rows: T[], size: number) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
const getLocal = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; }
  catch { return fallback; }
};
const saveLocal = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* optional browser storage */ }
};
const mergeDays = (base: Day[], newDays: Day[]) => {
  const days = new Map(base.map((row) => [row[0], row]));
  for (const row of newDays) {
    const prior = days.get(row[0]);
    days.set(row[0], [row[0], row[1] ?? prior?.[1] ?? null, row[2] ?? prior?.[2] ?? null]);
  }
  return [...days.values()].sort((a, b) => a[0].localeCompare(b[0]));
};

async function query(params: Record<string, string>): Promise<Update> {
  const result = await fetch("/api/refresh?" + new URLSearchParams(params), { signal: AbortSignal.timeout(12000) });
  if (!result.ok) throw new Error("刷新失败");
  return result.json();
}

function Chart({ lines, guides = [], format = (v: number) => fmt(v, 1), label }:
  { lines: Line[]; guides?: { value: number; color: string }[]; format?: (v: number) => string; label: string }) {
  const [active, setActive] = useState<string | null>(null);
  const values = [...lines.flatMap((line) => line.values.map(([, value]) => value)), ...guides.map(({ value }) => value)];
  if (!values.length) return <div className="empty">暂无足够数据</div>;
  const dates = [...new Set(lines.flatMap((line) => line.values.map(([date]) => date)))].sort();
  if (!dates.length) return <div className="empty">暂无足够数据</div>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * .10, Math.abs(max) * .005, .01);
  const bottom = min - pad;
  const top = max + pad;
  const x0 = 49;
  const x1 = 682;
  const y0 = 14;
  const y1 = 173;
  const first = Date.parse(dates[0]);
  const last = Date.parse(dates[dates.length - 1]);
  const x = (date: string) => x0 + (last === first ? .5 : (Date.parse(date) - first) / (last - first)) * (x1 - x0);
  const y = (value: number) => y1 - (value - bottom) / (top - bottom) * (y1 - y0);
  const ticks = [...new Set([0, .25, .5, .75, 1].map((fraction) => dates[Math.round((dates.length - 1) * fraction)]))];
  const hovered = active && dates.includes(active) ? active : null;
  return <div className="chart">
    <svg viewBox="0 0 700 205" role="img" aria-label={label} onPointerLeave={() => setActive(null)} onPointerMove={(event) => {
      const box = event.currentTarget.getBoundingClientRect();
      const position = (event.clientX - box.left) / box.width * 700;
      const best = dates.reduce((a, b) => Math.abs(x(b) - position) < Math.abs(x(a) - position) ? b : a);
      setActive(best);
    }}>
      {[0, .25, .5, .75, 1].map((fraction) => {
        const value = bottom + fraction * (top - bottom);
        return <g key={fraction}><line x1={x0} x2={x1} y1={y(value)} y2={y(value)} className="gridline"/><text x={x0 - 8} y={y(value) + 4} textAnchor="end">{format(value)}</text></g>;
      })}
      {guides.map((line) => <line key={line.color} x1={x0} x2={x1} y1={y(line.value)} y2={y(line.value)} stroke={line.color} strokeDasharray="5 4" strokeWidth="1.3"/>)}
      {lines.map((line) => <g key={line.name}>
        <polyline points={line.values.map(([date, value]) => x(date).toFixed(1) + "," + y(value).toFixed(1)).join(" ")} fill="none" stroke={line.color} strokeWidth="2" strokeLinejoin="round"/>
        {line.values.length > 0 && <circle cx={x(line.values.at(-1)![0])} cy={y(line.values.at(-1)![1])} r="3.5" fill={line.color} stroke="white" strokeWidth="1"/>}
      </g>)}
      {ticks.map((date, i) => <text key={date} x={x(date)} y="196" textAnchor={i === 0 && ticks.length > 1 ? "start" : i === ticks.length - 1 && ticks.length > 1 ? "end" : "middle"}>{dates.length > 15 ? date.slice(0, 7) : date}</text>)}
      {hovered && <line x1={x(hovered)} x2={x(hovered)} y1={y0} y2={y1} className="hoverline"/>}
    </svg>
    <div className="chart-readout">
      {hovered ? <><span>{hovered}</span>{lines.map((line) => {
        const point = line.values.find(([date]) => date === hovered);
        return point ? <span key={line.name}><i style={{ background: line.color }}/>{line.name} {format(point[1])}</span> : null;
      })}</> : <span>移到图上查看对应日期的数据</span>}
    </div>
  </div>;
}

export default function Page() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState("000300");
  const [group, setGroup] = useState("全部");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("default");
  const [years, setYears] = useState(8);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [capHistory, setCapHistory] = useState<History>({});
  const [caps, setCaps] = useState<Record<string, Cap>>({});
  const [status, setStatus] = useState("正在读取初始快照");
  const [busy, setBusy] = useState(false);
  const [capStatus, setCapStatus] = useState("");
  const [refreshId, setRefreshId] = useState(0);
  const [tab, setTab] = useState("估值参考线");
  const detail = useRef<HTMLElement>(null);
  const snapshotRef = useRef<Snapshot | null>(null);

  async function refresh(base: Snapshot) {
    setBusy(true);
    setStatus("正在核对指数估值与 ETF 行情");
    const draft = { ...base, indices: { ...base.indices }, funds: { ...base.funds } };
    let failures = 0;
    let matches = 0;
    const batches = split(watchlist.filter(({ index }) => base.indices[index]?.daily.length > 0), 4);
    for (let i = 0; i < batches.length; i += 3) {
      const results = await Promise.allSettled(batches.slice(i, i + 3).map((batch, offset) => {
        const codes = batch.map(({ index }) => index);
        const since = codes.map((code) => base.indices[code].daily.at(-1)?.[0] ?? base.asOf).sort()[0];
        const params: Record<string, string> = { indices: codes.join(","), since };
        if (i + offset === 0) params.funds = "1";
        return query(params);
      }));
      for (const result of results) {
        if (result.status === "rejected") { failures++; continue; }
        failures += result.value.failed.length;
        for (const [code, days] of Object.entries(result.value.daily)) {
          if (!days.length || !draft.indices[code]) continue;
          draft.indices[code] = { ...draft.indices[code], daily: mergeDays(draft.indices[code].daily, days) };
          matches++;
        }
        for (const [code, quote] of Object.entries(result.value.funds)) {
          if (!draft.funds[code] || quote.date >= draft.funds[code].date) {
            draft.funds[code] = quote;
            matches++;
          }
        }
      }
    }
    snapshotRef.current = draft;
    setSnapshot(draft);
    setBusy(false);
    setStatus(matches ? (failures ? "部分已核对，其余保留最近有效数据" : "已核对数据源 · 各项日期见面板") : "实时接口暂不可用 · 显示最近快照");
  }

  useEffect(() => {
    setFavorites(getLocal<string[]>("etf-observatory-favorites", []));
    setCapHistory(getLocal<History>("etf-observatory-cap-v1", {}));
    fetch("/snapshot.json").then(async (response) => {
      if (!response.ok) throw new Error("读取快照失败");
      const base: Snapshot = await response.json();
      snapshotRef.current = base;
      setSnapshot(base);
      void refresh(base);
    }).catch(() => setStatus("初始快照读取失败，请刷新页面"));
  }, []);

  const index = snapshot?.indices[selected];
  const memberKey = index?.memberDate ? selected + "/" + index.memberDate : "";
  const members = index?.members;
  useEffect(() => {
    if (!memberKey || !members?.length) { setCapStatus(""); return; }
    let cancelled = false;
    const batches = split(members, 65);
    async function refreshCap() {
      setCapStatus("正在核对样本行情");
      const parts: Cap[] = [];
      for (let i = 0; i < batches.length; i += 5) {
        if (cancelled) return;
        const results = await Promise.allSettled(batches.slice(i, i + 5).map((batch) => query({ basket: batch.join(",") })));
        for (const result of results) if (result.status === "fulfilled" && result.value.cap) parts.push(result.value.cap);
      }
      if (cancelled) return;
      const date = parts.map((cap) => cap.date).sort().at(-1);
      const sameDay = parts.filter((cap) => cap.date === date);
      const cap = date && sameDay.length === batches.length ? { date, value: sameDay.reduce((sum, row) => sum + row.value, 0), count: sameDay.reduce((sum, row) => sum + row.count, 0) } : null;
      if (!cap || cap.count !== members?.length) { setCapStatus("本次覆盖不足，保留最近可用值"); return; }
      setCaps((prior) => ({ ...prior, [memberKey]: cap }));
      setCapHistory((prior) => {
        const records = [...(prior[memberKey] ?? []).filter((row) => row.date !== cap.date), cap].sort((a, b) => a.date.localeCompare(b.date)).slice(-750);
        const next = { ...prior, [memberKey]: records };
        saveLocal("etf-observatory-cap-v1", next);
        return next;
      });
      setCapStatus("已核对全部样本行情");
    }
    void refreshCap();
    return () => { cancelled = true; };
  }, [memberKey, members, refreshId]);

  function toggleFavorite(code: string) {
    const next = favorites.includes(code) ? favorites.filter((item) => item !== code) : [...favorites, code];
    setFavorites(next);
    saveLocal("etf-observatory-favorites", next);
  }

  const stats = useMemo(() => Object.fromEntries(watchlist.map(({ index: code }) => [code, valuation(snapshot?.indices[code]?.daily ?? [], years)])), [snapshot, years]);
  const groups = ["全部", ...new Set(watchlist.map((item) => item.group))];
  const filtered = watchlist.filter((item) =>
    (group === "全部" || item.group === group) &&
    (!onlyFavorites || favorites.includes(item.index)) &&
    [item.name, item.index, item.fund, item.group].some((value) => value?.toLowerCase().includes(search.trim().toLowerCase()))
  ).sort((a, b) => {
    const fundA = snapshot?.funds[a.fund ?? ""];
    const fundB = snapshot?.funds[b.fund ?? ""];
    if (sort === "cap") return (fundB?.cap ?? -1) - (fundA?.cap ?? -1);
    if (sort === "turnover") return (fundB?.turnover ?? -1) - (fundA?.turnover ?? -1);
    if (sort === "percentile") return (stats[a.index]?.percentile ?? 2) - (stats[b.index]?.percentile ?? 2);
    return 0;
  });

  const item = watchlist.find((row) => row.index === selected)!;
  const stat = stats[selected];
  const spot = spotPE(index?.daily);
  const [zoneText, zoneClass] = zone(stat, spot);
  const quote = snapshot?.funds[item.fund ?? ""];
  const capSeries = [...new Map([...(index?.cap ? [index.cap] : []), ...(capHistory[memberKey] ?? []), ...(caps[memberKey] ? [caps[memberKey]] : [])].map((row) => [row.date, row])).values()].sort((a, b) => a.date.localeCompare(b.date));
  const cap = capSeries.at(-1);
  const financial = index?.financial;
  const latest = financial?.series.at(-1);
  const yearAgo = financial?.series.find(([date]) => latest && date === String(Number(latest[0].slice(0, 4)) - 1) + latest[0].slice(4));
  const margin = latest && latest[1] > 0 ? latest[2] / latest[1] : null;
  const profitGrowth = latest && yearAgo && yearAgo[2] > 0 ? (latest[2] - yearAgo[2]) / yearAgo[2] : null;
  const revenueGrowth = latest && yearAgo && yearAgo[1] > 0 ? (latest[1] - yearAgo[1]) / yearAgo[1] : null;
  const trend: Line[] = [];
  if (financial?.series.length) {
    const start = financial.series[0];
    const market = financial.series.flatMap(([date]) => {
      const day = index?.daily.findLast(([trade, , close]) => trade <= date && typeof close === "number" && close > 0);
      return day && day[2] ? [[date, day[2]] as [string, number]] : [];
    });
    if (start[1] > 0) trend.push({ name: "样本营收 TTM", color: "#087c64", values: financial.series.map(([date, revenue]) => [date, revenue / start[1] * 100]) });
    if (market.length) trend.push({ name: "指数收盘点位", color: "#4555ab", values: market.map(([date, close]) => [date, close / market[0][1] * 100]) });
  }
  const latestPE = Object.values(stats).flatMap((row) => row ? [row.date] : []).sort().at(-1);
  const countFund = watchlist.filter(({ fund }) => fund).length;
  const countStat = Object.values(stats).filter(Boolean).length;
  const counts = Object.values(stats).filter((row) => row && row.pe < row.low).length;
  const sourcePE = "https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=" + selected + "&startDate=20181105&endDate=" + (stat?.date ?? snapshot?.asOf ?? "2026-11-05").replaceAll("-", "");

  return <main className="shell">
    <header className="mast">
      <div className="brand"><span className="mark"><svg viewBox="0 0 30 30" aria-hidden="true"><path d="M4 23h22M4 17l6-4 5 3 5-8 6 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span>市场研究台</span><span className="mast-divider"/><span className="mast-caption">A 股 / 指数估值</span></div>
      <button className="refresh" disabled={busy || !snapshot} onClick={() => {
        if (snapshotRef.current) { setRefreshId((id) => id + 1); void refresh(snapshotRef.current); }
      }}><span aria-hidden="true">↻</span>{busy ? "更新中" : "刷新数据"}</button>
    </header>

    <section className="hero">
      <div><div className="eyebrow"><i/> 每日估值观察</div><h1>A 股 ETF 估值观察室</h1><p>用历史估值定位板块，再看市值、营收和盈利是否相互印证。</p></div>
      <div className="hero-stats">
        <div><span>观察指数</span><strong>{watchlist.length}<small> / {countFund} 只 ETF</small></strong></div>
        <div><span>低于估值下轨</span><strong>{snapshot ? counts : "—"}<small> / {snapshot ? countStat : "—"}</small></strong></div>
        <div><span>最新估值日</span><strong className="hero-date">{latestPE ?? "—"}</strong></div>
      </div>
    </section>
    <div className="status" role="status"><i/> {status}<span>基线快照 {snapshot?.asOf ?? "—"}</span></div>

    <section className="panel watch">
      <div className="heading"><div><span className="kicker">01 / ETF 观察池</span><h2>行业与宽基估值</h2></div><div className="controls">
        <input aria-label="搜索指数或 ETF" placeholder="搜索指数或 ETF 代码" value={search} onChange={(event) => setSearch(event.target.value)}/>
        <select aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="default">板块顺序</option><option value="cap">ETF 市值从大到小</option><option value="turnover">ETF 成交额从大到小</option><option value="percentile">PE 分位从低到高</option></select>
        <button className={onlyFavorites ? "picked" : ""} onClick={() => setOnlyFavorites(!onlyFavorites)} aria-pressed={onlyFavorites}>☆ 收藏</button>
      </div></div>
      <div className="filterbar">
        <div className="filters" aria-label="板块筛选">{groups.map((value) => <button key={value} className={group === value ? "active" : ""} aria-pressed={group === value} onClick={() => setGroup(value)}>{value}</button>)}</div>
        <div className="window" aria-label="估值回看周期">{[3, 5, 8].map((value) => <button key={value} className={years === value ? "picked" : ""} aria-pressed={years === value} onClick={() => setYears(value)}>{value} 年</button>)}</div>
      </div>
      <div className="table-wrap" tabIndex={0} aria-label="指数估值表">
        <table>
          <thead><tr><th aria-label="收藏">☆</th><th>指数 / ETF</th><th>PE TTM</th><th>下轨</th><th>均线</th><th>上轨</th><th>估值位置</th><th>样本市值<small>万亿元</small></th><th>ETF 市值<small>亿元</small></th><th>ETF 成交额<small>亿元</small></th><th>数据日期<small>PE / 行情</small></th></tr></thead>
          <tbody>{filtered.map((row) => {
            const s = stats[row.index];
            const data = snapshot?.indices[row.index];
            const key = row.index + "/" + data?.memberDate;
            const recorded = capHistory[key]?.at(-1);
            const latestCap = caps[key] ?? (recorded && (!data?.cap || recorded.date >= data.cap.date) ? recorded : data?.cap);
            const fund = snapshot?.funds[row.fund ?? ""];
            const spot = spotPE(data?.daily);
            const [description, color] = zone(s, spot);
            return <tr key={row.index} className={row.index === selected ? "selected" : ""} onClick={() => { setSelected(row.index); setTab("估值参考线"); detail.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
              <td><button className={"star " + (favorites.includes(row.index) ? "starred" : "")} aria-label={(favorites.includes(row.index) ? "取消收藏" : "收藏") + row.name} aria-pressed={favorites.includes(row.index)} onClick={(event) => { event.stopPropagation(); toggleFavorite(row.index); }}>{favorites.includes(row.index) ? "★" : "☆"}</button></td>
              <td><button className="index-button">{row.name}</button><small>{row.index} <span>·</span> {row.fund ?? "仅指数对照"}</small></td>
              <td className="current">{fmt(spot?.[1])}</td><td className="low-text">{fmt(s?.low)}</td><td>{fmt(s?.mean)}</td><td className="high-text">{fmt(s?.high)}</td>
              <td><span className={"zone " + color}>{description}</span></td><td>{money(latestCap?.value, 1e12)}</td><td>{money(fund?.cap)}</td><td>{money(fund?.turnover)}</td>
              <td className="date-cell">{spot?.[0] ?? "—"}<small>{fund?.date ?? "—"}</small></td>
            </tr>;
          })}</tbody>
        </table>
        {!filtered.length && <div className="empty">没有符合条件的指数</div>}
      </div>
      <p className="footnote">按指数去重，每个标的保留一只代表 ETF。估值参考线使用所选期间正值 PE 样本的均值 ± 1 个总体标准差。部分指数的可用历史短于所选周期。</p>
    </section>

    <section className="panel detail" ref={detail}>
      <div className="heading"><div><span className="kicker">02 / 指数详情</span><h2>{item.name} <span className="detail-code">{item.index}</span></h2><p>{item.note}</p></div><span className={"zone " + zoneClass}>{zoneText}</span></div>
      <div className="metrics">
        <div><span>指数 PE TTM</span><strong>{fmt(spot?.[1])}<small> 倍</small></strong><small>{stat ? stat.date + " · 历史分位 " + percent(stat.percentile) : spot ? spot[0] + " · 国证指数" : "当前数据源无历史 PE"}</small></div>
        <div><span>样本合计市值</span><strong>{money(cap?.value, 1e12)}<small> 万亿元</small></strong><small>{cap?.date ?? "—"} · {cap ? cap.count + "/" + index?.members.length + " 只" : "暂无样本行情"}</small></div>
        <div><span>ETF 场内市值 {item.fund && "· " + item.fund}</span><strong>{money(quote?.cap)}<small> 亿元</small></strong><small>{quote?.date ?? "—"} · 成交额 {money(quote?.turnover)} 亿</small></div>
        <div><span>归母净利 TTM 同比</span><strong>{percent(profitGrowth)}</strong><small>{latest?.[0] ?? "—"} · 净利率 {percent(margin)}</small></div>
      </div>
      <div className="detail-tabs" aria-label="详情指标">{["估值参考线", "经营与价格", "样本市值记录"].map((value) => <button key={value} className={tab === value ? "active" : ""} aria-pressed={tab === value} onClick={() => setTab(value)}>{value}</button>)}</div>
      {tab === "估值参考线" && (stat ? <div className="chart-card">
        <div className="chart-heading"><div><h3>PE TTM 与估值参考线</h3><p>{stat.points[0][0]} 至 {stat.date} · {stat.points.length.toLocaleString("zh-CN")} 个交易日样本</p></div><div className="legend">
          <span><i style={{ background: "#4555ab" }}/> PE {fmt(stat.pe)}</span><span><i style={{ background: "#16836b" }}/> 下轨 {fmt(stat.low)}</span><span><i style={{ background: "#b47e20" }}/> 均线 {fmt(stat.mean)}</span><span><i style={{ background: "#bc514c" }}/> 上轨 {fmt(stat.high)}</span>
        </div></div>
        <Chart key={selected + years} lines={[{ name: "PE TTM", color: "#4555ab", values: stat.points.map(([date, pe]) => [date, pe]) }]} guides={[{ value: stat.low, color: "#16836b" }, { value: stat.mean, color: "#b47e20" }, { value: stat.high, color: "#bc514c" }]} label="指数 PE TTM 历史及上下估值参考线"/>
      </div> : <div className="empty">{spot ? item.name + "已接入最新滚动 PE，历史序列不足以计算参考线。" : "当前估值接口暂无" + item.name + "数据。"}</div>)}
      {tab === "经营与价格" && (latest ? <div className="chart-card">
        <div className="chart-heading"><div><h3>固定样本营收与指数价格</h3><p>各序列期初 = 100 · 财报固定样本 {financial?.count}/{index?.members.length} 只</p></div><div className="legend">{trend.map((line) => <span key={line.name}><i style={{ background: line.color }}/>{line.name}</span>)}</div></div>
        <Chart key={selected} lines={trend} label="固定样本滚动营收和指数收盘点位趋势"/>
        <div className="financial-row"><span>营收 TTM <b>{money(latest[1], 1e12)} 万亿元</b></span><span>营收同比 <b>{percent(revenueGrowth)}</b></span><span>归母净利 TTM <b>{money(latest[2])} 亿元</b></span><span>归母净利同比 <b>{percent(profitGrowth)}</b></span></div>
        <p className="footnote">价格线使用各季末最近交易日的指数收盘点位。财报截至 {latest[0]}，按 {index?.memberDate} 样本中具备全部可比财报的公司汇总，包含当期才进入样本的公司历史报表。</p>
      </div> : <div className="empty">暂无可比的固定样本财报</div>)}
      {tab === "样本市值记录" && <div className="chart-card">
        <div className="chart-heading"><div><h3>固定篮子合计市值</h3><p>成分股名单 {index?.memberDate ?? "—"} · {capStatus || "以可用快照为准"}</p></div><div className="legend"><span><i style={{ background: "#087c64" }}/> 万亿元</span></div></div>
        {capSeries.length ? <Chart key={selected} lines={[{ name: "样本市值", color: "#087c64", values: capSeries.map((row) => [row.date, row.value / 1e12]) }]} label="已记录的成分股合计市值"/> : <div className="empty">暂无样本市值记录</div>}
        <p className="footnote">打开指数详情时核对固定篮子行情。完整覆盖的观测按交易日记录在当前浏览器，初始快照随页面提供。当前已有 {capSeries.length} 个日期的观测。</p>
      </div>}
    </section>

    <footer className="panel notes">
      <div><span className="kicker">03 / 使用口径</span><h2>三步读板块</h2></div>
      <div className="note-grid"><div><b>先看估值位置</b><p>上下轨用于定位。对波动大的行业，同时看样本期长短和历史分位。</p></div><div><b>再看盈利和规模</b><p>PE 走低时同时检查营收、归母净利和净利率。金融、资源板块还要结合各自的盈利周期。</p></div><div><b>最后检查日期与覆盖</b><p>PE 属于指数，场内市值属于 ETF。成分股市值按固定篮子相加；成分股名单和财报随基线更新。</p></div></div>
      <div className="sources"><span>数据来源</span><a href={stat && selected !== "399006" ? sourcePE : "https://www.csindex.com.cn/"} target="_blank" rel="noreferrer">中证指数</a><a href="https://www.cnindex.com.cn/module/index-detail.html?indexCode=399006" target="_blank" rel="noreferrer">国证指数</a><a href="https://quote.eastmoney.com/" target="_blank" rel="noreferrer">东方财富行情</a><a href="https://data.eastmoney.com/bbsj/" target="_blank" rel="noreferrer">财报数据</a><a href="https://etf.sse.com.cn/fundlist/" target="_blank" rel="noreferrer">上交所 ETF 名录</a></div>
    </footer>
  </main>;
}
