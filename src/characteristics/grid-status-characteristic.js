const { Characteristic, Descriptor } = require('bleno');

const OPCODES = {
  START: 0x01,
  CONT: 0x02,
  END: 0x03
};

const MAX_NOTIFY_BYTES = 20;
const START_HEADER_BYTES = 5; // opcode + uint32 length
const CONT_HEADER_BYTES = 1;

class GridStatusCharacteristic extends Characteristic {
  constructor({ state, uuid }) {
    super({
      uuid,
      properties: ['read', 'notify'],
      descriptors: [
        new Descriptor({
          uuid: '2901',
          value: 'Grid status'
        })
      ]
    });

    this.state = state;
    this.updateValueCallback = null;
    this.release = null;
  }

  onReadRequest(offset, callback) {
    if (offset) {
      callback(this.RESULT_ATTR_NOT_LONG, null);
      return;
    }
    const payload = Buffer.from(JSON.stringify(this._statusSnapshot()), 'utf8');
    callback(this.RESULT_SUCCESS, payload);
  }

  onSubscribe(_maxValueSize, updateValueCallback) {
    this.updateValueCallback = updateValueCallback;
    this.release = this.state.subscribe(status => {
      this.pushStatus(status);
    });
  }

  onUnsubscribe() {
    if (this.release) {
      this.release();
      this.release = null;
    }
    this.updateValueCallback = null;
  }

  pushStatus(status) {
    if (!this.updateValueCallback) {
      return;
    }
    const payload = Buffer.from(JSON.stringify(status), 'utf8');
    this.sendFramed(payload);
  }

  sendFramed(buffer) {
    const total = buffer.length;
    const firstChunkLength = Math.min(
      total,
      Math.max(0, MAX_NOTIFY_BYTES - START_HEADER_BYTES)
    );

    const header = Buffer.alloc(START_HEADER_BYTES);
    header.writeUInt8(OPCODES.START, 0);
    header.writeUInt32LE(total, 1);
    const firstFrame = Buffer.concat([header, buffer.slice(0, firstChunkLength)]);
    this.safeNotify(firstFrame);

    let offset = firstChunkLength;
    while (offset < total) {
      const remaining = total - offset;
      const chunkLength = Math.min(
        remaining,
        Math.max(0, MAX_NOTIFY_BYTES - CONT_HEADER_BYTES)
      );
      const frame = Buffer.alloc(CONT_HEADER_BYTES + chunkLength);
      frame.writeUInt8(OPCODES.CONT, 0);
      buffer.copy(frame, CONT_HEADER_BYTES, offset, offset + chunkLength);
      this.safeNotify(frame);
      offset += chunkLength;
    }

    this.safeNotify(Buffer.from([OPCODES.END]));
  }

  safeNotify(frame) {
    try {
      if (this.updateValueCallback) {
        this.updateValueCallback(frame);
      }
    } catch (err) {
      console.error('[BLE] Failed to notify status frame:', err.message);
    }
  }

  _statusSnapshot() {
    return this.state.snapshot();
  }
}

module.exports = GridStatusCharacteristic;
