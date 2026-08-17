#!/usr/bin/env python3
#
# download_icons.py — fetch every icon URL a get_figma_data(downloadIcons: true)
# response stamped on its nodes, and save each as a correctly-named PDF.
#
# Writing this by hand (walk the tree, fetch each URL, name the file) is easy
# to get subtly wrong — dropping the real Figma name, wrong extension, silently
# clobbering two icons that share a name. This script does it once, correctly.
#
# Usage:
#   <icons JSON> | python3 download_icons.py <output-dir>          # stdin
#   python3 download_icons.py <output-dir> <icons.json>            # file
#
#   <output-dir>  directory to save the .pdf files into (created if needed).
#   <icons.json>  a JSON array of {"name": ..., "url": ...} — one entry per
#                 icon, taken directly from each node's `name` + `icon` field
#                 in the fetched tree. Do not invent or alter the name.
#
# Requires python3 only (stdlib) — no pip install, no jq.

import json
import re
import sys
import urllib.request
from pathlib import Path


def slug(name):
    s = re.sub(r"[^a-zA-Z0-9]+", "_", name or "icon").strip("_")
    return s or "icon"


def main():
    if len(sys.argv) < 2:
        print("usage: download_icons.py <output-dir> [icons.json]", file=sys.stderr)
        sys.exit(1)

    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)

    raw = Path(sys.argv[2]).read_text() if len(sys.argv) >= 3 else sys.stdin.read()
    icons = json.loads(raw)

    seen = {}
    saved = 0
    for icon in icons:
        name, url = icon.get("name"), icon.get("url")
        if not url:
            continue
        base = slug(name)
        n = seen.get(base, 0)
        seen[base] = n + 1
        filename = f"{base}.pdf" if n == 0 else f"{base}_{n}.pdf"
        try:
            with urllib.request.urlopen(url) as resp:
                data = resp.read()
            (out_dir / filename).write_bytes(data)
            saved += 1
            print(f"saved {filename}")
        except Exception as e:
            print(f"FAILED {name!r}: {e}", file=sys.stderr)

    print(f"\n{saved}/{len(icons)} icons saved to {out_dir}")


if __name__ == "__main__":
    main()
