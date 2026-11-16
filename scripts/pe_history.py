"""Attach the provider's original index PE observations to price data."""
from datetime import datetime
from pathlib import Path
from statistics import median
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo
import json
import math

CODES = {'HSTECH': 'HKHSTECH', 'NDX': 'NDX', 'SP500': 'SP500'}
SHANGHAI = ZoneInfo('Asia/Shanghai')


def attach_pe_history(indices, cache=None):
    today = datetime.now(SHANGHAI).date().isoformat()
    for code, provider_code in CODES.items():
        if code not in indices:
            continue
        url = f'https://danjuanfunds.com/djapi/index_eva/pe_history/{provider_code}?day=all'
        try:
            if cache:
                raw = (Path(cache) / f'etf-pe-{provider_code}.json').read_bytes()
            else:
                request = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://danjuanfunds.com/'})
                with urlopen(request, timeout=20) as response:
                    raw = response.read()
            reply = json.loads(raw)
            if reply.get('result_code') != 0:
                raise ValueError('Provider rejected historical data')
            observations = {}
            for row in reply.get('data', {}).get('index_eva_pe_growths', []):
                value = row.get('pe')
                stamp = row.get('ts')
                if not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
                    continue
                if not isinstance(stamp, (float, int)):
                    continue
                date = datetime.fromtimestamp(stamp / 1000, SHANGHAI).date().isoformat()
                if date > today or (code == 'HSTECH' and date < '2020-07-27'):
                    continue
                observations[date] = value
            if len(observations) < 20:
                raise ValueError('Fewer than 20 valid historical observations')
            item = indices[code]
            # Keep price dates and original PE dates separate. Do not interpolate PE.
            points = {row[0]: [row[0], None, row[2]] for row in item['daily']}
            for date, value in observations.items():
                points.setdefault(date, [date, None, None])[1] = value
            dates = sorted(observations)
            gaps = [(datetime.fromisoformat(b) - datetime.fromisoformat(a)).days for a, b in zip(dates, dates[1:])]
            cadence = '周频为主，保留原始观察日期' if median(gaps) >= 5 else '按来源原始观察日期'
            item['daily'] = sorted(points.values())
            item['peSourceUrl'] = url
            item['peSourceId'] = 'danjuan:' + provider_code
            item['peSampleCadence'] = cadence
            item['peFirstDate'] = dates[0]
            item['peLastDate'] = dates[-1]
            item['sourceNote'] = (
                f'历史 PE 统一采用蛋卷基金指数估值口径，{cadence}，'
                f'共 {len(dates)} 个正值样本，覆盖 {dates[0]} 至 {dates[-1]}。'
                '按所选窗口计算算术均值和正负一个总体标准差，PE 与价格各按自己的数据日期展示。'
            )
            if code == 'HSTECH':
                item.setdefault('officialPESnapshot', {
                    'date': '2026-10-30', 'value': 25.43,
                    'url': 'https://www.hsi.com.hk/static/uploads/contents/en/dl_centre/factsheets/hsteche.pdf'})
                item['sourceNote'] += '恒生指数公司月报 PE 另列供核对；历史窗口最长覆盖自2020年7月推出以来。'
            print(code, 'PE', dates[-1], observations[dates[-1]], 'samples', len(dates), flush=True)
        except Exception as error:
            print(code, 'PE history unavailable, retained prior values:', str(error), flush=True)
