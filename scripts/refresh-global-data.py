"""Refresh public cross-market prices and Hang Seng's dated monthly valuation."""
from datetime import datetime
from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo
import argparse
import json
import re

from pypdf import PdfReader
from pe_history import attach_pe_history

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cache', type=Path)
args = parser.parse_args()
today = datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
target = ROOT / 'offline/global-snapshot.json'
previous = json.loads(target.read_text()) if target.exists() else {}
indices = dict(previous.get('indices', {}))
urls = {}


def fetch(url, cache_name):
    if args.cache:
        return (args.cache / ('etf-global-' + cache_name)).read_bytes()
    with urlopen(Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=20) as response:
        return response.read()


def base(daily, source, note):
    return {'daily': daily, 'memberDate': None, 'members': [], 'cap': None,
            'financial': None, 'sourceUrl': source, 'sourceNote': note}


class GoldTable(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cell = None
        self.row = []
        self.data = []

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self.row = []
        if tag == 'td':
            self.cell = ''

    def handle_data(self, text):
        if self.cell is not None:
            self.cell += text

    def handle_endtag(self, tag):
        if tag == 'td':
            self.row.append(self.cell.strip())
            self.cell = None
        if tag == 'tr' and len(self.row) >= 6 and self.row[1] == 'Au99.99':
            try:
                self.data.append([self.row[0], None, float(self.row[5])])
            except ValueError:
                pass


for key, symbol, cache in [('NDX', '^NDX', 'ndx'), ('SP500', '^GSPC', 'sp500'), ('HSTECH', 'HSTECH.HK', 'hstech')]:
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + quote(symbol, safe='') + '?range=10y&interval=1d'
    try:
        raw = json.loads(fetch(url, cache + '.raw'))['chart']['result'][0]
        if raw['meta']['symbol'] != symbol:
            raise ValueError('Unexpected symbol')
        zone = ZoneInfo(raw['meta']['exchangeTimezoneName'])
        closes = raw['indicators']['quote'][0]['close']
        daily = [[datetime.fromtimestamp(stamp, zone).date().isoformat(), None, close]
                 for stamp, close in zip(raw['timestamp'], closes) if isinstance(close, (int, float)) and close > 0]
        daily = sorted(row for row in daily if row[0] <= today)
        if not daily:
            raise ValueError('No prices')
        saved_pe = {row[0]: row[1] for row in indices.get(key, {}).get('daily', []) if row[1] is not None}
        price_days = {row[0]: row for row in daily}
        for pe_date, pe_value in saved_pe.items():
            price_days.setdefault(pe_date, [pe_date, None, None])[1] = pe_value
        previous_meta = {field: value for field, value in indices.get(key, {}).items() if field.startswith('pe') or field in ('sourceNote', 'officialPESnapshot')}
        indices[key] = base(sorted(price_days.values()), 'https://finance.yahoo.com/quote/' + quote(symbol, safe='') + '/history/',
                            '价格来自 Yahoo Finance，按当地交易日展示。指数 PE 历史尚未核实，估值参考线暂缺。')
        indices[key].update(previous_meta)
        print(key, daily[-1][0], round(daily[-1][2], 2), len(daily), flush=True)
    except Exception as error:
        print(key, str(error), 'preserving previous data', flush=True)

gold_url = 'https://www.sge.com.cn/h5_sjzx/quotationdailynew?' + urlencode({
    'start_date': today[:7] + '-01', 'end_date': today, 'inst_ids': 'Au99.99'})
try:
    table = GoldTable()
    table.feed(fetch(gold_url, 'gold.raw').decode('utf-8'))
    if not table.data:
        raise ValueError('No gold rows')
    merged = {row[0]: row for row in indices.get('AU9999', {}).get('daily', [])}
    merged.update({row[0]: row for row in table.data})
    indices['AU9999'] = base(sorted(merged.values()), gold_url,
        '上海黄金交易所 Au99.99 收盘价，人民币元/克。黄金无公司盈利，PE 不适用。价格历史从本地采集开始积累，当前仅含已采集日期。')
    print('AU9999', indices['AU9999']['daily'][-1], flush=True)
except Exception as error:
    print('AU9999', str(error), 'preserving previous data', flush=True)

hsi_url = 'https://www.hsi.com.hk/static/uploads/contents/en/dl_centre/factsheets/hsteche.pdf'
try:
    text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(fetch(hsi_url, 'hstechpdf.pdf'))).pages)
    date_match = re.search(r'All data as at (\d{1,2} [A-Za-z]{3} \d{4})', text)
    fundamentals = text.split('INDEX FUNDAMENTALS', 1)[1].split('CORRELATION', 1)[0]
    pe = float(re.search(r'HSTECH\s+[\d.]+\s+([\d.]+)', fundamentals)[1])
    date = datetime.strptime(date_match[1], '%d %b %Y').date().isoformat()
    prior = indices.get('HSTECH')
    if not prior:
        level = float(re.search(r'HSTECH\s+([\d,.]+)', text.split('INDEX PERFORMANCE', 1)[1])[1].replace(',', ''))
        prior = base([[date, None, level]], hsi_url, '')
        indices['HSTECH'] = prior
    points = {row[0]: row for row in prior['daily']}
    row = points.setdefault(date, [date, None, None])
    if not prior.get('peSourceId'):
        row[1] = pe
    prior['daily'] = sorted(points.values())
    prior['officialPESnapshot'] = {'date': date, 'value': pe, 'url': hsi_url}
    if not prior.get('peSourceId'):
        prior['sourceNote'] = '指数价格来源与日期见表格及数据出处；PE 为恒生指数公司月报公布值（' + date + '），口径以官方定义为准。历史 PE 样本不足，暂不计算估值参考线。'
    if not prior.get('peSourceId'):
        prior['peSourceUrl'] = hsi_url
    print('HSTECH official PE', date, pe, flush=True)
except Exception as error:
    print('HSTECH monthly PE', str(error), flush=True)

attach_pe_history(indices, args.cache)

expected = {'AU9999', 'HSTECH', 'NDX', 'SP500'}
if not expected.issubset(indices):
    raise SystemExit('Cross-market data incomplete')
output = {'asOf': today, 'indices': indices}
temporary = target.with_suffix('.tmp')
temporary.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')))
temporary.replace(target)
