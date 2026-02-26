from __future__ import annotations

import sys
from pathlib import Path

# Ensure `ai_writer_api` is importable when running pytest via the venv entrypoint.
API_ROOT = Path(__file__).resolve().parent
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

