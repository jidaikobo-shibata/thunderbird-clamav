#!/usr/bin/python3
"""Dependency-free syntax checks; does not reformat or import project code."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    files = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
    ).decode().split("\0")
    checked = 0
    for name in sorted(set(files)):
        source = ROOT / name
        if not source.is_file():
            continue
        if source.suffix == ".py":
            compile(source.read_bytes(), name, "exec")
        elif source.suffix in {".js", ".mjs"}:
            subprocess.run(["node", "--check", str(source)], check=True)
        elif source.suffix == ".json":
            json.loads(source.read_text())
        else:
            continue
        checked += 1
    print(f"Syntax checks passed: {checked} files (Python, JavaScript, JSON)")


if __name__ == "__main__":
    main()
