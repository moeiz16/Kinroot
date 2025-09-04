"""Remove caches and build output inside the repo (never data/, the venv or node_modules)."""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIRS = {"__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", "htmlcov"}
SKIP = {".venv", "node_modules", "data", ".git", "mlruns"}
EXTRA = [ROOT / "frontend" / "dist", ROOT / "frontend" / "node_modules" / ".vite", ROOT / "backend" / ".coverage"]


def main() -> int:
    removed = 0
    stack = [ROOT]
    while stack:
        current = stack.pop()
        for child in current.iterdir():
            if not child.is_dir() or child.is_symlink() or child.name in SKIP:
                continue
            if child.name in CACHE_DIRS:
                shutil.rmtree(child)
                removed += 1
            else:
                stack.append(child)
    for path in EXTRA:
        if path.is_dir():
            shutil.rmtree(path)
            removed += 1
        elif path.is_file():
            path.unlink()
            removed += 1
    print(f"removed {removed} cache/build paths")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
