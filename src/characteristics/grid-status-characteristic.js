const util = require('util');
const bleno = require('bleno');

const { Characteristic, Descriptor } = bleno;

class GridStatusCharacteristic {
  constructor({ bridge }) {
    GridStatusCharacteristic.super_.call(this, {
      uuid: '13371337-0000-4000-8000-133713371339',
      properties: ['read', 'notify'],
      descriptors: [
        new Descriptor({
          uuid: '2901',
          value: 'TMbot grid status summary'
        })
      ]
    });

    this.bridge = bridge;
    this.releaseStatusHook = null;
  }

  send(payload, callback) {
    if (callback) {
      callback(this.RESULT_SUCCESS, payload);
      return;
    }
    if (this.updateValueCallback) {
      this.updateValueCallback(payload);
    }
  }

  onSubscribe(maxValueSize, updateValueCallback) {
    this.updateValueCallback = updateValueCallback;
    this.releaseStatusHook = this.bridge.addStatusListener(status => {
      this.notifyStatus(status);
    });
    this.notifyStatus(this.bridge.getStatus());
  }

  onUnsubscribe() {
    this.updateValueCallback = null;
    if (this.releaseStatusHook) {
      this.releaseStatusHook();
      this.releaseStatusHook = null;
    }
  }

  onReadRequest(offset, callback) {
    if (offset) {
      callback(this.RESULT_ATTR_NOT_LONG, null);
      return;
    }
    const payload = Buffer.from(JSON.stringify(this.bridge.getStatus()), 'utf8');
    callback(this.RESULT_SUCCESS, payload);
  }

  notifyStatus(status) {
    if (!this.updateValueCallback) {
      return;
    }
    const payload = Buffer.from(JSON.stringify(status), 'utf8');
    this.updateValueCallback(payload);
  }
}

util.inherits(GridStatusCharacteristic, Characteristic);

module.exports = GridStatusCharacteristic;
