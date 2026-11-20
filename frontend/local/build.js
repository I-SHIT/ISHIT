const fs = require('fs');
const path = require('path');
const browserify = require('browserify');
const builtins = require('browserify/lib/builtins');
const root = path.resolve(__dirname, '../..');
const bundle = browserify(path.join(__dirname, 'worker.js'), {
  basedir: root,
  builtins: { ...builtins, fs: path.join(__dirname, 'fs.js'), http: path.join(__dirname, 'http.js'),
    https: path.join(__dirname, 'http.js'), crypto: path.join(__dirname, 'crypto.js'),
    path: require.resolve('path-browserify'), url: path.join(__dirname, 'url.js') }
});
bundle.bundle((err, buffer) => {
  if (err) { console.error(err); process.exitCode = 1; return; }
  const source = 'window.ISHIT_LOCAL_WORKER_SOURCE = ' + JSON.stringify(buffer.toString('utf8')) + ';\n';
  for (const dir of ['frontend/web', 'frontend/android/src/main/assets/web']) {
    fs.writeFileSync(path.join(root, dir, 'local-engine.js'), source);
  }
  fs.cpSync(path.join(root, 'frontend/web'), path.join(root, 'frontend/android/src/main/assets/web'), { recursive: true, filter: file => !['.nojekyll', 'CNAME'].includes(path.basename(file)) });
  console.log('Local engine generated (' + buffer.length + ' bytes)');
});
