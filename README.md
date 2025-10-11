# TM Grid Gateway

Node.js BLE gateway for Raspberry Pi 4 inspired by `balena-web-ble`. The gateway exposes a Web Bluetooth friendly GATT service (`TMGridService`) that accepts tile-grid JSON payloads from a browser, saves them safely on the Pi, optionally triggers an external command, and streams status/telemetry to subscribers.

## Features

- `TMGridService` (UUID `12345678-1234-5678-1234-56789abc0000`) publishes:
  - `GridUploadCharacteristic` (`write`, UUID `...0001`) with write-with-response, START/CHUNK/END framing, inactivity timeout, and verbose logging.
- `GridStatusCharacteristic` (`read`, `notify`, UUID `...0002`) that streams status snapshots using framed 20-byte notifications (START/CONT/END) so browsers with small MTU stay happy.
- Status snapshots now expose `lastFrameType`, `lastChunkLen`, and `lastSeq` to ease debugging of active transfers.
- START/CHUNK/END protocol sized for ATT MTU 23 (20-byte writes): 1-byte opcode + ≤19-byte payload chunks, optional inline mode for very small payloads.
- Atomic file writes to `GRID_PAYLOAD_PATH` via temporary files to prevent partial reads.
- Optional `GRID_COMMAND` + `GRID_COMMAND_ARGS` execution after a successful upload, with exit-code tracking in status.
- Centralised `GridState` (ES6 class) that validates payloads, enforces size limits, stores snapshots, logs every transition, and broadcasts updates.
- Example Web Bluetooth client (`web/`), bleak sender, smoke test script, and BLE debug checklist.

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
  smoke-test.js, grid_consumer.py, send_grid_bleak.py, adv-check.md
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
| `GRID_TRANSFER_TIMEOUT_MS` | Transfer inactivity timeout before reset (ms)         | `30000`                      |
| `GRID_CHUNK_MAX`   | Maximum accepted chunk payload size (bytes, excludes opcode) | `19`                         |

Chunked transfers default to 20-byte writes (ATT MTU 23): 1-byte frame header + ≤19-byte payload. Adjust `GRID_CHUNK_MAX` (payload portion) if your adapter negotiates a larger MTU, keeping client and server in sync.

## BLE framing limits

- `ATT_MTU = 23` ⇒ `MAX_WRITE_BYTES = 20` usable bytes in a single GATT write (`writeValueWithResponse`).
- Upload frames reserve `PROTO_OVERHEAD = 1` byte for the opcode (`START`, `CHUNK`, `END`, `CANCEL`).
- `MAX_CHUNK_PAYLOAD = MAX_WRITE_BYTES - PROTO_OVERHEAD = 19` bytes. The browser client and server both enforce this budget.

Example: JSON payload `[[[0,0],[0,0]],[[0,0],[0,0]]]` encodes to 27 bytes. The client sends:

1. `START` frame (5 bytes: opcode + little-endian length).
2. `CHUNK#0` (1-byte opcode + 19-byte payload slice).
3. `CHUNK#1` (1-byte opcode + 8-byte payload slice).
4. `END` (1 byte).

If you extend the header (e.g. add sequence or checksum fields), subtract that extra overhead from `MAX_CHUNK_PAYLOAD` and update `GRID_CHUNK_MAX` accordingly so writes stay ≤20 bytes.

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

Serve `web/index.html` over HTTPS (or `http://localhost`) in Chrome/Edge/Brave with Bluetooth and location enabled. The page offers:

- **Connect** - pairs and subscribes to the status characteristic (log output + live JSON in the UI).
- **Send (inline)** - writes a single frame using `writeValueWithResponse`. Recommended for payloads <= 100 bytes.
- **Send (chunked)** - always uses START/CHUNK/END frames (20-byte writes: 1-byte opcode + ≤19-byte payload) with exponential retry on transient errors.
- During transfers status notifications are paused and resumed to avoid parallel GATT operations.
- Status updates arrive as START/CONT/END frames and are reassembled in the browser before parsing, following the same pattern as Nordic UART / Web Bluetooth console samples.

The underlying helper is exposed via `setupClient` in `web/grid-client.js`. In DevTools you can call:

```js
await tmBle.connect();
await tmBle.sendInline([[ [0,0], [1,0] ]]);
await tmBle.sendChunked(bigGrid);
```

`tmBle.sendRawString("...")` is also available for debugging raw payloads.

## CLI / automated checks

- `npm run smoke` executes `scripts/smoke-test.js` (state validation without BLE).
- `python3 scripts/send_grid_bleak.py --name TMbot --path sample.json` (requires `pip install bleak`) pushes a payload via bleak using START/CHUNK/END frames with write-with-response.
- `python3 scripts/grid_consumer.py --path /var/tmp/tmbot-grid.json` tails the saved grid file.
- `scripts/adv-check.md` documents btmon/btctl commands and typical BLE pitfalls.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `GATT operation failed for unknown reason` | Ensure the client uses `writeValueWithResponse` (inline button or bleak script). Retry with chunked mode; Chrome on Windows occasionally needs a reconnect. |
| Transfer stops at START/first CHUNK | Check server logs for `Transfer timed out` or length mismatch. Verify the END frame is sent and total size <= `GRID_MAX_BYTES`. |
| Browser disconnects after 15 seconds | Idle timeout is triggered. Send the next CHUNK within 20 seconds or re-start with a new START frame. |
| No file written to `GRID_PAYLOAD_PATH` | Inspect status notifications (`lastError`, `lastMessage`). Confirm the service has write permissions to the target path. |
| Command exits with non-zero code | Review `lastCommand.code` in status and the process output in server logs. |

## References

- Google Web Bluetooth samples (UART console, write-with-response patterns).
- @abandonware/bleno discussion threads on MTU-sized notifications and chunking strategies.
- Nordic nRF UART service approach for framing data over BLE characteristics.

## Shutdown

Press `Ctrl+C` (SIGINT) to stop advertising and disconnect clients cleanly.

## License

Apache-2.0 - compatible with the upstream `balena-web-ble` example.
