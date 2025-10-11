const { Characteristic, Descriptor } = require('bleno');

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
    const payload = Buffer.from(JSON.stringify(this._status()), 'utf8');
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
    this.updateValueCallback(payload);
  }

  _status() {
    return this.state.snapshot();
  }
}

module.exports = GridStatusCharacteristic;
