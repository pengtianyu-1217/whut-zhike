#!/usr/bin/env node
// Release validator for the whut-zhike skill.
// Usage: node scripts/validate.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const skillDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirName = skillDir.split(/[\\/]/).filter(Boolean).pop();
const checks = [];
const fail = (name, detail) => checks.push({ ok: false, name, detail });
const pass = (name, detail = '') => checks.push({ ok: true, name, detail });

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(skillDir);
const read = (p) => readFileSync(join(skillDir, p), 'utf8');

// 1. SKILL.md frontmatter
const skillPath = join(skillDir, 'SKILL.md');
if (!existsSync(skillPath)) fail('SKILL.md exists', 'missing');
else {
  const text = readFileSync(skillPath, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) fail('frontmatter', 'no --- block');
  else {
    const fm = m[1];
    const get = (key) => {
      const line = fm.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'));
      return line ? line[1].trim().replace(/^["']|["']$/g, '') : null;
    };
    const name = get('name');
    const description = get('description');
    if (name === dirName) pass('name matches directory', name);
    else fail('name matches directory', `name=${name} dir=${dirName}`);

    if (description && description.length <= 1024) pass('description length', String(description.length));
    else fail('description length', description ? String(description.length) : 'missing');

    for (const trigger of ['理工智课', 'whut', '匹配题', '简答题', '单选题']) {
      if (description && description.includes(trigger)) pass('description trigger: ' + trigger);
      else fail('description trigger: ' + trigger, 'missing');
    }

    if (get('license')) pass('license field', get('license'));
    else fail('license field', 'missing');

    if (get('compatibility')) pass('compatibility field', 'present');
    else fail('compatibility field', 'missing');

    if (fm.match(/^\s+version:/m)) pass('metadata.version', fm.match(/^\s+version:\s*(.+)$/m)[1].trim());
    else fail('metadata.version', 'missing');
  }
}

// 2. license file
const license = files.find((f) => /(^|[\\/])LICENSE$/.test(f));
if (license) pass('LICENSE file', relative(skillDir, license));
else fail('LICENSE file', 'missing');

// 3. referenced files
const skillText = read('SKILL.md');
for (const ref of skillText.match(/references\/[a-z0-9_-]+\.md/gi) || []) {
  if (existsSync(join(skillDir, ref))) pass('reference exists: ' + ref);
  else fail('reference exists: ' + ref, 'missing');
}

// 4. no personal data / machine paths
const forbidden = [
  '彭天宇', '7056040258755896366', '7056039861043646293', '7056040444664238063',
  'scratchpad', 'E:\\Desktop', 'D:\\Cache', 'C:\\Users',
];
const hits = [];
for (const file of files) {
  if (file.endsWith('validate.mjs')) continue;
  const text = readFileSync(file, 'utf8');
  for (const needle of forbidden) {
    if (text.includes(needle)) hits.push(`${relative(skillDir, file)}: ${needle}`);
  }
}
if (hits.length) fail('no personal data / machine paths', hits.join('; '));
else pass('no personal data / machine paths', `${files.length} files scanned`);

// 5. JS syntax — 所有脚本（含 scripts/lib、*.js 探针）
const jsFiles = files.filter((f) => /\.(mjs|js)$/.test(f) && /[\\/]scripts[\\/]/.test(f));
let badSyntax = 0;
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    badSyntax++;
    fail('syntax: ' + relative(skillDir, f), String(e.stderr || e.message).slice(0, 200));
  }
}
if (!badSyntax) pass(`JS syntax (${jsFiles.length} files)`);

// 6. no runtime dependencies
const pkg = files.find((f) => /package\.json$/.test(f));
pass('no package.json / runtime deps', pkg ? 'found (review manually)' : 'none');

// report
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  —  ' + c.detail : ''}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
