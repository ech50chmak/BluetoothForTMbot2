const SERVICE_UUID = '13371337-0000-4000-8000-133713371337';
const UPLOAD_CHAR_UUID = '13371337-0000-4000-8000-133713371338';
const STATUS_CHAR_UUID = '13371337-0000-4000-8000-133713371339';

const OPCODES = {
  START: 0x01,
  CHUNK: 0x02,
  CANCEL: 0x03
};

const MAX_CHUNK = 180;

async function subscribeStatus(characteristic, onMessage) {
  await characteristic.startNotifications();
  characteristic.addEventListener('characteristicvaluechanged', event => {
    const text = new TextDecoder().decode(event.target.value);
    if (onMessage) {
      onMessage(JSON.parse(text));
    }
  });
  const initial = await characteristic.readValue();
  const initialText = new TextDecoder().decode(initial);
  if (onMessage) {
    onMessage(JSON.parse(initialText));
  }
}

async function writeChunked(characteristic, payload) {
  const startFrame = new Uint8Array(5);
  const startView = new DataView(startFrame.buffer);
  startFrame[0] = OPCODES.START;
  startView.setUint32(1, payload.length, true);
  await characteristic.writeValue(startFrame);

  for (let offset = 0; offset < payload.length; offset += MAX_CHUNK) {
    const chunk = payload.subarray(offset, offset + MAX_CHUNK);
    const frame = new Uint8Array(chunk.length + 1);
    frame[0] = OPCODES.CHUNK;
    frame.set(chunk, 1);
    await characteristic.writeValue(frame);
  }
}

export async function sendTileGrid(grid, options = {}) {
  if (!navigator.bluetooth) {
    throw new Error('Web Bluetooth API не поддерживается браузером');
  }

  const encoder = new TextEncoder();
  const serialized = JSON.stringify(grid);
  const payload = encoder.encode(serialized);

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: options.namePrefix || 'TMbot' }],
    optionalServices: [SERVICE_UUID]
  });

  const server = await device.gatt.connect();
  try {
    const service = await server.getPrimaryService(SERVICE_UUID);
    const uploadCharacteristic = await service.getCharacteristic(UPLOAD_CHAR_UUID);
    const statusCharacteristic = await service.getCharacteristic(STATUS_CHAR_UUID);

    if (options.onStatus) {
      await subscribeStatus(statusCharacteristic, options.onStatus);
    }

    await writeChunked(uploadCharacteristic, payload);

    if (options.awaitStable) {
      await new Promise(resolve => setTimeout(resolve, options.awaitStable));
    }
  } finally {
    if (server.connected) {
      server.disconnect();
    }
  }

  return serialized.length;
}
