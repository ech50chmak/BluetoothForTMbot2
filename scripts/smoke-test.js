/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');

const GridState = require('../src/state/grid-state');

async function main() {
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

  if (!fs.existsSync(gridPath)) {
    throw new Error('Grid file was not created');
  }

  const stored = JSON.parse(fs.readFileSync(gridPath, 'utf8'));

  if (!Array.isArray(stored.grid) || stored.grid.length !== gridPayload.length) {
    throw new Error('Stored grid structure mismatch');
  }

  if (updates.length === 0 || updates.at(-1).ok !== true) {
    throw new Error('Status updates missing successful completion');
  }

  console.log('Smoke test passed');
}

main().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
