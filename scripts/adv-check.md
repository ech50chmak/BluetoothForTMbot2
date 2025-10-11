# Bluetooth Advertising / Debug Checklist

## Quick sanity check

1. Stop `bluetooth.service` if you need exclusive control, otherwise leave it running.
2. Bring the adapter up: `sudo hciconfig hci0 up`.
3. Start the gateway (`npm start`) and watch the logs.
4. In another shell inspect the adapter state:
   ```bash
   bluetoothctl show
   ```
   Ensure `Powered: yes` is reported.

## Capture with btmon

```bash
sudo btmon --write capture.btsnoop
```

Look for `LE Advertising Report` entries containing your `BLE_DEVICE_NAME`. The `capture.btsnoop` file can be opened in Wireshark for offline analysis.

## Web Bluetooth tips

- Enable Bluetooth and location services on Android or ChromeOS before connecting.
- Use Chrome/Edge/Brave on desktop or Android; navigate to your page over HTTPS (or `http://localhost`).
- Open DevTools and monitor the console for characteristic interactions and errors.

## Common issues

| Symptom                                      | Fix                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `Error: EBUSY, Device or resource busy`     | Stop `bluetoothd`, close `bluetoothctl`, and restart the gateway    |
| `Class constructor ... without 'new'`       | Ensure characteristics and services use `class extends ...` syntax  |
| Device not visible during scan              | Check `bluetoothctl show`, verify advertising is started            |
| Frequent disconnects                        | Reduce distance, remove interference, inspect logs via `btmon`      |

## Useful links

- Web Bluetooth samples: https://googlechrome.github.io/samples/web-bluetooth/
- @abandonware/bleno docs: https://github.com/abandonware/bleno
