"use strict";
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const cache = path.join(root, 'node_modules/.cache');
const result = spawnSync(process.execPath, [require.resolve('firebase-tools/lib/bin/firebase.js'), 'emulators:exec', '--only', 'firestore', '--project', 'demo-zms', '--config', 'firebase.test.json', 'node --test tests/firestore-rules.js'], {
  cwd: root, stdio: 'inherit', env: { ...process.env,
    FIREBASE_EMULATORS_PATH: process.env.FIREBASE_EMULATORS_PATH || path.join(cache, 'firebase/emulators'),
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(cache, 'config') }
});
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
