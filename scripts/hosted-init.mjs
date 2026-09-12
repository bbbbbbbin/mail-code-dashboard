import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HostedState, readMasterKey } from '../lib/hosted/state.mjs';
const args = Object.fromEntries(process.argv.slice(2).map(a => { const i = a.indexOf('='); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)]; }));
try {
  const dataDir = resolve(args['--data'] || process.env.DATA_DIR || './data');
  const keyFile = args['--key-file'] || process.env.MASTER_KEY_FILE || './secrets/master-key';
  const passwordFile = args['--password-file'] || '/run/secrets/admin-password';
  if (args['--create-key']) await writeFile(keyFile, `${randomBytes(32).toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
  const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const state = new HostedState(join(dataDir, 'platform.enc'), await readMasterKey(keyFile));
  await state.initialize(args['--username'] || 'admin', password);
  console.log('Administrator initialized. Keep the master key separately backed up. Existing installations are never overwritten.');
} catch (e) { console.error(e.code === 'EEXIST' ? 'Already initialized; nothing was overwritten.' : 'Initialization failed. Check the secret files, directory permissions and password length (14–256).'); process.exitCode = 1; }
