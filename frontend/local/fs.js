const { Buffer } = require('buffer');
const path = require('path');
const files = new Map();
let revision = 0;
const key = file => path.resolve('/', file);

exports.load = snapshot => {
  files.clear();
  for (const [name, value] of Object.entries(snapshot || {})) files.set(key(name), Buffer.from(value, 'base64'));
};
exports.snapshot = () => Object.fromEntries([...files].map(([name, bytes]) => [name, bytes.toString('base64')]));
exports.revision = () => revision;
exports.mkdirSync = () => {};
exports.existsSync = file => files.has(key(file));
exports.readFileSync = (file, encoding) => {
  const data = files.get(key(file));
  if (!data) throw new Error('文件不存在 ' + file);
  return encoding ? data.toString(encoding) : Buffer.from(data);
};
exports.writeFileSync = (file, data, encoding) => {
  const name = key(file);
  const bytes = Buffer.from(data, encoding || 'utf8');
  files.set(name, bytes);
  self.postMessage({ type: 'persist', revision: ++revision, path: name, value: bytes.toString('base64') });
};
exports.readdirSync = dir => [...files.keys()].filter(p => path.dirname(p) === key(dir)).map(p => path.basename(p));
exports.statSync = file => ({ isFile: () => files.has(key(file)), mtimeMs: 0 });
