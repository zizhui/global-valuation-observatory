"""Run public data collectors and retain validated records on partial failures."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(script, *args):
    result = subprocess.run([sys.executable, str(ROOT / 'scripts' / script), *args], cwd=ROOT, timeout=900)
    if result.returncode:
        print(f'::warning::{script} failed; retaining prior data where available.')
    return result.returncode == 0


previous_path = ROOT / 'offline/snapshot.json'
previous = json.loads(previous_path.read_text())
with tempfile.TemporaryDirectory() as temporary:
    candidate_path = Path(temporary) / 'snapshot.json'
    if run('refresh-data.py', '--output', str(candidate_path)):
        candidate = json.loads(candidate_path.read_text())
        watchlist = json.loads((ROOT / 'data/watchlist.json').read_text())
        for item in watchlist:
            code = item['index']
            row = candidate.get('indices', {}).get(code, {})
            valid = (row.get('daily') and row.get('members')
                     and (row.get('financial') or row.get('sourceNote')))
            if not valid:
                print(f'::warning::{code}: incomplete record; retaining previous dated snapshot.')
                candidate['indices'][code] = previous['indices'][code]
        staged = previous_path.with_suffix('.tmp')
        staged.write_text(json.dumps(candidate, ensure_ascii=False, separators=(',', ':')))
        staged.replace(previous_path)

run('refresh-global-data.py')
environment = {**os.environ, 'FINANCE_HTML_OUTPUT': str(ROOT / 'dist/index.html')}
subprocess.run(['npm', 'run', 'build'], cwd=ROOT, env=environment, check=True, timeout=120)
shutil.copyfile(ROOT / 'dist/index.html', ROOT / 'index.html')
print('Validated and built the public snapshot.')
