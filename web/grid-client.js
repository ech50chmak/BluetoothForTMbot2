const SERVICE_UUID = '12345678-1234-5678-1234-56789abc0000';
const UPLOAD_CHAR_UUID = '12345678-1234-5678-1234-56789abc0001';
const STATUS_CHAR_UUID = '12345678-1234-5678-1234-56789abc0002';

const OPCODES = {
  START: 0x01,
  CHUNK: 0x02,
  CANCEL: 0x03,
  END: 0x04
};

const MAX_CHUNK = 180;
const RETRY_DELAYS_MS = [150, 300, 600, 1200];

class TMbotBleClient {
  constructor(logFn) {
    this.log = logFn || console.log;
    this.device = null;
    this.server = null;
    this.service = null;
    this.uploadCharacteristic = null;
    this.statusCharacteristic = null;
    this.statusListener = null;
  }

  async ensureConnected(options = {}) {
    if (this.server && this.server.connected) {
      return;
    }
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth API is not available in this browser');
    }
    const namePrefix = options.namePrefix || 'TMbot';
    this.log(`Requesting Bluetooth device with prefix "${namePrefix}"`);
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix }],
      optionalServices: [SERVICE_UUID]
    });
    this.device.addEventListener('gattserverdisconnected', () => {
      this.log('Device disconnected');
    });

    this.server = await this.device.gatt.connect();
    this.service = await this.server.getPrimaryService(SERVICE_UUID);
    this.uploadCharacteristic = await this.service.getCharacteristic(UPLOAD_CHAR_UUID);
    this.statusCharacteristic = await this.service.getCharacteristic(STATUS_CHAR_UUID);

    await this.subscribeStatus();
    this.log('Connected to TMbot service');
  }

  async subscribeStatus() {
    if (!this.statusCharacteristic) {
      return;
    }
    if (this.statusListener) {
      return;
    }
    await this.statusCharacteristic.startNotifications();
    this.statusListener = event => {
      try {
        const payload = JSON.parse(new TextDecoder().decode(event.target.value));
        this.log(`STATUS ${JSON.stringify(payload)}`);
        if (typeof window !== 'undefined' && window.tmBleUpdateStatus) {
          window.tmBleUpdateStatus(payload);
        }
      } catch (err) {
        this.log(`STATUS decode error: ${err.message}`);
      }
    };
    this.statusCharacteristic.addEventListener(
      'characteristicvaluechanged',
      this.statusListener
    );
    // prime with current value
    try {
      const snapshot = await this.statusCharacteristic.readValue();
      const payload = JSON.parse(new TextDecoder().decode(snapshot));
      this.log(`STATUS ${JSON.stringify(payload)}`);
      if (typeof window !== 'undefined' && window.tmBleUpdateStatus) {
        window.tmBleUpdateStatus(payload);
      }
    } catch (err) {
      this.log(`STATUS read error: ${err.message}`);
    }
  }

  async disconnect() {
    if (this.statusCharacteristic && this.statusListener) {
      this.statusCharacteristic.removeEventListener(
        'characteristicvaluechanged',
        this.statusListener
      );
    }
    this.statusListener = null;
    if (this.server && this.server.connected) {
      this.server.disconnect();
    }
  }

  async sendInline(grid) {
    await this.ensureConnected();
    const payload = this.encodeGrid(grid);
    if (payload.length > 100) {
      this.log(
        `Inline payload is ${payload.length} bytes (>100). Prefer chunked mode for reliability.`
      );
    }
    await this.writeFrame(payload);
    this.log(`Inline payload sent (${payload.length} bytes)`);
  }

  async sendChunked(grid) {
    await this.ensureConnected();
    const payload = this.encodeGrid(grid);
    if (payload.length <= MAX_CHUNK) {
      this.log(
        `Payload fits in a single chunk (${payload.length} bytes). Sending inline instead.`
      );
      await this.writeFrame(payload);
      return;
    }

    const startFrame = new Uint8Array(5);
    const view = new DataView(startFrame.buffer);
    startFrame[0] = OPCODES.START;
    view.setUint32(1, payload.length, true);
    await this.writeFrame(startFrame);
    this.log(`START sent (${payload.length} bytes total)`);

    for (let offset = 0; offset < payload.length; offset += MAX_CHUNK) {
      const chunk = payload.subarray(offset, offset + MAX_CHUNK);
      const frame = new Uint8Array(chunk.length + 1);
      frame[0] = OPCODES.CHUNK;
      frame.set(chunk, 1);
      await this.writeFrame(frame);
      this.log(
        `CHUNK sent (${Math.min(offset + chunk.length, payload.length)}/${payload.length})`
      );
    }

    const endFrame = new Uint8Array([OPCODES.END]);
    await this.writeFrame(endFrame);
    this.log('END sent');
  }

  encodeGrid(grid) {
    const json = typeof grid === 'string' ? grid : JSON.stringify(grid);
    return new TextEncoder().encode(json);
  }

  async writeFrame(frame) {
    const writeWithResponse = this.uploadCharacteristic.writeValueWithResponse
      ? this.uploadCharacteristic.writeValueWithResponse.bind(this.uploadCharacteristic)
      : null;
    const write = this.uploadCharacteristic.writeValue
      ? this.uploadCharacteristic.writeValue.bind(this.uploadCharacteristic)
      : null;
    const writeFn = writeWithResponse || write;

    if (!writeFn) {
      throw new Error('Characteristic does not support write operations');
    }

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await writeFn(frame);
        return;
      } catch (err) {
        if (!this.shouldRetry(err, attempt)) {
          throw err;
        }
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        this.log(
          `write failed (${err.message || err}), retrying in ${delay}ms (attempt ${attempt + 1})`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt += 1;
      }
    }
  }

  shouldRetry(error, attempt) {
    if (attempt >= RETRY_DELAYS_MS.length) {
      return false;
    }
    const message = (error && error.message ? error.message : String(error)).toLowerCase();
    return (
      message.includes('gatt operation failed') ||
      message.includes('networkerror') ||
      message.includes('device disconnected')
    );
  }
}

function createLogger(logElement) {
  return message => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    if (logElement) {
      logElement.textContent += `${line}\n`;
      logElement.scrollTop = logElement.scrollHeight;
    }
    console.log(line);
  };
}

export function setupClient(options = {}) {
  const statusBox = options.statusBox || null;
  const logBox = options.logBox || null;
  const logFn = createLogger(logBox);
  const client = new TMbotBleClient(logFn);

  window.tmBleUpdateStatus = payload => {
    if (statusBox) {
      statusBox.textContent = JSON.stringify(payload, null, 2);
    }
  };

  window.tmBle = {
    connect: () => client.ensureConnected().catch(err => logFn(`Connect error: ${err.message}`)),
    sendInline: grid =>
      client.sendInline(grid).catch(err => logFn(`Inline send error: ${err.message}`)),
    sendChunked: grid =>
      client.sendChunked(grid).catch(err => logFn(`Chunked send error: ${err.message}`)),
    sendRawString: str =>
      client
        .sendInline(str)
        .catch(err => logFn(`Raw send error: ${err.message}`)),
    disconnect: () => client.disconnect()
  };

  return client;
}
