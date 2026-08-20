import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const excludedDirectories = new Set(['.git', 'node_modules']);
const excludedFiles = new Set(['.env']);
const maxFileBytes = 64 * 1024 * 1024;

function variants(secret) {
  const raw = Buffer.from(secret, 'utf8');
  const values = new Map([
    [secret, 'raw'],
    [encodeURIComponent(secret), 'url-encoded'],
    [raw.toString('base64'), 'base64'],
    [raw.toString('base64url'), 'base64url'],
    [`Bearer ${secret}`, 'bearer-header']
  ]);
  if (secret.length >= 32) {
    values.set(secret.slice(0, 20), 'leading-fragment');
    values.set(secret.slice(-20), 'trailing-fragment');
  }
  return [...values].filter(([value]) => value.length >= 12);
}

async function collect(directory, output = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute, output);
    else if (!excludedFiles.has(entry.name)) output.push(absolute);
  }
  return output;
}

const knownSecrets = [process.env.MIGUO_API_TOKEN, process.env.MIGUO_STORYARK_API_TOKEN, process.env.P0_SECRET_CANARY]
  .filter((value) => typeof value === 'string' && value.length >= 12);
const knownVariants = knownSecrets.flatMap(variants);
const findings = [];

for (const file of await collect(root)) {
  const stat = await fs.stat(file);
  if (stat.size > maxFileBytes) {
    findings.push({ file, type: 'file-too-large-to-scan' });
    continue;
  }
  const buffer = await fs.readFile(file);
  const text = buffer.toString('utf8');
  for (const [value, type] of knownVariants) {
    if (buffer.includes(Buffer.from(value, 'utf8'))) findings.push({ file, type: `known-secret-${type}` });
  }
  if (!text.includes('\uFFFD')) {
    const assignment = /(?:MIGUO(?:_STORYARK)?_API_TOKEN|x-api-token|authorization)[ \t]*["']?[ \t]*[:=][ \t]*["']?([^\s"'`,;}]{12,})/ig;
    for (const match of text.matchAll(assignment)) {
      const candidate = match[1];
      if (/^(?:your|example|placeholder|changeme|process\.env|runtimeConfig|config\.|MIGUO_|\$\{|<)/i.test(candidate)) continue;
      if (/^(?:MIGUO_MCP_URL|https?:\/\/)/i.test(candidate)) continue;
      if (/^(?:apiToken|accountId|this\.|knownSecrets)/i.test(candidate)) continue;
      findings.push({ file, type: 'credential-like-assignment' });
    }
  }
}

const unique = [...new Map(findings.map((item) => [`${item.file}:${item.type}`, item])).values()];
if (unique.length) {
  process.stderr.write(`Secret scan failed with ${unique.length} finding(s). Values are intentionally hidden.\n`);
  for (const finding of unique) {
    process.stderr.write(`- ${path.relative(root, finding.file)} [${finding.type}]\n`);
  }
  process.exit(1);
}

process.stdout.write(`Secret scan passed across project files. Authorized local .env was excluded; node_modules and .git were skipped.\n`);
