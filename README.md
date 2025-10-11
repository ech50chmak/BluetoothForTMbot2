# TM Grid Gateway

Node.js BLE gateway for Raspberry Pi 4 inspired by `balena-web-ble`. The gateway exposes a Web Bluetooth friendly GATT service (`TMGridService`) that accepts tile-grid JSON payloads from a browser, saves them safely on the Pi, optionally triggers an external command, and streams status/telemetry to subscribers.

## Features

- `TMGridService` (UUID `12345678-1234-5678-1234-56789abc0000`) publishes:
  - `GridUploadCharacteristic` (`write`, `writeWithoutResponse`, UUID `...0001`) with chunked and inline JSON support.
  - `GridStatusCharacteristic` (`read`, `notify`, UUID `...0002`) providing ok/error flags, progress, hashes, command results.
- START/CHUNK/CANCEL framing with length validation (`MAX_CHUNK = 180`) plus automatic inline fallback for small payloads.
- Atomic file writes to `GRID_PAYLOAD_PATH` via temporary files to prevent partial reads.
- Optional `GRID_COMMAND` + `GRID_COMMAND_ARGS` execution after a successful upload, with exit-code tracking in status.
- Centralised `GridState` (ES6 class) that validates payloads, enforces size limits, stores snapshots, and broadcasts updates.
- Example Web Bluetooth client (`web/`) and Python consumer, smoke test script, and BLE debug checklist.

## Repository layout

```
src/
  index.js                  # bleno bootstrap and graceful shutdown handling
  services/grid-service.js  # PrimaryService subclass wiring upload/status characteristics
  characteristics/          # ES6 classes for GATT characteristics
  state/grid-state.js       # shared state, validation, file persistence, command runner
  uuids.js                  # shared UUID constants
web/
  index.html, grid-client.js
scripts/
  smoke-test.js, grid_consumer.py, adv-check.md
```

## Raspberry Pi setup

```bash
sudo apt update
sudo apt install -y bluetooth bluez nodejs npm python3
sudo systemctl enable --now bluetooth
sudo setcap cap_net_raw+eip "$(readlink -f "$(which node)")"
```

> If you require exclusive control over the adapter, stop `bluetooth.service` before starting the gateway. See `scripts/adv-check.md` for debugging hints with `btmon` and `bluetoothctl`.

## Install & run

```bash
git clone https://github.com/ech50chmak/BluetoothForTMbot2.git
cd BluetoothForTMbot2
npm install
```

Environment variables:

| Variable             | Purpose                                                   | Default                      |
| -------------------- | --------------------------------------------------------- | ---------------------------- |
| `BLE_DEVICE_NAME`    | Device name advertised to Web Bluetooth clients           | `TMbot`                      |
| `BLENO_HCI_DEVICE_ID`| HCI adapter index                                         | `0`                          |
| `GRID_PAYLOAD_PATH`  | Path to store the latest grid JSON                        | `/var/tmp/tmbot-grid.json`   |
| `GRID_MAX_BYTES`     | Maximum accepted payload size (bytes)                     | `1048576` (1 MiB)            |
| `GRID_COMMAND`       | Optional command executed after a successful upload       | -                            |
| `GRID_COMMAND_ARGS`  | Command arguments (JSON array or whitespace/comma list)   | -                            |

Example:

```bash
BLE_DEVICE_NAME="TMbotGrid" \
GRID_COMMAND="/usr/bin/python3" \
GRID_COMMAND_ARGS='["/home/pi/robot/on_grid.py","--once"]' \
npm start
```

Logs announce adapter state transitions, advertising, and client connects/disconnects.

## Payload format

Browsers send a JSON array of tile sets. Each tile is a two-element `[x, y]` coordinate:

```json
[
  [[0, 0], [1, 0], [2, 0]],
  [[3, 1], [3, 2]]
]
```

The gateway serialises payloads to `GRID_PAYLOAD_PATH` as:

```json
{
  "receivedAt": "2025-10-09T14:00:00.000Z",
  "grid": [...],
  "hash": "4e18c5...",
  "bytes": 128
}
```

## Web Bluetooth client

`web/grid-client.js` exposes `sendTileGrid(grid, options)`. The helper automatically selects inline vs START/CHUNK frames, subscribes to status notifications, and disconnects gracefully. Serve `web/index.html` over HTTPS (or use `localhost`) in Chrome/Edge/Brave with Bluetooth and location enabled.

Key options:

- `namePrefix` - filter for `navigator.bluetooth.requestDevice`.
- `onStatus` - callback receiving parsed status updates.
- `awaitStable` - optional delay (ms) before disconnecting to let notifications flush.

## Local tooling

- `npm test` runs `scripts/smoke-test.js`, which validates state handling and confirms file creation.
- `python3 scripts/grid_consumer.py --path /var/tmp/tmbot-grid.json` displays new grids as they arrive.
- `scripts/adv-check.md` covers btmon capture, adapter inspection, and common error remedies.

## Shutdown

Press `Ctrl+C` (SIGINT) to stop advertising and disconnect clients cleanly.

## License

Apache-2.0 - compatible with the upstream `balena-web-ble` example.


