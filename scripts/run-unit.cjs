const {readdirSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
const files = readdirSync('tests').filter(f => f.endsWith('.cjs')).sort().map(f => `tests/${f}`);
const result = spawnSync(process.execPath, ['--test', ...files], {stdio:'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
