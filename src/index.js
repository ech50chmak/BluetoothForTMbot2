const bleno = require('bleno');
const GridService = require('./services/grid-service');
const RobotBridge = require('./robot/grid-bridge');

const deviceName = process.env.BLE_DEVICE_NAME || 'TMbotGrid';
const hciDeviceId = process.env.BLENO_HCI_DEVICE_ID || '0';

process.env.BLENO_HCI_DEVICE_ID = hciDeviceId;

const bridge = new RobotBridge({
  outputPath: process.env.GRID_PAYLOAD_PATH || '/var/tmp/tmbot-grid.json',
  command: process.env.GRID_COMMAND || null,
  commandArgs: process.env.GRID_COMMAND_ARGS || null
});

const gridService = new GridService({ bridge });

bleno.on('stateChange', state => {
  console.log(`Adapter hci${hciDeviceId} -> ${state}`);
  if (state === 'poweredOn') {
    bleno.startAdvertising(deviceName, [gridService.uuid], err => {
      if (err) {
        console.error('Failed to start advertising:', err);
      } else {
        console.log(`Advertising as ${deviceName} with service ${gridService.uuid}`);
      }
    });
  } else {
    bleno.stopAdvertising();
  }
});

bleno.on('advertisingStart', error => {
  if (error) {
    console.error('Advertising start error:', error);
    return;
  }

  bleno.setServices([gridService], err => {
    if (err) {
      console.error('setServices error:', err);
    } else {
      console.log('TMGridService registered');
    }
  });
});

bleno.on('accept', clientAddress => {
  console.log(`Accepted connection from ${clientAddress}`);
});

bleno.on('disconnect', clientAddress => {
  console.log(`Disconnected from ${clientAddress}`);
});
