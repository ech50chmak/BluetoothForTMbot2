/* eslint-disable no-console */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GridState = require('../src/state/grid-state');

const Module = require('module');
const originalModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'bleno') {
    class StubCharacteristic {
      constructor() {
        this.RESULT_SUCCESS = 0;
        this.RESULT_ATTR_NOT_LONG = 7;
        this.RESULT_INVALID_ATTRIBUTE_LENGTH = 13;
        this.RESULT_UNLIKELY_ERROR = 14;
      }
    }

    class StubDescriptor {}

    return {
      Characteristic: StubCharacteristic,
      Descriptor: StubDescriptor
    };
  }
  return originalModuleLoad(request, parent, isMain);
};

const OPCODES = {
  START: 0x01,
  CHUNK: 0x02,
  END: 0x04
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function loadUploadCharacteristic() {
  delete require.cache[require.resolve('../src/characteristics/grid-upload-characteristic')];
  return require('../src/characteristics/grid-upload-characteristic');
}

async function testStateHandlePayload() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grid-'));
  const gridPath = path.join(tmpDir, 'grid.json');
  const state = new GridState({ gridPath, maxBytes: 64 * 1024 });

  const updates = [];
  const unsubscribe = state.subscribe(status => {
    updates.push(status);
  });

  const gridPayload = [
    [
      [0, 0],
      [1, 0]
    ],
    [
      [2, 2],
      [3, 3]
    ]
  ];

  const buffer = Buffer.from(JSON.stringify(gridPayload), 'utf8');
  await state.handlePayload(buffer);

  unsubscribe();

  assert.ok(fs.existsSync(gridPath), 'Grid file was not created');
  const stored = JSON.parse(fs.readFileSync(gridPath, 'utf8'));
  assert.ok(Array.isArray(stored.grid), 'Stored grid missing');
  assert.strictEqual(stored.grid.length, gridPayload.length, 'Stored grid length mismatch');
  assert.ok(updates.length > 0 && updates.at(-1).ok === true, 'Status updates missing success flag');
}

class StubState {
  constructor() {
    this.events = [];
    this.expectedBytes = 0;
    this.receivedBytes = 0;
    this.handledPayload = null;
    this.cancelledMessage = null;
  }

  startReception(expectedBytes) {
    this.expectedBytes = expectedBytes;
    this.events.push({ type: 'start', expectedBytes });
  }

  progressReception(bytes, meta = {}) {
    this.receivedBytes = bytes;
    this.events.push({ type: 'progress', bytes, meta });
  }

  update(patch = {}, message = null) {
    if (typeof patch.expectedBytes === 'number') {
      this.expectedBytes = patch.expectedBytes;
    }
    if (typeof patch.receivedBytes === 'number') {
      this.receivedBytes = patch.receivedBytes;
    }
    this.events.push({ type: 'update', patch, message });
  }

  cancelReception(message) {
    this.cancelledMessage = message;
    this.events.push({ type: 'cancel', message });
  }

  markError(message) {
    this.events.push({ type: 'error', message });
  }

  async handlePayload(buffer) {
    this.handledPayload = buffer;
    this.events.push({ type: 'payload', length: buffer.length });
  }

  snapshot() {
    return {
      expectedBytes: this.expectedBytes,
      receivedBytes: this.receivedBytes,
      receiving: true
    };
  }
}

async function writeFrame(characteristic, buffer) {
  await new Promise((resolve, reject) => {
    characteristic.onWriteRequest(buffer, 0, false, result => {
      if (result === characteristic.RESULT_SUCCESS) {
        resolve();
      } else {
        reject(new Error(`Write failed with code ${result}`));
      }
    });
  });
}

async function testCharacteristicChunkFlow() {
  process.env.GRID_TRANSFER_TIMEOUT_MS = '1000';
  process.env.GRID_CHUNK_MAX = '19';
  const GridUploadCharacteristic = loadUploadCharacteristic();
  const state = new StubState();
  const characteristic = new GridUploadCharacteristic({ state, uuid: 'tm-test' });

  const payload = Buffer.from(
    JSON.stringify([
      [
        [0, 0],
        [1, 0],
        [2, 0]
      ],
      [
        [3, 1],
        [3, 2]
      ]
    ]),
    'utf8'
  );

  const startFrame = Buffer.alloc(5);
  startFrame.writeUInt8(OPCODES.START);
  startFrame.writeUInt32LE(payload.length, 1);
  await writeFrame(characteristic, startFrame);

  const chunk1 = Buffer.concat([Buffer.from([OPCODES.CHUNK]), payload.slice(0, 19)]);
  await writeFrame(characteristic, chunk1);

  const chunk2 = Buffer.concat([Buffer.from([OPCODES.CHUNK]), payload.slice(19)]);
  await writeFrame(characteristic, chunk2);

  await writeFrame(characteristic, Buffer.from([OPCODES.END]));
  characteristic.clearInactivityTimer();

  assert.ok(state.handledPayload, 'Payload handler not invoked');
  assert.strictEqual(
    state.handledPayload.toString('utf8'),
    payload.toString('utf8'),
    'Payload mismatch'
  );
  assert.ok(state.events.find(event => event.type === 'progress'), 'Progress event missing');
}

async function testCharacteristicTimeout() {
  process.env.GRID_TRANSFER_TIMEOUT_MS = '50';
  process.env.GRID_CHUNK_MAX = '19';
  const GridUploadCharacteristic = loadUploadCharacteristic();
  const state = new StubState();
  const characteristic = new GridUploadCharacteristic({ state, uuid: 'tm-timeout' });

  const startFrame = Buffer.alloc(5);
  startFrame.writeUInt8(OPCODES.START);
  startFrame.writeUInt32LE(100, 1);
  await writeFrame(characteristic, startFrame);

  await delay(80);
  assert.ok(state.cancelledMessage, 'Timeout did not cancel transfer');
  characteristic.clearInactivityTimer();
}

async function main() {
  try {
    await testStateHandlePayload();
    await testCharacteristicChunkFlow();
    await testCharacteristicTimeout();
    console.log('Smoke test passed');
  } finally {
    Module._load = originalModuleLoad;
  }
}

main().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});



