import { build } from "esbuild";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const hosted = process.argv.includes("--hosted");
const target = process.env.FINANCE_HTML_OUTPUT ? path.resolve(process.env.FINANCE_HTML_OUTPUT) : path.join(root, "dist/index.html");
const localSnapshot = path.join(root, "offline/snapshot.json");
const snapshotFile = process.argv[2] ? path.resolve(process.argv[2]) : existsSync(localSnapshot) ? localSnapshot : path.join(root, "public/snapshot.json");
const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
const globalFile = path.join(root, "offline/global-snapshot.json");
if (existsSync(globalFile)) {
  const globalSnapshot = JSON.parse(await readFile(globalFile, "utf8"));
  Object.assign(snapshot.indices, globalSnapshot.indices);
}
const catalog = [
  ...JSON.parse(await readFile(path.join(root, "data/watchlist.json"), "utf8")),
  ...JSON.parse(await readFile(path.join(root, "data/global-watchlist.json"), "utf8")),
];
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.asOf)) throw new Error("Invalid snapshot date");
for (const item of catalog) {
  const data = snapshot.indices[item.index];
  if (!data?.daily?.length || (!item.kind && !data.members?.length) || (data.cap && data.cap.count !== data.members.length) || (!data.financial?.series?.length && !data.sourceNote)) {
    throw new Error("数据覆盖不足，保留原有网页。指数 " + item.index);
  }
  if (item.fund && !snapshot.funds[item.fund]) throw new Error("ETF 行情缺失 " + item.fund);
}

let source = await readFile(path.join(root, "app/page.tsx"), "utf8");
source = source.replace('import watchlist from "@/data/watchlist.json";', "const watchlist: WatchItem[] = " + JSON.stringify(catalog) + ";");
source = source.replace('type History =', 'type WatchItem = {index:string; fund:string|null; name:string; group:string; note:string; kind?:string; unit?:string};\ntype History =');
source = source.replace('useState(false);\n  const [capHistory', 'useState(true);\n  const [capHistory');
source = source.replace(/"@\/lib\/market-data"/g, JSON.stringify(path.join(root, "lib/market-data.ts")));
source = source.replace("export default function Page()", "function Page()");
const queryStart = source.indexOf("async function query(");
const queryEnd = source.indexOf("function Chart(", queryStart);
source = source.slice(0, queryStart) + source.slice(queryEnd);
const refreshStart = source.indexOf("  async function refresh(");
const refreshEnd = source.indexOf("  function toggleFavorite(", refreshStart);
source = source.slice(0, refreshStart) + `
  useEffect(() => {
    let saved = getLocal<string[]>("etf-observatory-favorites", ["000300"]);
    saved = saved.map((code) => code === "399959" ? "000819" : code === "930997" ? "931151" : code);
    if (!getLocal("etf-global-favorites-v1", false)) {
      saved = [...new Set([...saved, "AU9999", "HSTECH", "NDX", "SP500"])];
      saveLocal("etf-global-favorites-v1", true);
    }
    if (!getLocal("global-cycle-favorites-v1", false)) {
      saved = [...new Set([...saved, "H30198", "H30216"])];
      saveLocal("global-cycle-favorites-v1", true);
    }
    setFavorites(saved);
    saveLocal("etf-observatory-favorites", saved);
    if (saved.length) { setSelected(saved[0]); setTab(["AU9999", "HSTECH", "NDX", "SP500"].includes(saved[0]) ? "价格走势" : "估值参考线"); }
    setCapHistory(getLocal<History>("etf-observatory-cap-v1", {}));
    setSnapshot(embeddedSnapshot);
    setStatus("本地数据快照 · 采集于 " + embeddedSnapshot.asOf);
  }, []);
  const index = snapshot?.indices[selected];
  const memberKey = index?.memberDate ? selected + "/" + index.memberDate : "";
` + source.slice(refreshEnd);
const buttonStart = source.indexOf('      <button className="refresh"');
const buttonEnd = source.indexOf("</button>", buttonStart) + "</button>".length;
source = source.slice(0, buttonStart) + '<button className="refresh" onClick={() => window.print()}>打印 / 保存 PDF</button>' + source.slice(buttonEnd);
source = source.replace('    <div className="status"', `    <div className="offline-info">
      <b>双击即可查看 · 数据和图表已内置</b>
      <p>需要新数据时，双击同文件夹内的“更新全球资产面板数据.command”，完成后重新打开网页。行情日期和财报日期分别标在各项数据旁。</p>
    </div>
    <div className="status"`);
source = source.replace('最新估值日', '快照中最新估值日');
source = source.replace('setTab("估值参考线"); detail.current?', 'setTab(row.kind ? "价格走势" : "估值参考线"); detail.current?');
source = source.replace('没有符合条件的指数', '当前没有符合条件的收藏。点击“★ 仅收藏 / ☆ 仅收藏”切换到全部指数，再点击星号添加。');
source = source.replace('>☆ 收藏</button>', '>{onlyFavorites ? "★ 仅收藏" : "☆ 仅收藏"}</button>');
source = source.replace('const [description, color] = zone(s, spot);', 'const [description, color] = row.kind === "gold" ? ["价格观察", "muted"] : zone(s, spot);\n            const price = data?.daily.findLast((day) => typeof day[2] === "number");');
source = source.replace('<th>PE TTM</th>', '<th>最新点位 / 金价<small>点 / 元每克</small></th><th>PE<small>口径见详情</small></th>');
source = source.replace('<td className="current">{fmt(spot?.[1])}</td>', '<td>{fmt(price?.[2])}<small>{price?.[0] ?? "—"}</small></td><td className="current">{row.kind === "gold" ? "不适用" : fmt(spot?.[1])}</td>');
source = source.replace('  const quote = snapshot?', '  const pricePoints = (index?.daily ?? []).filter((row) => typeof row[2] === "number" && row[2] > 0);\n  const lastPrice = pricePoints.at(-1);\n  const priceCutoff = lastPrice ? String(Number(lastPrice[0].slice(0, 4)) - years) + lastPrice[0].slice(4) : "";\n  const visiblePrices = pricePoints.filter((row) => row[0] >= priceCutoff);\n  const referenceStats = [3,5,8].map((window) => ({window, stat: valuation(index?.daily ?? [], window)}));\n  const quote = snapshot?');
source = source.replace('<div className="metrics">', `<div className="metrics">{item.kind ? <>
      <div><span>{item.kind === "gold" ? "Au99.99 黄金现货收盘" : "指数收盘点位"}</span><strong>{fmt(lastPrice?.[2])}<small> {item.unit}</small></strong><small>{lastPrice?.[0] ?? "—"}</small></div>
      <div><span>{item.kind === "gold" ? "PE 口径" : "PE · 蛋卷口径"}</span><strong>{item.kind === "gold" ? "不适用" : fmt(spot?.[1])}</strong><small>{item.kind === "gold" ? "实物黄金没有公司盈利" : spot ? spot[0] + " · 定义以原始来源为准" : "同口径指数 PE 暂缺"}</small></div>
      <div><span>当前价格样本</span><strong>{visiblePrices.length}<small> 个日期</small></strong><small>{visiblePrices[0]?.[0] ?? "—"} 至 {lastPrice?.[0] ?? "—"}</small></div>
      <div><span>所选价格区间涨跌</span><strong>{visiblePrices.length > 1 ? percent((visiblePrices.at(-1)![2]! / visiblePrices[0][2]!) - 1) : "—"}</strong><small>以实际可用价格起止计算</small></div>
      </> : <>`);
source = source.replace('      </div>\n      <div className="detail-tabs"', '      </>}</div>\n      <div className="detail-tabs"');
source = source.replace('["估值参考线", "经营与价格", "样本市值记录"].map', '(item.kind ? ["价格走势", "估值参考线"] : ["估值参考线", "价格走势", "经营与价格", "样本市值记录"]).map');
source = source.replace('      {tab === "估值参考线"', `      {tab === "价格走势" && <div className="chart-card"><div className="chart-heading"><div><h3>{item.kind === "gold" ? "黄金现货价格" : "指数收盘点位"}</h3><p>窗口 {years} 年 · 实际数据 {visiblePrices[0]?.[0] ?? "—"} 至 {lastPrice?.[0] ?? "—"} · {visiblePrices.length} 个日期</p></div></div><Chart key={selected + years + "price"} lines={[{name:item.name,color:"#4555ab",values:visiblePrices.map(([date,,close]) => [date,close!])}]} label="历史收盘价格"/></div>}
      {tab === "估值参考线"`);
source = source.replace('<div className="empty">{spot ? item.name', '<div className="empty">{item.kind === "gold" ? "实物黄金不适用 PE 估值参考线。请查看价格走势。" : spot ? item.name');
source = source.replace('spot ? item.name + "已接入最新滚动 PE，历史序列不足以计算参考线。"', 'spot ? item.name + (item.kind ? "已接入官方月报 PE，历史样本不足以计算参考线。" : "已接入已核实 PE，历史序列不足以计算参考线。")');
source = source.replace('    <footer className="panel notes">', `<section className="panel notes"><span className="kicker">回看周期</span><h2>8 年定位，5 年复核，3 年看近期变化</h2><p className="footnote">周期行业优先观察较长样本。行业结构变化时同时看5年；3年适合判断近期估值变化。恒生科技于2020年7月推出，当前优先检查5年；更早回测数据需单独辨认。价格走势的样本长度与PE历史分别展示。</p><div className="table-wrap"><table style={{minWidth:500}}><thead><tr><th>周期</th><th>当前PE</th><th>下轨</th><th>均线</th><th>上轨</th><th>实际起始日</th></tr></thead><tbody>{referenceStats.map(({window,stat:s}) => <tr key={window}><td>{window} 年</td><td>{fmt(s?.pe)}</td><td>{fmt(s?.low)}</td><td>{fmt(s?.mean)}</td><td>{fmt(s?.high)}</td><td>{s?.points[0][0] ?? "样本不足"}</td></tr>)}</tbody></table></div></section>
    <footer className="panel notes">`);
source = source.replace('<div className="sources"><span>数据来源</span>', '<div className="sources"><span>数据来源</span>{(index as typeof index & {sourceUrl?:string})?.sourceUrl && <a href={(index as typeof index & {sourceUrl?:string})?.sourceUrl} target="_blank" rel="noreferrer">当前资产价格来源</a>}{(index as typeof index & {peSourceUrl?:string})?.peSourceUrl && <a href={(index as typeof index & {peSourceUrl?:string})?.peSourceUrl} target="_blank" rel="noreferrer">当前资产官方PE来源</a>}');
source = source.replace('<section className="panel detail" ref={detail}>', '<section className="panel detail" ref={detail}>{(index as typeof index & {sourceNote?: string})?.sourceNote && <div className="offline-info"><p>{(index as typeof index & {sourceNote?: string})?.sourceNote}</p><a href={(index as typeof index & {peSourceUrl?:string;sourceUrl?:string})?.peSourceUrl ?? (index as typeof index & {sourceUrl?:string})?.sourceUrl ?? ("https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/" + selected + "factsheet.pdf")} target="_blank" rel="noreferrer">数据出处</a></div>}');
source = source.replace('个交易日样本', '个 PE 观察样本');
source = source.replace('<h3>PE TTM 与估值参考线</h3>', '<h3>{item.kind ? "PE（蛋卷口径）与估值参考线" : "PE TTM 与估值参考线"}</h3>');
source = source.replace('      {tab === "估值参考线" && (stat ?', '      {tab === "估值参考线" && (stat ?');
source = source.replace('</p><a href={(index as typeof index & {peSourceUrl?:string;sourceUrl?:string})?', '</p>{(index as typeof index & {officialPESnapshot?: {date:string;value:number;url:string}})?.officialPESnapshot && <p>官方月报核对值 · {(index as any).officialPESnapshot.date} · PE {(index as any).officialPESnapshot.value} 倍 · <a href={(index as any).officialPESnapshot.url} target="_blank" rel="noreferrer">官方原文</a></p>}<a href={(index as typeof index & {peSourceUrl?:string;sourceUrl?:string})?');
source = source.replace('Object.values(stats).flatMap((row) => row ? [row.date] : [])', 'Object.values(snapshot?.indices ?? {}).flatMap((row) => { const spot = spotPE(row.daily); return spot ? [spot[0]] : []; })');
source = source.replace('打开指数详情时核对固定篮子行情。完整覆盖的观测按交易日记录在当前浏览器，初始快照随页面提供。', '当前文件内置采集当日的固定篮子市值。之前使用在线版时在此浏览器积累的记录也会在可用时展示。');
source += `
import { createRoot } from "react-dom/client";
const embeddedSnapshot = JSON.parse(document.getElementById("embedded-data")!.textContent!) as Snapshot;
createRoot(document.getElementById("root")!).render(<Page />);
`;

source = source.replaceAll("A 股 ETF 估值观察室", "全球资产估值观察室");
source = source.replaceAll("A 股 / 指数估值", "全球资产 / 指数估值");
source = source.replace("用历史估值定位板块，再看市值、营收和盈利是否相互印证。", "观察全球指数、行业与黄金，用历史估值、市值和盈利理解市场。");
source = source.replace("当前资产官方PE来源", "当前资产PE数据源");
if (hosted) {
  source = source.replace("双击即可查看 · 数据和图表已内置", "公开数据快照 · 收藏保存在当前浏览器");
  source = source.replace("需要新数据时，双击同文件夹内的“更新全球资产面板数据.command”，完成后重新打开网页。行情日期和财报日期分别标在各项数据旁。", "行情、估值和财报各按自己的数据日期展示。每天北京时间 08:00 自动采集并发布。数据源发布后才会更新对应字段，刷新页面查看最新已发布版本。");
  source = source.replace("本地数据快照 · 采集于 ", "最近采集运行 · ");
}
const result = await build({
  stdin: { contents: source, resolveDir: root, sourcefile: "offline-entry.tsx", loader: "tsx" },
  bundle: true, write: false, minify: true, jsx: "automatic", platform: "browser", target: ["chrome110", "safari16"],
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = await readFile(path.join(root, "app/globals.css"), "utf8");
const json = JSON.stringify(snapshot).replaceAll("<", "\\u003c");
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>全球资产估值观察室</title>
<style>${css}
.offline-info{border:1px solid #bdd9c9;background:#f4fbf6;border-radius:10px;padding:12px 16px;margin-top:13px;color:#254a3d}
.offline-info b{font-size:13px}.offline-info p{font-size:12px;line-height:1.65;margin-top:4px}
@media print{.refresh,.controls,.filters,.window,.star,.offline-info{display:none}.shell{padding:0}.table-wrap{max-height:none;overflow:visible}table{min-width:0;font-size:10px}th,td{padding:4px}th{position:static}.panel{break-inside:avoid}.hero{print-color-adjust:exact}.heading{padding:10px}.chart-readout{display:none}}
</style></head>
<body><div id="root"></div><noscript>请在浏览器中启用 JavaScript 以查看估值图表。</noscript>
<script id="embedded-data" type="application/json">${json}</script>
<script>${script}</script></body></html>`;
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target + ".tmp", html, "utf8");
await rename(target + ".tmp", target);
console.log(JSON.stringify({ path: target, collectedAt: snapshot.asOf, indices: catalog.length, funds: Object.keys(snapshot.funds).length, bytes: Buffer.byteLength(html) }));
