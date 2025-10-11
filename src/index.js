const bleno = require('bleno');

const GridService = require('./services/grid-service');
const GridState = require('./state/grid-state');
const { SERVICE_UUID } = require('./uuids');

const deviceName = process.env.BLE_DEVICE_NAME || 'TMbot';
const hciDeviceId = process.env.BLENO_HCI_DEVICE_ID || '0';
process.env.BLENO_HCI_DEVICE_ID = hciDeviceId;
const gridPath = process.env.GRID_PAYLOAD_PATH || '/var/tmp/tmbot-grid.json';
const maxBytesEnv = parseInt(process.env.GRID_MAX_BYTES || '', 10);
const command = process.env.GRID_COMMAND || null;
const commandArgs = parseArgs(process.env.GRID_COMMAND_ARGS);

const state = new GridState({
  gridPath,
  maxBytes: Number.isFinite(maxBytesEnv) ? maxBytesEnv : undefined,
  command,
  commandArgs
});

const gridService = new GridService({ state });

bleno.on('stateChange', newState => {
  console.log(`Adapter hci${hciDeviceId} -> ${newState}`);
  if (newState === 'poweredOn') {
    bleno.startAdvertising(deviceName, [SERVICE_UUID], err => {
      if (err) {
        console.error('Failed to start advertising:', err);
      } else {
        console.log(`Advertising as ${deviceName}`);
      }
    });
  } else {
    bleno.stopAdvertising();
  }
});

bleno.on('advertisingStart', error => {
  if (error) {
    console.error('advertisingStart error:', error);
    return;
  }
  bleno.setServices([gridService], err => {
    if (err) {
      console.error('setServices error:', err);
    } else {
      console.log('TMGridService ready');
    }
  });
});

bleno.on('accept', clientAddress => {
  console.log(`Accepted connection from ${clientAddress}`);
});

bleno.on('disconnect', clientAddress => {
  console.log(`Disconnected from ${clientAddress}`);
  if (gridService.uploadCharacteristic) {
    gridService.uploadCharacteristic.handleDisconnect(
      `Client disconnected (${clientAddress})`
    );
  }
});

process.on('SIGINT', () => {
  console.log('SIGINT received, stopping BLE advertising...');
  bleno.stopAdvertising(() => {
    try {
      bleno.disconnect();
    } catch (err) {
      // ignore disconnect errors
    }
    process.exit(0);
  });
});

function parseArgs(raw) {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    // fall back to whitespace split
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[\s,]+/)
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}
