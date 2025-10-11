const fs = require('fs/promises');
const { spawn } = require('child_process');
const crypto = require('crypto');
const EventEmitter = require('eventemitter3');

class RobotBridge extends EventEmitter {
  constructor({ outputPath, command, commandArgs }) {
    super();
    this.outputPath = outputPath;
    this.command = command;
    this.commandArgs = this.parseArgs(commandArgs);
    this.status = {
      receiving: false,
      receivedBytes: 0,
      expectedBytes: 0,
      lastError: null,
      lastPayloadHash: null,
      lastUploadedAt: null
    };
    this.statusListeners = new Set();
  }

  parseArgs(raw) {
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
      // ignore and fall back to space splitting
    }
    if (typeof raw === 'string') {
      return raw.split(' ').filter(Boolean);
    }
    return [];
  }

  hashPayload(payload) {
    return crypto.createHash('sha1').update(payload).digest('hex');
  }

  addStatusListener(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  emitStatus() {
    for (const listener of this.statusListeners) {
      try {
        listener(this.status);
      } catch (err) {
        console.error('Status listener failed:', err);
      }
    }
    this.emit('status', this.status);
  }

  bumpStatus(diff) {
    this.status = {
      ...this.status,
      ...diff,
      lastHeartbeat: new Date().toISOString()
    };
    this.emitStatus();
  }

  async submitGrid(grid) {
    const receivedAt = new Date().toISOString();
    const gridJson = JSON.stringify(grid);
    const hash = this.hashPayload(gridJson);
    const payloadObject = {
      receivedAt,
      grid,
      hash
    };
    const serialized = JSON.stringify(payloadObject, null, 2);

    if (this.outputPath) {
      await fs.writeFile(this.outputPath, serialized, 'utf8');
    }

    if (this.command) {
      this.spawnCommand();
    }

    this.bumpStatus({
      receiving: false,
      receivedBytes: Buffer.byteLength(serialized),
      expectedBytes: Buffer.byteLength(serialized),
      lastError: null,
      lastPayloadHash: hash,
      lastUploadedAt: receivedAt
    });
  }

  spawnCommand() {
    const child = spawn(this.command, this.commandArgs, {
      stdio: 'inherit',
      shell: false
    });
    child.on('error', err => {
      this.bumpStatus({
        lastError: `Команда не запустилась: ${err.message}`
      });
    });
    child.on('exit', code => {
      if (code !== 0) {
        this.bumpStatus({
          lastError: `Команда завершилась с кодом ${code}`
        });
      }
    });
  }

  getStatus() {
    return this.status;
  }
}

module.exports = RobotBridge;
