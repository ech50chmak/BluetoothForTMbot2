#!/usr/bin/env python3
"""
Простой потребитель сетки плиток ТМ-бота.
Читает JSON, созданный BLE-шлюзом, и выводит краткую статистику.
"""

import argparse
import json
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Чтение сеток плиток от BLE-шлюза")
    parser.add_argument(
        "--path",
        default="/var/tmp/tmbot-grid.json",
        help="Путь до JSON, который обновляет шлюз",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=1.0,
        help="Период опроса файла (секунды)",
    )
    return parser.parse_args()


def format_grid_stats(grid) -> str:
    tile_sets = len(grid)
    tiles = sum(len(tile_set) for tile_set in grid)
    return f"{tile_sets} набор(ов) плиток, всего точек {tiles}"


def main() -> None:
    args = parse_args()
    grid_path = Path(args.path)
    last_hash = None

    while True:
        if grid_path.exists():
            try:
                data = json.loads(grid_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as err:
                print(f"[WARN] Повреждённый JSON: {err}")
                time.sleep(args.interval)
                continue

            grid = data.get("grid", [])
            payload_hash = data.get("hash")
            if payload_hash is None:
                payload_hash = hash(json.dumps(grid, sort_keys=True))

            if payload_hash != last_hash:
                last_hash = payload_hash
                print(
                    f"[INFO] {data.get('receivedAt', 'unknown')} -> {format_grid_stats(grid)}"
                )
        else:
            print(f"[INFO] Ожидание файла {grid_path}")

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
