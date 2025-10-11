const { Characteristic, Descriptor } = require('bleno');

const OPCODES = {
  START: 0x01,
  CHUNK: 0x02,
  CANCEL: 0x03
};

const MAX_CHUNK = 180;

class GridUploadCharacteristic extends Characteristic {
  constructor({ state, uuid }) {
    super({
      uuid,
      properties: ['write', 'writeWithoutResponse'],
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
  }

  onWriteRequest(data, offset, withoutResponse, callback) {
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

    const payloadBuffer = Buffer.isBuffer(result) ? result : Buffer.from(data);

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

    if (opcode === OPCODES.START) {
      if (data.length < 5) {
        throw new Error('START frame requires 4-byte length');
      }
      const expected = data.readUInt32LE(1);
      if (expected <= 0) {
        throw new Error('START frame length must be positive');
      }
      if (expected > this.state.maxBytes) {
        throw new Error('Declared payload exceeds allowed size');
      }
      this.resetReception();
      this.expectedLength = expected;
      this.state.startReception(expected);
      return 'start';
    }

    if (opcode === OPCODES.CANCEL) {
      this.state.cancelReception('Client cancelled transfer');
      this.resetReception();
      return 'cancel';
    }

    if (opcode === OPCODES.CHUNK) {
      if (this.expectedLength === null) {
        throw new Error('CHUNK received before START');
      }
      const chunk = data.subarray(1);
      if (!chunk.length || chunk.length > MAX_CHUNK) {
        throw new Error('Invalid chunk length');
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > this.expectedLength) {
        throw new Error('Received more bytes than declared');
      }
      this.state.progressReception(this.buffer.length);
      if (this.buffer.length === this.expectedLength) {
        return Buffer.from(this.buffer);
      }
      return 'chunk';
    }

    if (this.expectedLength !== null) {
      throw new Error('Inline payload not allowed during chunked transfer');
    }

    // Inline JSON payload
    return Buffer.from(data);
  }

  resetReception() {
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
  }

  handleError(err) {
    const message = err instanceof Error ? err.message : String(err);
    if (this.expectedLength !== null) {
      this.state.cancelReception(message);
    } else {
      this.state.markError(message);
    }
  }
}

module.exports = GridUploadCharacteristic;
