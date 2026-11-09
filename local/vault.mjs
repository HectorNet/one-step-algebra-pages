import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {requireValue} from './errors.mjs';

// This directory is outside the repository and is never served over HTTP.
export async function openVault(directory) {
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const directoryInfo = await fs.lstat(directory);
  requireValue(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(), 'unsafe_storage');
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
  const lock = join(directory, 'runtime.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch { throw new Error('local_runtime_already_running'); }
  const path = join(directory, 'chatgpt.json');
  let data, queue = Promise.resolve();
  try {
    try {
      const info = await fs.lstat(path);
      requireValue(info.isFile() && !info.isSymbolicLink() && info.size < 1024 * 1024, 'unsafe_storage');
      if (process.platform !== 'win32') await fs.chmod(path, 0o600);
      data = JSON.parse(await fs.readFile(path, 'utf8'));
      requireValue(data.version === 1 && Array.isArray(data.connections) &&
        /^urn:uuid:[a-f0-9-]{36}$/.test(data.host_id), 'invalid_storage');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      data = {version: 1, host_id: 'urn:uuid:' + randomUUID(), connections: []};
    }
    async function persist(next) {
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        const output = await fs.open(temporary, 'wx', 0o600);
        try { await output.writeFile(JSON.stringify(next)); await output.sync(); }
        finally { await output.close(); }
        await fs.rename(temporary, path);
        data = next;
      } finally { await fs.rm(temporary, {force: true}); }
    }
    await persist(data);
    return {
      read: () => structuredClone(data),
      change: operation => {
        const result = queue.then(async () => {
          const next = structuredClone(data), value = operation(next);
          await persist(next);
          return value;
        });
        queue = result.catch(() => {});
        return result;
      },
      close: async () => { await queue; await handle.close(); await fs.rm(lock, {force: true}); },
    };
  } catch (error) {
    await handle.close(); await fs.rm(lock, {force: true}); throw error;
  }
}
