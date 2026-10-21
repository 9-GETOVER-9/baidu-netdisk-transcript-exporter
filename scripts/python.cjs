const {spawnSync} = require('node:child_process');
const result = spawnSync(process.env.PYTHON || 'python', process.argv.slice(2), {stdio:'inherit', env:{...process.env, PYTHONIOENCODING:'utf-8'}});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
