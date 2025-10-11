const SERVICE_UUID = '12345678-1234-5678-1234-56789abc0000';
const UPLOAD_CHAR_UUID = '12345678-1234-5678-1234-56789abc0001';
const STATUS_CHAR_UUID = '12345678-1234-5678-1234-56789abc0002';

const UPLOAD_OPCODES = {
  START: 0x01,
  CHUNK: 0x02,
  CANCEL: 0x03,
  END: 0x04
};

const STATUS_OPCODES = {
  START: 0x01,
  CONT: 0x02,
  END: 0x03
};

const UPLOAD_MAX_CHUNK = 180;
const RETRY_DELAYS_MS = [150, 300, 600, 1200];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function appendUint8Arrays(a, b) {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

class TMbotBleClient {
  constructor(logFn) {
    this.log = logFn || console.log;
    this.device = null;
    this.server = null;
    this.service = null;
    this.uploadCharacteristic = null;
    this.statusCharacteristic = null;
    this.statusListener = null;
    this.statusAssembler = this.createAssembler();
  }

  createAssembler() {
    return {
      expected: null,
      buffer: new Uint8Array(0),
      complete: false
    };
  }

  resetAssembler() {
    this.statusAssembler = this.createAssembler();
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
      this.resetAssembler();
    });

    this.server = await this.device.gatt.connect();
    this.service = await this.server.getPrimaryService(SERVICE_UUID);
    this.uploadCharacteristic = await this.service.getCharacteristic(UPLOAD_CHAR_UUID);
    this.statusCharacteristic = await this.service.getCharacteristic(STATUS_CHAR_UUID);

    await this.subscribeStatus();
    this.log('Connected to TMbot service');
  }

  async subscribeStatus() {
    if (!this.statusCharacteristic || this.statusListener) {
      return;
    }
    await this.statusCharacteristic.startNotifications();
    this.statusListener = event => {
      this.handleStatusNotification(event).catch(err =>
        this.log(`STATUS decode error: ${err.message}`)
      );
    };
    this.statusCharacteristic.addEventListener(
      'characteristicvaluechanged',
      this.statusListener
    );
    try {
      const value = await this.statusCharacteristic.readValue();
      const json = textDecoder.decode(value);
      this.processStatus(json);
    } catch (err) {
      this.log(`STATUS read error: ${err.message}`);
    }
  }

  async handleStatusNotification(event) {
    const view = event.target.value;
    const frame = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (frame.length === 0) {
      throw new Error('Empty notification');
    }
    const opcode = frame[0];
    if (opcode === STATUS_OPCODES.START) {
      if (frame.length < 5) {
        throw new Error('START frame too short');
      }
      const expected = new DataView(frame.buffer, frame.byteOffset + 1, 4).getUint32(0, true);
      const chunk = frame.slice(5);
      if (chunk.length > expected) {
        throw new Error('START chunk longer than expected');
      }
      this.statusAssembler = {
        expected,
        buffer: chunk,
        complete: chunk.length === expected
      };
      return;
    }

    if (opcode === STATUS_OPCODES.CONT) {
      if (this.statusAssembler.expected == null) {
        throw new Error('CONT frame without START');
      }
      const chunk = frame.slice(1);
      const combined = appendUint8Arrays(this.statusAssembler.buffer, chunk);
      if (combined.length > this.statusAssembler.expected) {
        throw new Error('Status payload exceeds declared length');
      }
      this.statusAssembler.buffer = combined;
      this.statusAssembler.complete =
        combined.length === this.statusAssembler.expected;
      return;
    }

    if (opcode === STATUS_OPCODES.END) {
      if (this.statusAssembler.expected == null) {
        this.log('STATUS warning: END without START');
        this.resetAssembler();
        return;
      }
      if (!this.statusAssembler.complete) {
        this.log(
          `STATUS warning: END before receiving full payload (${this.statusAssembler.buffer.length}/${this.statusAssembler.expected})`
        );
        this.resetAssembler();
        return;
      }
      this.flushStatusBuffer();
      return;
    }

    throw new Error(`Unknown status opcode ${opcode}`);
  }

  flushStatusBuffer() {
    try {
      const json = textDecoder.decode(this.statusAssembler.buffer);
      this.processStatus(json);
    } finally {
      this.resetAssembler();
    }
  }

  processStatus(jsonString) {
    const payload = JSON.parse(jsonString);
    this.log(`STATUS ${JSON.stringify(payload)}`);
    if (typeof window !== 'undefined' && window.tmBleUpdateStatus) {
      window.tmBleUpdateStatus(payload);
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
    this.resetAssembler();
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
    const total = payload.length;

    const startFrame = new Uint8Array(5);
    const view = new DataView(startFrame.buffer);
    startFrame[0] = UPLOAD_OPCODES.START;
    view.setUint32(1, total, true);
    await this.writeFrame(startFrame);
    this.log(`START sent (${total} bytes total)`);

    for (let offset = 0; offset < total; offset += UPLOAD_MAX_CHUNK) {
      const chunkLength = Math.min(UPLOAD_MAX_CHUNK, total - offset);
      const frame = new Uint8Array(chunkLength + 1);
      frame[0] = UPLOAD_OPCODES.CHUNK;
      frame.set(payload.subarray(offset, offset + chunkLength), 1);
      await this.writeFrame(frame);
      this.log(`CHUNK sent (${Math.min(offset + chunkLength, total)}/${total})`);
    }

    await this.writeFrame(new Uint8Array([UPLOAD_OPCODES.END]));
    this.log('END sent');
  }

  encodeGrid(grid) {
    const json = typeof grid === 'string' ? grid : JSON.stringify(grid);
    return textEncoder.encode(json);
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
      client.sendInline(str).catch(err => logFn(`Raw send error: ${err.message}`)),
    disconnect: () => client.disconnect()
  };

  return client;
}
