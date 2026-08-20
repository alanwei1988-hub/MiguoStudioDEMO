import fs from 'node:fs';
import { config, ensureRuntimeDirectories } from '../src/config.mjs';
import { P0Database } from '../src/db.mjs';
import { AuthService, publicUser } from '../src/auth.mjs';

function readRequired(name, fileName) {
  const direct = process.env[name];
  if (direct) return direct;
  const filePath = process.env[fileName];
  if (filePath) return fs.readFileSync(filePath, 'utf8').replace(/[\r\n]+$/, '');
  throw new Error(`${name} or ${fileName} is required.`);
}

ensureRuntimeDirectories(config);
const db = new P0Database(config.databasePath);
try {
  const auth = new AuthService({ db, config: config.auth });
  const user = auth.upsertAdmin({
    email: readRequired('ADMIN_EMAIL', 'ADMIN_EMAIL_FILE'),
    displayName: process.env.ADMIN_DISPLAY_NAME || '米粿管理员',
    password: readRequired('ADMIN_PASSWORD', 'ADMIN_PASSWORD_FILE')
  });
  process.stdout.write(`${JSON.stringify({ ok: true, user: publicUser(user) })}\n`);
} finally {
  db.close();
}
