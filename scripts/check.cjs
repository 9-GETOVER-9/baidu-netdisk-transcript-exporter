'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const manifest = require('../manifest.json');
const pkg = require('../package.json');
const files = require('./package-files.json');
assert.equal(pkg.version, manifest.version, 'package/manifest versions differ');
assert.equal(manifest.version_name, manifest.version);
assert.equal(manifest.manifest_version, 3);
assert.equal(pkg.license, 'UNLICENSED', 'Do not invent an upstream license');
assert.equal(new Set(files).size, files.length);
assert.deepEqual([...manifest.permissions].sort(), ['downloads','scripting','storage','tabs']);
assert.deepEqual(manifest.host_permissions, ['https://pan.baidu.com/*','https://*.baidupcs.com/*']);
const refs = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons)];
for (const script of manifest.content_scripts) refs.push(...(script.js || []), ...(script.css || []));
for (const file of files) {
  assert(!path.isAbsolute(file) && !file.split('/').includes('..'));
  assert(fs.statSync(file).isFile(), `Missing package file: ${file}`);
  assert(!fs.lstatSync(file).isSymbolicLink());
  if (file.endsWith('.html')) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) refs.push(m[1]);
    assert(!/<script\b[^>]*>\s*[^\s<]/i.test(html), 'Extension pages must use external scripts');
  }
  if (file.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], {stdio:'inherit'});
    assert.equal(result.status, 0, `Syntax failed: ${file}`);
    for (const call of fs.readFileSync(file,'utf8').matchAll(/importScripts\(([^)]+)\)/g)) {
      for (const m of call[1].matchAll(/['"]([^'"]+)['"]/g)) refs.push(m[1]);
    }
  }
}
for (const ref of refs) assert(files.includes(ref), `Unpackaged runtime reference: ${ref}`);
console.log(`Checked version ${manifest.version}, ${files.length} allowlisted files, syntax and runtime references.`);
