#!/usr/bin/python3
"""GUI entry point. Relative imports work from source and installed bundles."""
from pathlib import Path
import sys

# -I deliberately excludes the script directory from sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

if __name__ == "__main__":
    from setup.gui import main
    raise SystemExit(main())
