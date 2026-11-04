"""Take or reuse a consistent read-only source snapshot for a new pair run."""
from pathlib import Path
import os,sqlite3
root=Path(os.environ.get('TK_PAIR_DIR','data/narrative-model/matter-pairs-2026-11-04'));root.mkdir(parents=True,exist_ok=True);os.chmod(root,0o700)
if (root/'source.db').exists():print('Using existing snapshot:',root/'source.db')
else:
 source=Path(os.environ.get('TK_DB_PATH','data/timekeeper.db')).resolve()
 with sqlite3.connect(f'file:{source}?mode=ro',uri=True) as src:
  with sqlite3.connect(root/'source.db') as dst:
   src.backup(dst);assert dst.execute('pragma integrity_check').fetchone()[0]=='ok'
 print('Snapshot saved:',root/'source.db')
