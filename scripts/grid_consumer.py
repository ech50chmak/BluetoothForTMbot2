#!/usr/bin/env python3
"""
Simple polling consumer for TM-bot grid payloads.
Reads the JSON file produced by the BLE gateway and prints basic stats.
"""

import argparse
import json
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Monitor grid updates saved by the BLE gateway"
    )
    parser.add_argument(
        "--path",
        default="/var/tmp/tmbot-grid.json",
        help="Path to the JSON file written by the gateway",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=1.0,
        help="Polling interval in seconds",
    )
    return parser.parse_args()


def format_stats(grid) -> str:
    tile_sets = len(grid)
    tiles = sum(len(tile_set) for tile_set in grid)
    return f"{tile_sets} tile set(s), {tiles} points total"


def main() -> None:
    args = parse_args()
    grid_path = Path(args.path)
    last_hash = None

    while True:
        if grid_path.exists():
            try:
                data = json.loads(grid_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as err:
                print(f"[WARN] Invalid JSON: {err}")
                time.sleep(args.interval)
                continue

            grid = data.get("grid", [])
            payload_hash = data.get("hash") or hash(json.dumps(grid, sort_keys=True))

            if payload_hash != last_hash:
                last_hash = payload_hash
                received_at = data.get("receivedAt", "unknown")
                bytes_count = data.get("bytes", "n/a")
                print(f"[INFO] {received_at} -> {format_stats(grid)} ({bytes_count} bytes)")
        else:
            print(f"[INFO] Waiting for {grid_path}")

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
