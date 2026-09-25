#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(m => m[1])
  .filter(s => s.trim());
const files = [];
const outDir = path.join(root, '.tmp-syntax');
fs.mkdirSync(outDir, { recursive: true });
inline.forEach((source, i) => {
  const file = path.join(outDir, `block-${i}.js`);
  fs.writeFileSync(file, source);
  files.push({ label: `inline block ${i}`, file });
});
for (const name of fs.readdirSync(path.join(root, 'src')).filter(n => n.endsWith('.js')).sort()) {
  files.push({ label: `src/${name}`, file: path.join(root, 'src', name) });
}
let failed = false;
for (const { label, file } of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`${label} failed syntax check\n${result.stderr}`);
  }
}
if (failed) process.exit(1);
console.log(`syntax OK: ${inline.length} inline script blocks; ${files.length - inline.length} src modules`);