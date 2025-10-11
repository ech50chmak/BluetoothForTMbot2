#!/usr/bin/env python3
"""
Send a tile grid to the TMbot BLE gateway using the bleak library.

Example:
  python3 scripts/send_grid_bleak.py --name TMbot --path ./demo-grid.json
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "12345678-1234-5678-1234-56789abc0000"
UPLOAD_CHAR_UUID = "12345678-1234-5678-1234-56789abc0001"
STATUS_CHAR_UUID = "12345678-1234-5678-1234-56789abc0002"

OPCODES = {
    "START": 0x01,
    "CHUNK": 0x02,
    "CANCEL": 0x03,
    "END": 0x04,
}

MAX_CHUNK = 180


def load_grid(args: argparse.Namespace) -> bytes:
    if args.payload:
        data = args.payload
    else:
        payload = Path(args.path).read_text(encoding="utf-8")
        data = payload
    json.loads(data)  # validate
    return data.encode("utf-8")


async def discover_device(name: str, address: str) -> str:
    if address:
        return address
    device = await BleakScanner.find_device_by_filter(
        lambda d, _: d and d.name and d.name.startswith(name)
    )
    if not device:
        raise RuntimeError(f"Failed to find device with prefix '{name}'")
    return device.address


async def send_payload(args: argparse.Namespace) -> None:
    payload = load_grid(args)
    address = await discover_device(args.name, args.address)

    print(f"[INFO] Connecting to {address}")
    async with BleakClient(address, timeout=20.0) as client:
        await client.is_connected()

        def status_handler(_, data: bytearray) -> None:
            try:
                print(f"[STATUS] {data.decode('utf-8')}")
            except UnicodeDecodeError:
                print(f"[STATUS] raw bytes: {data!r}")

        await client.start_notify(STATUS_CHAR_UUID, status_handler)

        if len(payload) <= MAX_CHUNK:
            print(f"[INFO] Sending inline payload ({len(payload)} bytes)")
            await client.write_gatt_char(
                UPLOAD_CHAR_UUID, payload, response=True
            )
        else:
            total = len(payload)
            print(f"[INFO] Sending chunked payload ({total} bytes)")
            await client.write_gatt_char(
                UPLOAD_CHAR_UUID,
                bytes([OPCODES["START"]])
                + total.to_bytes(4, byteorder="little", signed=False),
                response=True,
            )
            for offset in range(0, total, MAX_CHUNK):
                chunk = payload[offset : offset + MAX_CHUNK]
                frame = bytes([OPCODES["CHUNK"]]) + chunk
                await client.write_gatt_char(
                    UPLOAD_CHAR_UUID, frame, response=True
                )
                print(
                    f"[INFO] chunk {offset + len(chunk)}/{total} bytes sent"
                )
            await client.write_gatt_char(
                UPLOAD_CHAR_UUID, bytes([OPCODES["END"]]), response=True
            )
            print("[INFO] END frame sent")

        await asyncio.sleep(args.wait)
        await client.stop_notify(STATUS_CHAR_UUID)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send a tile grid to TMbot BLE gateway via bleak"
    )
    parser.add_argument(
        "--name",
        default="TMbot",
        help="Device name prefix to match (default: TMbot)",
    )
    parser.add_argument(
        "--address",
        default="",
        help="BLE device MAC address (skip scanning if provided)",
    )
    parser.add_argument(
        "--path",
        default="",
        help="Path to JSON payload file (ignored if --payload is set)",
    )
    parser.add_argument(
        "--payload",
        default="",
        help="Inline JSON payload string",
    )
    parser.add_argument(
        "--wait",
        type=float,
        default=2.0,
        help="Seconds to wait for status notifications before disconnecting",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> None:
    args = parse_args(argv)
    if not args.payload and not args.path:
        args.payload = json.dumps([[[0, 0], [1, 0], [2, 0]], [[3, 1], [3, 2]]])
    asyncio.run(send_payload(args))


if __name__ == "__main__":
    main(sys.argv[1:])
