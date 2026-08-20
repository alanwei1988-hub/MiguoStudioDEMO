import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const SECRET_KEY_PATTERN = /(api[-_ ]?key|token|secret|authorization|x-api-token|password)/i;

export function redactSensitive(value, knownSecrets = []) {
  const secrets = knownSecrets.filter(Boolean);
  const visit = (input, key = '') => {
    if (input == null) return input;
    if (SECRET_KEY_PATTERN.test(key)) return '<redacted>';
    if (typeof input === 'string') {
      return secrets.reduce((result, secret) => result.split(secret).join('<redacted>'), input);
    }
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    }
    return input;
  };
  return visit(value);
}

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
  }
  return true;
}

export async function assertSafeProviderUrl(rawUrl, allowedHosts = ['factory.miguocomics.com']) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Provider URL must use HTTPS.');
  if (!allowedHosts.includes(url.hostname)) throw new Error(`Provider host is not approved: ${url.hostname}`);
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw new Error('Provider hostname resolved to a private or invalid address.');
  }
  return url;
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
