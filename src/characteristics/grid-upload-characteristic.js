const { Characteristic, Descriptor } = require('bleno');

const OPCODES = {
  START: 0x01,
  CHUNK: 0x02,
  CANCEL: 0x03,
  END: 0x04
};

const MAX_CHUNK = 180;
const INACTIVITY_TIMEOUT_MS = 20000;

class GridUploadCharacteristic extends Characteristic {
  constructor({ state, uuid }) {
    super({
      uuid,
      properties: ['write'],
      descriptors: [
        new Descriptor({
          uuid: '2901',
          value: 'Upload grid JSON'
        })
      ]
    });

    this.state = state;
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
    this.inactivityTimer = null;
  }

  onWriteRequest(data, offset, withoutResponse, callback) {
    console.log(
      `[BLE] write received (len=${data.length}, offset=${offset}, expected=${this.expectedLength ?? 'n/a'})`
    );

    if (offset) {
      callback(this.RESULT_ATTR_NOT_LONG);
      return;
    }

    if (!data || data.length === 0) {
      this.handleError(new Error('Empty payload'));
      callback(this.RESULT_INVALID_ATTRIBUTE_LENGTH);
      return;
    }

    let result;
    try {
      result = this.handleFrame(data);
    } catch (err) {
      this.handleError(err);
      this.resetReception();
      callback(this.RESULT_UNLIKELY_ERROR);
      return;
    }

    if (result === 'start' || result === 'chunk' || result === 'cancel') {
      callback(this.RESULT_SUCCESS);
      return;
    }

    const payloadBuffer = Buffer.isBuffer(result) ? result : Buffer.from(result);

    this.state
      .handlePayload(payloadBuffer)
      .then(() => {
        this.resetReception();
        callback(this.RESULT_SUCCESS);
      })
      .catch(err => {
        this.handleError(err);
        this.resetReception();
        callback(this.RESULT_UNLIKELY_ERROR);
      });
  }

  handleFrame(data) {
    const opcode = data.readUInt8(0);

    switch (opcode) {
      case OPCODES.START:
        return this.handleStart(data);
      case OPCODES.CHUNK:
        return this.handleChunk(data);
      case OPCODES.END:
        return this.handleEnd(data);
      case OPCODES.CANCEL:
        return this.handleCancel();
      default:
        return this.handleInline(data);
    }
  }

  handleStart(data) {
    if (data.length < 5) {
      throw new Error('START frame requires 4-byte length');
    }

    if (this.expectedLength !== null) {
      this.state.cancelReception('New START received mid-transfer, resetting session');
      this.resetReception();
    }

    const expected = data.readUInt32LE(1);
    if (expected <= 0) {
      throw new Error('START frame length must be positive');
    }
    if (expected > this.state.maxBytes) {
      throw new Error(`Declared payload exceeds allowed size (${expected} > ${this.state.maxBytes})`);
    }

    this.resetReception();
    this.expectedLength = expected;
    this.state.startReception(expected);
    this.resetInactivityTimer();
    console.log(`[BLE] START accepted (expected=${expected})`);
    return 'start';
  }

  handleChunk(data) {
    if (this.expectedLength === null) {
      throw new Error('CHUNK received before START');
    }
    const chunk = data.subarray(1);
    if (!chunk.length || chunk.length > MAX_CHUNK) {
      throw new Error(`Invalid chunk length (${chunk.length})`);
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.expectedLength) {
      throw new Error('Received more bytes than declared');
    }
    this.state.progressReception(this.buffer.length);
    this.resetInactivityTimer();
    console.log(
      `[BLE] CHUNK accepted (${this.buffer.length}/${this.expectedLength} bytes)`
    );
    return 'chunk';
  }

  handleEnd(data) {
    if (data.length !== 1) {
      throw new Error('END frame should not contain payload bytes');
    }
    if (this.expectedLength === null) {
      throw new Error('END received before START');
    }
    if (this.buffer.length !== this.expectedLength) {
      throw new Error(
        `END received but payload size mismatch (${this.buffer.length}/${this.expectedLength})`
      );
    }
    console.log('[BLE] END received, finalising payload');
    this.clearInactivityTimer();
    return Buffer.from(this.buffer);
  }

  handleCancel() {
    this.state.cancelReception('Client cancelled transfer');
    this.resetReception();
    console.warn('[BLE] Transfer cancelled by client');
    return 'cancel';
  }

  handleInline(data) {
    if (this.expectedLength !== null) {
      throw new Error('Inline payload not allowed during chunked transfer');
    }
    console.log(`[BLE] Inline payload received (${data.length} bytes)`);
    return Buffer.from(data);
  }

  resetReception() {
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
    this.clearInactivityTimer();
  }

  handleError(err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[BLE] transfer error: ${message}`);
    if (this.expectedLength !== null) {
      this.state.cancelReception(message);
    } else {
      this.state.markError(message);
    }
  }

  resetInactivityTimer() {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      console.warn('[BLE] Transfer timed out due to inactivity');
      this.state.cancelReception('Transfer timed out (no activity)');
      this.resetReception();
    }, INACTIVITY_TIMEOUT_MS);
  }

  clearInactivityTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }
}

module.exports = GridUploadCharacteristic;
