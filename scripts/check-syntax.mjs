import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const roots = ['src', 'public', 'prototypes', 'scripts', 'tests'];
const files = [];

function visit(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(absolute);
    else if (/\.(?:mjs|js)$/i.test(entry.name)) files.push(absolute);
  }
}

for (const root of roots) visit(path.resolve(root));

for (const file of files.sort()) {
  const checked = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status || 1);
}

const htmlFiles = [];
function visitHtml(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) visitHtml(absolute);
    else if (/\.html$/i.test(entry.name)) htmlFiles.push(absolute);
  }
}
visitHtml(path.resolve('public'));
visitHtml(path.resolve('prototypes'));
for (const file of htmlFiles.sort()) {
  const html = fs.readFileSync(file, 'utf8');
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)];
  inlineScripts.forEach((match, index) => {
    new vm.Script(match[1], { filename: `${file}#inline-script-${index + 1}` });
  });
}

process.stdout.write(`Syntax check passed for ${files.length} JavaScript files and ${htmlFiles.length} HTML files.\n`);
