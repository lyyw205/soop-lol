"""Compare unchanged result outputs and wall time using local sheets only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
vod = sys.argv[1] if len(sys.argv) > 1 else '208295391'
base = ROOT/'out/ck-memo-training/activation'/vod
base.mkdir(parents=True, exist_ok=True)
raw = (ROOT/f'out/ck/{vod}/local/sheets.json').read_bytes()
env = {**os.environ, 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2',
       'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}
rows = []
for mode in ['legacy', 'on', 'off', 'on']:
    directory = base/f'{len(rows)}-{mode}'; directory.mkdir(exist_ok=True)
    meta = directory/'sheets.json'; meta.write_bytes(raw)
    if mode == 'legacy':
        code = "import sys;from pathlib import Path;sys.argv=['detect.py','--meta',sys.argv[1]];p='scripts/ck-local/detector/detect.py';exec(compile(Path('out/ck-memo-training/detect-before.py').read_text(),p,'exec'),{'__name__':'__main__','__file__':p})"
        command = [sys.executable, '-c', code, str(meta)]
    else:
        command = [sys.executable, 'scripts/ck-local/detector/detect.py', '--meta', str(meta), '--memo', mode]
    start = time.perf_counter()
    result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True)
    (directory/'stderr.log').write_text(result.stderr)
    result.check_returncode()
    elapsed = time.perf_counter()-start
    output = json.loads(result.stdout)
    (directory/'result.json').write_text(json.dumps(output))
    (directory/'stderr.log').write_text(result.stderr)
    if rows: assert output == baseline, 'Result detection changed'
    else: baseline = output
    report = json.loads((directory/'memo-run.json').read_text()) if mode != 'legacy' else None
    row = {'mode': mode, 'wall_seconds': elapsed, 'memo': report}
    rows.append(row)
    (base/'report.json').write_text(json.dumps(rows, indent=2))
    print(json.dumps(row), flush=True)
print('All result outputs identical', flush=True)
