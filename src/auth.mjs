import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const FALLBACK_SALT = 'miguo-studio-auth-timing-fallback';
const FALLBACK_HASH = scryptSync('not-a-user-password', FALLBACK_SALT, KEY_LENGTH, SCRYPT_OPTIONS);

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateEmail(value) {
  const email = normalizeEmail(value);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('请输入有效的邮箱地址。');
    error.code = 'invalid_email';
    error.statusCode = 422;
    throw error;
  }
  return email;
}

export function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 10 || password.length > 128) {
    const error = new Error('密码长度需为 10–128 个字符。');
    error.code = 'invalid_password';
    error.statusCode = 422;
    throw error;
  }
  return password;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(validatePassword(password), salt, KEY_LENGTH, SCRYPT_OPTIONS).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, user) {
  const supplied = String(password || '');
  try {
    const expected = user?.password_hash ? Buffer.from(user.password_hash, 'hex') : FALLBACK_HASH;
    const salt = user?.password_salt || FALLBACK_SALT;
    const actual = scryptSync(supplied, salt, KEY_LENGTH, SCRYPT_OPTIONS);
    return Boolean(user && expected.length === actual.length && timingSafeEqual(expected, actual));
  } catch {
    return false;
  }
}

export function parseCookies(header = '') {
  const result = {};
  for (const segment of String(header).split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 1) continue;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    organization: user.organization_id ? {
      id: user.organization_id,
      name: user.organization_name,
      role: user.organization_role
    } : null
  };
}

export class AuthService {
  constructor({ db, config }) {
    this.db = db;
    this.config = config;
  }

  registrationEnabled() {
    return this.config.allowRegistration !== false && this.db.countUsers() < this.config.maxUsers;
  }

  register({ email, displayName, password }) {
    if (!this.registrationEnabled()) {
      const error = new Error('当前暂不开放更多注册名额。');
      error.code = 'registration_closed';
      error.statusCode = 403;
      throw error;
    }
    const normalizedEmail = validateEmail(email);
    const name = String(displayName || '').trim();
    if (name.length < 2 || name.length > 40) {
      const error = new Error('昵称长度需为 2–40 个字符。');
      error.code = 'invalid_display_name';
      error.statusCode = 422;
      throw error;
    }
    if (this.db.findUserByEmail(normalizedEmail)) {
      const error = new Error('该邮箱已经注册，请直接登录。');
      error.code = 'email_already_registered';
      error.statusCode = 409;
      throw error;
    }
    const credentials = hashPassword(password);
    const user = this.db.createUser({
      email: normalizedEmail,
      displayName: name,
      passwordHash: credentials.hash,
      passwordSalt: credentials.salt,
      role: 'member'
    });
    return this.createSession(user);
  }

  login({ email, password }) {
    const normalizedEmail = normalizeEmail(email);
    const user = this.db.findUserByEmail(normalizedEmail);
    if (!verifyPassword(password, user) || user?.status !== 'active') {
      const error = new Error('邮箱或密码不正确。');
      error.code = 'invalid_credentials';
      error.statusCode = 401;
      throw error;
    }
    this.db.recordUserLogin(user.id);
    return this.createSession(this.db.getUser(user.id));
  }

  createSession(user) {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.sessionDays * 86_400_000).toISOString();
    this.db.createSession({
      id: randomUUID(),
      userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      csrfToken,
      expiresAt
    });
    return { token, csrfToken, expiresAt, user: publicUser(user) };
  }

  authenticate(token) {
    if (!token) return null;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return this.db.getSessionByTokenHash(tokenHash);
  }

  logout(token) {
    if (!token) return;
    this.db.deleteSessionByTokenHash(createHash('sha256').update(token).digest('hex'));
  }

  upsertAdmin({ email, displayName, password }) {
    const normalizedEmail = validateEmail(email);
    const credentials = hashPassword(password);
    return this.db.upsertAdmin({
      email: normalizedEmail,
      displayName: String(displayName || normalizedEmail.split('@')[0]).trim().slice(0, 40),
      passwordHash: credentials.hash,
      passwordSalt: credentials.salt
    });
  }
}
