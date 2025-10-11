# TM Grid Gateway

BLE-шлюз для Raspberry Pi 4, построенный на основе идей проекта [balena-web-ble](https://github.com/balena-io-experimental/balena-web-ble). Шлюз позволяет получать из браузера массив точек плиток (`grid[tileSet][index][x|y]`) через Web Bluetooth и передавать их в управляющую программу TM-бота.

## Возможности

- **BLE GATT сервис** `TMGridService` c характеристиками загрузки (`write/notify`) и статуса (`read/notify`).
- **Фреймированная передача JSON** с контролем длины и уведомлениями о прогрессе.
- **Автосохранение** последнего маршрута в файл (`/var/tmp/tmbot-grid.json` по умолчанию).
- **Опциональный запуск команды** после новой сетки (например, запуск вашего Python-планировщика).
- **Web-клиент** на чистом JS для отправки сетки с телефона или ноутбука через Web Bluetooth.

## Структура

```
src/
 ├─ index.js                    # точка входа BLE-периферии
 ├─ services/grid-service.js    # определение GATT-службы
 ├─ characteristics/…           # write/read характеристики
 └─ robot/grid-bridge.js        # мост к файловой системе и внешней команде
web/
 ├─ index.html                  # простое UI для отправки сетки
 └─ grid-client.js              # Web Bluetooth клиент
scripts/grid_consumer.py        # пример чтения сохранённой сетки
```

## Подготовка Raspberry Pi 4

```bash
sudo apt update
sudo apt install -y bluetooth bluez nodejs npm python3
sudo systemctl enable --now bluetooth
sudo setcap cap_net_raw+eip $(readlink -f "$(which node)")
```

1. Скопируйте проект на Raspberry Pi.
2. Установите зависимости: `npm install`.
3. (Опционально) Установите balena CLI, если планируете деплой через balenaCloud.

## Запуск BLE-сервиса

```bash
BLENO_HCI_DEVICE_ID=0 \
BLE_DEVICE_NAME=TMbotGrid \
GRID_PAYLOAD_PATH=/var/tmp/tmbot-grid.json \
GRID_COMMAND="/usr/bin/python3" \
GRID_COMMAND_ARGS='["/home/pi/robot/on_grid.py"]' \
npm start
```

Переменные окружения:

- `BLENO_HCI_DEVICE_ID` — используемый адаптер (обычно `0`).
- `BLE_DEVICE_NAME` — имя, отображаемое в браузере.
- `GRID_PAYLOAD_PATH` — путь, куда писать JSON.
- `GRID_COMMAND` / `GRID_COMMAND_ARGS` — внешняя команда после обновления данных.

## Формат JSON

```json
[
  [[0, 0], [1, 0], [2, 0]],
  [[3, 1], [3, 2]]
]
```

Произвольное количество наборов плиток, каждая точка — пара `x, y` в абсолютных координатах.

## Web Bluetooth клиент

1. Включите Bluetooth и геолокацию на Android или ноутбуке (Chrome, Edge, Brave).
2. Откройте `web/index.html` локально либо разместите на сервере (HTTPS обязателен, кроме `localhost`).
3. Вставьте JSON сетки и нажмите кнопку отправки. Статус BLE-шлюза отображается в правом блоке.

`web/grid-client.js` можно переиспользовать в существующем сайте: импортируйте `sendTileGrid()` и передавайте структуру сетки.

## Python-консьюмер (пример)

```bash
python3 scripts/grid_consumer.py --path /var/tmp/tmbot-grid.json
```

Скрипт отслеживает изменения файла и выводит количество плиток. Замените на вызов вашего контроллера движения.

## Подсказки по диагностике

- Проверить адаптер: `bluetoothctl show`.
- Сканировать рекламу: `bluetoothctl scan on`.
- Проверить логи сервиса: `journalctl -u tm-grid-gateway.service -f` (если обёрнут в systemd).
- При ошибках передачи проверяйте `lastError` через статус-характеристику (видна в Web UI).

## Лицензия

Apache-2.0, как и оригинальный пример balena-web-ble.
