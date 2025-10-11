const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

class GridState extends EventEmitter {
  constructor(options = {}) {
    super();
    this.gridPath = options.gridPath || '/var/tmp/tmbot-grid.json';
    this.maxBytes = Number.isFinite(options.maxBytes)
      ? options.maxBytes
      : DEFAULT_MAX_BYTES;
    this.command = options.command || null;
    this.commandArgs = Array.isArray(options.commandArgs)
      ? options.commandArgs
      : [];

    this.status = {
      ok: true,
      lastError: null,
      lastSavedAt: null,
      lastBytes: 0,
      lastPayloadHash: null,
      gridPath: this.gridPath,
      receiving: false,
      expectedBytes: null,
      receivedBytes: 0,
      maxBytes: this.maxBytes,
      lastCommand: null,
      fileSize: 0
    };
  }

  snapshot() {
    return { ...this.status };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    this.on('status', listener);
    // push initial snapshot immediately
    listener(this.snapshot());
    return () => {
      this.removeListener('status', listener);
    };
  }

  update(patch = {}) {
    this.status = {
      ...this.status,
      ...patch,
      timestamp: new Date().toISOString()
    };
    this.emit('status', this.snapshot());
  }

  startReception(expectedBytes) {
    this.update({
      receiving: true,
      expectedBytes,
      receivedBytes: 0,
      lastError: null,
      ok: true
    });
  }

  progressReception(receivedBytes) {
    this.update({
      receiving: true,
      receivedBytes
    });
  }

  cancelReception(message) {
    this.update({
      receiving: false,
      expectedBytes: null,
      receivedBytes: 0,
      ok: false,
      lastError: message || 'Transfer cancelled'
    });
  }

  markError(message) {
    this.update({
      ok: false,
      lastError: message
    });
  }

  async handlePayload(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('Payload must be a buffer');
    }

    if (buffer.length === 0) {
      throw new Error('Payload is empty');
    }

    if (buffer.length > this.maxBytes) {
      throw new Error(
        `Payload exceeds limit (${buffer.length} > ${this.maxBytes})`
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      throw new Error(`Invalid JSON: ${err.message}`);
    }

    if (!this.validateGrid(parsed)) {
      throw new Error(
        'Grid must be an array of tile sets made of [x, y] numeric pairs'
      );
    }

    const normalizedString = JSON.stringify(parsed);
    const hash = this.hashPayload(normalizedString);
    const savedAt = new Date().toISOString();

    const payloadObject = {
      receivedAt: savedAt,
      grid: parsed,
      hash,
      bytes: buffer.length
    };
    const serialized = JSON.stringify(payloadObject, null, 2);

    await this.persist(serialized);
    const stats = await this.safeStat(this.gridPath);

    this.update({
      ok: true,
      lastError: null,
      lastSavedAt: savedAt,
      lastBytes: buffer.length,
      lastPayloadHash: hash,
      receiving: false,
      expectedBytes: null,
      receivedBytes: buffer.length,
      fileSize: stats ? stats.size : buffer.length,
      lastSnapshot: {
        receivedAt: savedAt,
        bytes: buffer.length,
        sample: this.previewGrid(parsed)
      }
    });

    this.runCommand();
  }

  async persist(jsonString) {
    const dir = path.dirname(this.gridPath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `${path.basename(this.gridPath)}.${process.pid}.${Date.now()}.tmp`
    );

    await fs.writeFile(tempPath, jsonString, 'utf8');
    await fs.rename(tempPath, this.gridPath);
  }

  async safeStat(targetPath) {
    try {
      return await fs.stat(targetPath);
    } catch (err) {
      return null;
    }
  }

  validateGrid(grid) {
    if (!Array.isArray(grid)) {
      return false;
    }

    return grid.every(tileSet => {
      if (!Array.isArray(tileSet)) {
        return false;
      }
      return tileSet.every(point => {
        if (
          !Array.isArray(point) ||
          point.length !== 2 ||
          !Number.isFinite(point[0]) ||
          !Number.isFinite(point[1])
        ) {
          return false;
        }
        return true;
      });
    });
  }

  hashPayload(payload) {
    return crypto.createHash('sha1').update(payload).digest('hex');
  }

  previewGrid(grid) {
    const sample = [];
    for (const tileSet of grid) {
      if (sample.length >= 3) {
        break;
      }
      sample.push(tileSet.slice(0, 3));
      if (sample.length >= 3) {
        break;
      }
    }
    return sample;
  }

  runCommand() {
    if (!this.command) {
      return;
    }

    const startedAt = new Date().toISOString();
    const baseInfo = {
      cmd: this.command,
      args: this.commandArgs,
      startedAt,
      running: true
    };
    this.update({ lastCommand: baseInfo });

    const child = spawn(this.command, this.commandArgs, {
      stdio: 'inherit',
      shell: false
    });

    child.once('error', err => {
      this.update({
        ok: false,
        lastError: `Command failed to start: ${err.message}`,
        lastCommand: {
          ...baseInfo,
          running: false,
          error: err.message,
          exitedAt: new Date().toISOString()
        }
      });
    });

    child.once('exit', (code, signal) => {
      const exitedAt = new Date().toISOString();
      const failed = typeof code === 'number' && code !== 0;
      const commandStatus = {
        ...baseInfo,
        running: false,
        exitedAt,
        code,
        signal
      };

      this.update({
        lastCommand: commandStatus,
        ...(failed
          ? {
              ok: false,
              lastError: `Command exited with code ${code}`
            }
          : {})
      });
    });
  }
}

module.exports = GridState;
