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

const CHUNK_DATA_SIZE = 20;
const CHUNK_DELAY_MS = 30;
const RETRY_DELAYS_MS = [150, 300, 600, 1200];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    this.statusPaused = false;
    this.transferInProgress = false;
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
    if (this.server && this.server.connected && !options.forceRefresh) {
      return;
    }
    if (!this.device) {
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
        this.server = null;
        this.resetAssembler();
      });
    }

    if (!this.device.gatt.connected || options.forceRefresh) {
      this.server = await this.device.gatt.connect();
    } else {
      this.server = this.device.gatt;
    }

    this.service = await this.server.getPrimaryService(SERVICE_UUID);
    this.uploadCharacteristic = await this.service.getCharacteristic(UPLOAD_CHAR_UUID);
    this.statusCharacteristic = await this.service.getCharacteristic(STATUS_CHAR_UUID);

    if (this.statusListener) {
      this.statusCharacteristic.removeEventListener(
        'characteristicvaluechanged',
        this.statusListener
      );
      this.statusListener = null;
    }

    this.resetAssembler();
    this.statusPaused = true;
    if (!options.skipStatusSubscribe) {
      await this.subscribeStatus();
    }
    this.log('Connected to TMbot service');
  }

  async subscribeStatus() {
    if (!this.statusCharacteristic || this.statusListener) {
      return;
    }
    await this.statusCharacteristic.startNotifications();
    this.resetAssembler();
    this.statusPaused = false;
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
      const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (view.length) {
        this.processStatus(textDecoder.decode(view));
      }
    } catch (err) {
      this.log(`STATUS read error: ${err.message}`);
    }
  }

  async handleStatusNotification(event) {
    const view = new Uint8Array(
      event.target.value.buffer,
      event.target.value.byteOffset,
      event.target.value.byteLength
    );
    if (!view.length) {
      throw new Error('Empty notification frame');
    }
    const opcode = view[0];

    if (opcode === STATUS_OPCODES.START) {
      if (view.length < 5) {
        throw new Error('START frame too short');
      }
      const expected = new DataView(view.buffer, view.byteOffset + 1, 4).getUint32(0, true);
      const chunk = view.slice(5);
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
        throw new Error('CONT frame received before START');
      }
      const chunk = view.slice(1);
      const combined = appendUint8Arrays(this.statusAssembler.buffer, chunk);
      if (combined.length > this.statusAssembler.expected) {
        throw new Error('Status payload exceeds expected length');
      }
      this.statusAssembler.buffer = combined;
      this.statusAssembler.complete =
        combined.length === this.statusAssembler.expected;
      return;
    }

    if (opcode === STATUS_OPCODES.END) {
      this.flushStatusBuffer();
      return;
    }

    throw new Error(`Unknown status opcode ${opcode}`);
  }

  flushStatusBuffer() {
    const { expected, buffer, complete } = this.statusAssembler;
    if (expected == null) {
      this.log('STATUS warning: END received without START');
      this.resetAssembler();
      return;
    }
    if (!complete) {
      this.log(
        `STATUS warning: END received before payload complete (${buffer.length}/${expected})`
      );
      this.resetAssembler();
      return;
    }
    try {
      this.processStatus(textDecoder.decode(buffer));
    } catch (err) {
      this.log(`STATUS decode error: ${err.message}`);
    } finally {
      this.resetAssembler();
    }
  }

  processStatus(jsonString) {
    try {
      const payload = JSON.parse(jsonString);
      this.log(`STATUS ${JSON.stringify(payload)}`);
      if (typeof window !== 'undefined' && window.tmBleUpdateStatus) {
        window.tmBleUpdateStatus(payload);
      }
    } catch (err) {
      this.log(`STATUS parse error: ${err.message}`);
    }
  }

  async pauseStatus() {
    if (!this.statusCharacteristic || this.statusPaused) {
      return;
    }
    try {
      await this.statusCharacteristic.stopNotifications();
    } catch (err) {
      this.log(`STATUS pause warning: ${err.message}`);
    }
    this.statusPaused = true;
    this.log('Status notifications paused');
  }

  async resumeStatus() {
    if (!this.statusCharacteristic) {
      return;
    }
    if (!this.statusListener) {
      this.resetAssembler();
      await this.subscribeStatus();
      this.log('Status notifications resumed');
      return;
    }
    if (!this.statusPaused) {
      return;
    }
    await this.statusCharacteristic.startNotifications();
    this.resetAssembler();
    this.statusPaused = false;
    this.log('Status notifications resumed');
  }

  async disconnect() {
    if (this.statusCharacteristic && this.statusListener) {
      this.statusCharacteristic.removeEventListener(
        'characteristicvaluechanged',
        this.statusListener
      );
    }
    this.statusListener = null;
    this.statusPaused = false;
    this.resetAssembler();
    if (this.server && this.server.connected) {
      this.server.disconnect();
    }
  }

  createStartFrame(totalLength) {
    const frame = new Uint8Array(5);
    const view = new DataView(frame.buffer);
    frame[0] = UPLOAD_OPCODES.START;
    view.setUint32(1, totalLength, true);
    return frame;
  }

  createChunkFrame(payload, offset, length) {
    const frame = new Uint8Array(length + 1);
    frame[0] = UPLOAD_OPCODES.CHUNK;
    frame.set(payload.subarray(offset, offset + length), 1);
    return frame;
  }

  encodeGrid(grid) {
    const json = typeof grid === 'string' ? grid : JSON.stringify(grid);
    return textEncoder.encode(json);
  }

  async readStatusSnapshot() {
    if (!this.statusCharacteristic) {
      return null;
    }
    const value = await this.statusCharacteristic.readValue();
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (!view.length) {
      return null;
    }
    try {
      return JSON.parse(textDecoder.decode(view));
    } catch (err) {
      this.log(`STATUS snapshot parse error: ${err.message}`);
      return null;
    }
  }

  isDisconnectError(error) {
    const message = (error && error.message ? error.message : String(error)).toLowerCase();
    return (
      message.includes('disconnected') ||
      message.includes('not connected') ||
      message.includes('connection')
    );
  }

  async recoverConnection(totalLength) {
    this.log('Attempting BLE reconnection...');
    await this.ensureConnected({ skipStatusSubscribe: true, forceRefresh: true });
    await this.pauseStatus();
    try {
      const snapshot = await this.readStatusSnapshot();
      if (snapshot && snapshot.expectedBytes === totalLength) {
        return {
          offset: typeof snapshot.receivedBytes === 'number' ? snapshot.receivedBytes : 0,
          startAcked: !!snapshot.receiving || (snapshot.receivedBytes || 0) > 0
        };
      }
    } catch (err) {
      this.log(`Recover status read failed: ${err.message}`);
    }
    return { offset: 0, startAcked: false };
  }

  async writeWithRecovery(operation, context, state, meta = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await operation();
        return { skip: false };
      } catch (err) {
        if (!this.shouldRetry(err, attempt)) {
          throw err;
        }
        const backoff = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        let skip = false;
        if (this.isDisconnectError(err)) {
          const recovery = await this.recoverConnection(state.totalLength);
          state.startSent = recovery.startAcked;
          state.offset = recovery.offset;
          if (context === 'start' && recovery.startAcked) {
            this.log('Server already awaiting chunks; skipping duplicate START.');
            skip = true;
          }
          if (context.startsWith('chunk') && typeof meta.offset === 'number') {
            if (state.offset > meta.offset) {
              this.log(
                `Chunk at offset ${meta.offset} already acknowledged (server offset ${state.offset}).`
              );
              skip = true;
            }
          }
          if (context === 'end' && state.offset < state.totalLength) {
            this.log('Server still expects additional data; resuming chunk transfer.');
            skip = true;
          }
        }
        if (skip) {
          return { skip: true };
        }
        this.log(
          `${context} write failed (${err.message || err}); retrying in ${backoff}ms`
        );
        await delay(backoff);
      }
    }
  }

  async sendInline(grid) {
    if (this.transferInProgress) {
      throw new Error('Another transfer is already in progress');
    }
    await this.ensureConnected();
    await this.pauseStatus();
    const payload = this.encodeGrid(grid);
    if (payload.length > CHUNK_DATA_SIZE) {
      this.log(
        `Inline payload is ${payload.length} bytes (> ${CHUNK_DATA_SIZE}). Prefer chunked mode for reliability.`
      );
    }
    this.transferInProgress = true;
    try {
      const state = {
        totalLength: payload.length,
        offset: 0,
        startSent: true
      };
      const result = await this.writeWithRecovery(
        () => this.writeFrame(payload),
        'inline',
        state
      );
      if (result.skip) {
        this.log('Inline payload acknowledged during recovery');
      } else {
        this.log(`Inline payload sent (${payload.length} bytes)`);
      }
    } finally {
      this.transferInProgress = false;
      await this.resumeStatus().catch(err =>
        this.log(`STATUS resume warning: ${err.message}`)
      );
    }
  }

  async sendChunked(grid) {
    if (this.transferInProgress) {
      throw new Error('Another transfer is already in progress');
    }
    await this.ensureConnected();
    await this.pauseStatus();
    const payload = this.encodeGrid(grid);
    const state = {
      totalLength: payload.length,
      offset: 0,
      startSent: false
    };

    this.transferInProgress = true;
    try {
      while (true) {
        if (!state.startSent) {
          const startFrame = this.createStartFrame(state.totalLength);
          const result = await this.writeWithRecovery(
            () => this.writeFrame(startFrame),
            'start',
            state
          );
          state.startSent = true;
          if (result.skip) {
            this.log('START frame acknowledged during recovery');
          }
        }

        while (state.offset < state.totalLength) {
          const chunkLength = Math.min(CHUNK_DATA_SIZE, state.totalLength - state.offset);
          const currentOffset = state.offset;
          const frame = this.createChunkFrame(payload, currentOffset, chunkLength);
          const result = await this.writeWithRecovery(
            () => this.writeFrame(frame),
            `chunk@${currentOffset}`,
            state,
            { offset: currentOffset }
          );
          if (!result.skip) {
            state.offset = currentOffset + chunkLength;
          }
          await delay(CHUNK_DELAY_MS);
        }

        if (state.offset < state.totalLength) {
          this.log('Server offset indicates pending bytes; continuing chunk transfer.');
          continue;
        }

        const endResult = await this.writeWithRecovery(
          () => this.writeFrame(new Uint8Array([UPLOAD_OPCODES.END])),
          'end',
          state
        );
        if (endResult.skip && state.offset < state.totalLength) {
          this.log('END skipped due to pending bytes; resuming chunk loop.');
          continue;
        }

        this.log('Chunked payload sent successfully');
        break;
      }
    } finally {
      this.transferInProgress = false;
      await this.resumeStatus().catch(err =>
        this.log(`STATUS resume warning: ${err.message}`)
      );
    }
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

    await writeFn(frame);
  }

  shouldRetry(error, attempt) {
    if (attempt >= RETRY_DELAYS_MS.length) {
      return false;
    }
    const message = (error && error.message ? error.message : String(error)).toLowerCase();
    return (
      message.includes('gatt operation failed') ||
      message.includes('networkerror') ||
      message.includes('device disconnected') ||
      message.includes('already in progress')
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
