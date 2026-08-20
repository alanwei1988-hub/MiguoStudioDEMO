import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const prototypeUrl = new URL('../prototypes/miguo-studio-admin.html', import.meta.url);
const productionUrl = new URL('../public/admin.html', import.meta.url);

test('admin prototype covers organizations, accounts, credits, operations and safe model configuration', async () => {
  const html = await fs.readFile(prototypeUrl, 'utf8');
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\brel\s*=\s*["']stylesheet/i);
  assert.match(html, /data-view="organizations"/);
  assert.match(html, /data-view="accounts"/);
  assert.match(html, /data-view="credits"/);
  assert.match(html, /data-view="tasks"/);
  assert.match(html, /data-view="models"/);
  assert.match(html, /data-view="audit"/);
  assert.match(html, /API Key（write-only）/);
  assert.match(html, /autocomplete="new-password"/);
  assert.match(html, /不会保存、发送或写入浏览器存储/);
  assert.match(html, /草稿 →|保存为不可变草稿/);
  assert.match(html, /待核对/);
  assert.match(html, /禁止重试/);
  assert.match(html, /dialog\[open\].*position:fixed/s);
  assert.match(html, /transform:translate\(-50%,-50%\)/);
});

test('production admin website reads protected live data and never stores model secrets in the browser', async () => {
  const html = await fs.readFile(productionUrl, 'utf8');
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\brel\s*=\s*["']stylesheet/i);
  assert.match(html, /\/admin\/dashboard/);
  assert.match(html, /\/admin\/organizations/);
  assert.match(html, /organization-dialog/);
  assert.match(html, /membership-dialog/);
  assert.match(html, /组织、账号、真实任务、积分记录和服务状态/);
  assert.match(html, /共享余额账本尚未启用/);
  assert.match(html, /API Key 不会回传浏览器/);
  assert.doesNotMatch(html, /localStorage\.setItem\([^)]*(api.?key|token|secret)/i);
  assert.match(html, /dialog\[open\].*position:fixed/s);
  assert.match(html, /transform:translate\(-50%,-50%\)/);
});
