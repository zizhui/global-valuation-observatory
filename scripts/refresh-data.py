"""Build the public baseline snapshot. Requires Python 3.10+ and xlrd."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from pathlib import Path
from time import sleep
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from zoneinfo import ZoneInfo
import argparse
import json

import xlrd

ROOT = Path(__file__).resolve().parents[1]
CSI = 'https://www.csindex.com.cn'
CNI = 'https://www.cnindex.com.cn'
MARKETS = {'Shanghai Stock Exchange': '1', 'Shenzhen Stock Exchange': '0', 'Beijing Stock Exchange': '0'}
SHANGHAI = ZoneInfo('Asia/Shanghai')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--as-of', type=date.fromisoformat, default=datetime.now(SHANGHAI).date())
parser.add_argument('--output', type=Path, default=ROOT / 'public/snapshot.json')
args = parser.parse_args()
end = args.as_of
start = date(end.year - 8, end.month, min(end.day, 28) if (end.month, end.day) == (2, 29) else end.day)
watchlist = json.loads((ROOT / 'data/watchlist.json').read_text())
previous_path = ROOT / 'offline/snapshot.json' if args.output != ROOT / 'public/snapshot.json' else ROOT / 'public/snapshot.json'
previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
fund_keys = {item['fund']: ('0.' if item['fund'].startswith('15') else '1.') + item['fund']
             for item in watchlist if item['fund']}


def get(url, params=None, binary=False):
    if params:
        url += '?' + urlencode(params)
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': url.split('/')[0] + '//' + url.split('/')[2] + '/'})
    for attempt in range(2):
        try:
            with urlopen(request, timeout=15) as response:
                return response.read() if binary else json.load(response)
        except Exception as error:
            if isinstance(error, HTTPError) and error.code in (401, 403, 429):
                raise
            if attempt:
                raise
            sleep(.5)


def safe(label, fetch, fallback):
    try:
        return fetch()
    except Exception as error:
        print(label, str(error)[:200], flush=True)
        return fallback


def iso(raw):
    return f'{raw[:4]}-{raw[4:6]}-{raw[6:]}'


def index_data(item):
    code = item['index']

    def history():
        if code == '399006':
            raw = get('https://hq.cnindex.com.cn/market/market/getIndexDailyDataWithDataFormat', {
                'indexCode': code, 'startDate': start.isoformat(), 'endDate': end.isoformat(), 'frequency': 'day'})
            rows = sorted((raw.get('data') or {}).get('data') or [])
            running = get(CNI + '/index/running', {'type': '0'})
            spot = next(row for row in running['data'] if row['indexcode'] == code)
            return [[row[0], spot['peDynamic'] if row is rows[-1] and abs(row[5] - spot['closeingPoint']) < .01 else None, row[5]]
                    for row in rows]
        reply = get(CSI + '/csindex-home/perf/index-perf', {
            'indexCode': code, 'startDate': start.strftime('%Y%m%d'), 'endDate': end.strftime('%Y%m%d')})
        rows = reply.get('data') or []
        expected = item.get('officialName')
        if rows and expected and any(row.get('indexNameCnAll') != expected for row in rows):
            raise ValueError(f'Official index name mismatch for {code}: expected {expected}')
        return sorted([iso(row['tradeDate']), row.get('peg'), row.get('close')]
                      for row in rows if row.get('tradeDate'))

    def members():
        if code == '399006':
            raw = get(CNI + '/sample-detail/detail', {
                'indexcode': code, 'dateStr': end.strftime('%Y-%m'), 'pageNum': 1, 'rows': 100})
            rows = raw['data']['rows']
            keys = sorted({'0.' + row['seccode'] for row in rows})
            if len(keys) != raw['data']['total']:
                raise ValueError('Incomplete CNI sample')
            return rows[0]['dateStr'], keys
        url = f'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/closeweight/{code}closeweight.xls'
        sheet = xlrd.open_workbook(file_contents=get(url, binary=True)).sheet_by_index(0)
        rows = [sheet.row_values(i) for i in range(1, sheet.nrows) if sheet.cell_value(i, 4)]
        keys = sorted({f'{MARKETS[row[8]]}.{str(row[4]).zfill(6)}' for row in rows if row[8] in MARKETS})
        return iso(str(rows[0][0])), keys

    prior = previous.get('indices', {}).get(code, {})
    fresh_daily = safe(f'{code} PE', history, [])
    daily = fresh_daily or prior.get('daily', [])
    member_date, basket = safe(f'{code} constituents', members, (prior.get('memberDate'), prior.get('members', [])))
    print(code, 'daily', len(daily), 'basket', len(basket), member_date, flush=True)
    return code, {'daily': daily, 'memberDate': member_date, 'members': basket,
                  'sourceNote': prior.get('sourceNote') if not fresh_daily else None}


def quote_batch(keys):
    data = get('https://push2.eastmoney.com/api/qt/ulist.np/get', {
        'secids': ','.join(keys), 'fltt': '2', 'fields': 'f12,f13,f2,f3,f6,f20,f124'})
    return {f"{row['f13']}.{row['f12']}": row for row in ((data.get('data') or {}).get('diff') or [])}


def quote_date(row):
    stamp = row.get('f124')
    return datetime.fromtimestamp(stamp, SHANGHAI).date().isoformat() if isinstance(stamp, int) and stamp else None


def numbers(row, *fields):
    return all(isinstance(row.get(field), (int, float)) for field in fields)


def finance_period(period):
    params = {
        'reportName': 'RPT_LICO_FN_CPD',
        'columns': 'SECURITY_CODE,REPORTDATE,NOTICE_DATE,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT',
        'pageNumber': 1, 'pageSize': 6000, 'sortColumns': 'SECURITY_CODE', 'sortTypes': '1',
        'filter': f"(REPORTDATE='{period}')"}
    base = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
    result = get(base, params).get('result') or {}
    rows = result.get('data') or []
    for page in range(2, (result.get('pages') or 0) + 1):
        rows.extend((get(base, {**params, 'pageNumber': page}).get('result') or {}).get('data') or [])
    print(period, 'reports', len(rows), flush=True)
    latest = {}
    for row in rows:
        notice = str(row['NOTICE_DATE'])
        if notice[:10] <= end.isoformat() and numbers(row, 'TOTAL_OPERATE_INCOME', 'PARENT_NETPROFIT'):
            code = row['SECURITY_CODE']
            if code not in latest or notice > latest[code][0]:
                latest[code] = (notice, row['TOTAL_OPERATE_INCOME'], row['PARENT_NETPROFIT'])
    return period, {code: values[1:] for code, values in latest.items()}


def ttm_parts(period):
    if period.endswith('12-31'):
        return (period,)
    year = int(period[:4]) - 1
    return f'{year}-12-31', period, f'{year}{period[4:]}'


def rollups(basket, reports, periods):
    # Use the same reporting constituents for every quarter in the comparison.
    needed = {part for period in periods for part in ttm_parts(period)}
    valid = [key[2:] for key in basket if all(key[2:] in reports[part] for part in needed)]
    if not valid:
        return None
    sums = {part: [sum(reports[part][code][column] for code in valid) for column in (0, 1)]
            for part in needed}
    series = []
    for period in periods:
        parts = ttm_parts(period)
        revenue, profit = sums[parts[0]] if len(parts) == 1 else [
            sums[parts[0]][i] + sums[parts[1]][i] - sums[parts[2]][i] for i in (0, 1)]
        series.append([period, round(revenue), round(profit)])
    return {'count': len(valid), 'series': series}


quarters = ['03-31', '06-30', '09-30', '12-31']
periods = [f'{year}-{quarter}' for year in range(end.year - 3, end.year + 1) for quarter in quarters
           if date.fromisoformat(f'{year}-{quarter}') < end][-8:]
required = sorted({part for period in periods for part in ttm_parts(period)})
with ThreadPoolExecutor(max_workers=6) as pool:
    index_jobs = [pool.submit(index_data, item) for item in watchlist]
    report_jobs = [pool.submit(safe, period, lambda p=period: finance_period(p), (period, {}))
                   for period in required]
    indices = dict(job.result() for job in index_jobs)
    securities = sorted(set(fund_keys.values()) | {key for item in indices.values() for key in item['members']})
    quotes = {}
    batches = [securities[i:i + 70] for i in range(0, len(securities), 70)]
    for batch in pool.map(lambda keys: safe('quote batch', lambda: quote_batch(keys), {}), batches):
        quotes.update(batch)
    reports = dict(job.result() for job in report_jobs)
periods = [period for period in periods if all(reports[part] for part in ttm_parts(period))]
for code, item in indices.items():
    basket = item['members']
    eligible = [quotes[key] for key in basket if key in quotes and numbers(quotes[key], 'f20', 'f124') and quote_date(quotes[key])]
    latest = max((quote_date(row) for row in eligible), default=None)
    current = [row for row in eligible if quote_date(row) == latest]
    item['cap'] = {'date': latest, 'value': sum(row['f20'] for row in current), 'count': len(current)} if current and len(current) == len(basket) else None
    item['financial'] = rollups(basket, reports, periods) if periods else None
    prior = previous.get('indices', {}).get(code, {})
    if not item['cap'] and basket == prior.get('members') and item['memberDate'] == prior.get('memberDate'):
        item['cap'] = prior.get('cap')
    if not item['financial'] and basket == prior.get('members'):
        item['financial'] = prior.get('financial')
    print(code, 'quotes', len(current), '/', len(basket), 'financial', (item['financial'] or {}).get('count'), flush=True)
funds = {code: quote for code, quote in previous.get('funds', {}).items() if code in fund_keys}
for code, key in fund_keys.items():
    row = quotes.get(key, {})
    if numbers(row, 'f20', 'f6', 'f124') and quote_date(row):
        funds[code] = {'date': quote_date(row), 'cap': row['f20'], 'turnover': row['f6'], 'price': row.get('f2'), 'change': row.get('f3')}
if not funds or not any(item['daily'] for item in indices.values()):
    raise SystemExit('Snapshot has no valuation history or no fund quotes')
snapshot = {'asOf': end.isoformat(), 'indices': indices, 'funds': funds}
target = args.output
temporary = target.with_suffix('.tmp')
temporary.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')))
temporary.replace(target)
print(target, target.stat().st_size, flush=True)
