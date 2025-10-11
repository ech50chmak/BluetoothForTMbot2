const bleno = require('bleno');

const GridUploadCharacteristic = require('../characteristics/grid-upload-characteristic');
const GridStatusCharacteristic = require('../characteristics/grid-status-characteristic');
const {
  SERVICE_UUID,
  UPLOAD_CHAR_UUID,
  STATUS_CHAR_UUID
} = require('../uuids');

class GridService extends bleno.PrimaryService {
  constructor({ state }) {
    super({
      uuid: SERVICE_UUID,
      characteristics: [
        new GridUploadCharacteristic({ state, uuid: UPLOAD_CHAR_UUID }),
        new GridStatusCharacteristic({ state, uuid: STATUS_CHAR_UUID })
      ]
    });
  }
}

module.exports = GridService;
module.exports.SERVICE_UUID = SERVICE_UUID;
module.exports.UPLOAD_CHAR_UUID = UPLOAD_CHAR_UUID;
module.exports.STATUS_CHAR_UUID = STATUS_CHAR_UUID;
