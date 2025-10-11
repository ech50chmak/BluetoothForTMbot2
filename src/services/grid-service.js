const util = require('util');
const bleno = require('bleno');

const GridUploadCharacteristic = require('../characteristics/grid-upload-characteristic');
const GridStatusCharacteristic = require('../characteristics/grid-status-characteristic');

const PrimaryService = bleno.PrimaryService;

function GridService({ bridge }) {
  const upload = new GridUploadCharacteristic({ bridge });
  const status = new GridStatusCharacteristic({ bridge });

  GridService.super_.call(this, {
    uuid: '13371337-0000-4000-8000-133713371337',
    characteristics: [upload, status]
  });
}

util.inherits(GridService, PrimaryService);

module.exports = GridService;
