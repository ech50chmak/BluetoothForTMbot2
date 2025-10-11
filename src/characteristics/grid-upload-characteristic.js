const util = require('util');
const bleno = require('bleno');

const { Characteristic, Descriptor } = bleno;

const SERVICE_LABEL = 'TMbot tile grid upload';

const OPCODES = {
  START: 0x01,
  CHUNK: 0x02,
  CANCEL: 0x03
};

const MAX_CHUNK = 180;

class GridUploadCharacteristic {
  constructor({ bridge }) {
    GridUploadCharacteristic.super_.call(this, {
      uuid: '13371337-0000-4000-8000-133713371338',
      properties: ['write', 'notify'],
      descriptors: [
        new Descriptor({
          uuid: '2901',
          value: SERVICE_LABEL
        })
      ]
    });

    this.bridge = bridge;
    this.expectedLength = null;
    this.chunks = [];
    this.subscriptionReleaser = null;
  }

  currentBufferLength() {
    return this.chunks.reduce((sum, buffer) => sum + buffer.length, 0);
  }

  clearBuffer() {
    this.expectedLength = null;
    this.chunks = [];
  }

  joinBuffer() {
    return Buffer.concat(this.chunks, this.currentBufferLength());
  }

  notifyStatus() {
    if (!this.updateValueCallback) {
      return;
    }
    const payload = Buffer.from(JSON.stringify(this.bridge.getStatus()), 'utf8');
    this.updateValueCallback(payload);
  }

  onSubscribe(maxValueSize, updateValueCallback) {
    this.updateValueCallback = updateValueCallback;
    this.subscriptionReleaser = this.bridge.addStatusListener(() => {
      this.notifyStatus();
    });
    this.notifyStatus();
  }

  onUnsubscribe() {
    if (this.subscriptionReleaser) {
      this.subscriptionReleaser();
    }
    this.subscriptionReleaser = null;
    this.updateValueCallback = null;
  }

  onWriteRequest(data, offset, withoutResponse, callback) {
    if (offset) {
      callback(this.RESULT_ATTR_NOT_LONG);
      return;
    }
    if (!data || data.length === 0) {
      callback(this.RESULT_INVALID_ATTRIBUTE_LENGTH);
      return;
    }

    const opcode = data.readUInt8(0);

    switch (opcode) {
      case OPCODES.START:
        this.handleStartFrame(data, callback);
        break;
      case OPCODES.CHUNK:
        this.handleChunk(data, callback);
        break;
      case OPCODES.CANCEL:
        this.handleCancel(callback);
        break;
      default:
        callback(this.RESULT_UNLIKELY_ERROR);
    }
  }

  handleStartFrame(data, callback) {
    if (data.length < 5) {
      callback(this.RESULT_INVALID_ATTRIBUTE_LENGTH);
      return;
    }
    const length = data.readUInt32LE(1);
    this.clearBuffer();
    this.expectedLength = length;
    this.bridge.bumpStatus({
      receiving: true,
      expectedBytes: length,
      receivedBytes: 0,
      lastError: null
    });
    this.notifyStatus();
    callback(this.RESULT_SUCCESS);
  }

  handleChunk(data, callback) {
    if (this.expectedLength === null) {
      callback(this.RESULT_UNLIKELY_ERROR);
      return;
    }
    const payload = data.subarray(1);
    if (!payload.length || payload.length > MAX_CHUNK) {
      callback(this.RESULT_INVALID_ATTRIBUTE_LENGTH);
      return;
    }
    this.chunks.push(payload);
    const currentLength = this.currentBufferLength();
    if (currentLength > this.expectedLength) {
      this.bridge.bumpStatus({
        receiving: false,
        lastError: 'Получено больше байт, чем ожидалось'
      });
      this.clearBuffer();
      this.notifyStatus();
      callback(this.RESULT_UNLIKELY_ERROR);
      return;
    }

    if (currentLength === this.expectedLength) {
      this.finishTransfer(callback);
      return;
    }

    this.bridge.bumpStatus({
      receiving: true,
      receivedBytes: currentLength
    });
    this.notifyStatus();
    callback(this.RESULT_SUCCESS);
  }

  handleCancel(callback) {
    this.bridge.bumpStatus({
      receiving: false,
      lastError: 'Передача отменена клиентом'
    });
    this.clearBuffer();
    this.notifyStatus();
    callback(this.RESULT_SUCCESS);
  }

  finishTransfer(callback) {
    const buffer = this.joinBuffer();
    try {
      const jsonString = buffer.toString('utf8');
      const payload = JSON.parse(jsonString);
      this.bridge.submitGrid(payload);
      this.bridge.bumpStatus({
        receiving: false,
        receivedBytes: buffer.length,
        expectedBytes: buffer.length
      });
      this.notifyStatus();
      this.clearBuffer();
      callback(this.RESULT_SUCCESS);
    } catch (err) {
      this.bridge.bumpStatus({
        receiving: false,
        lastError: `Ошибка JSON: ${err.message}`
      });
      this.clearBuffer();
      this.notifyStatus();
      callback(this.RESULT_UNLIKELY_ERROR);
    }
  }
}

util.inherits(GridUploadCharacteristic, Characteristic);

module.exports = GridUploadCharacteristic;
