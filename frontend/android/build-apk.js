const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const andRoot = 'E:\\LynnH Ma\\Progarmming\\ISHIT\\frontend\\android';
const buildDir = path.join(andRoot, 'build');
const genJavaDir = path.join(buildDir, 'gen');
const classesDir = path.join(buildDir, 'classes');
const dexDir = path.join(buildDir, 'dex');
const resFlatDir = path.join(buildDir, 'flat');

fs.rmSync(buildDir, { recursive: true, force: true });
for (const d of [genJavaDir, classesDir, dexDir, resFlatDir]) {
  fs.mkdirSync(d, { recursive: true });
}

const btDir = 'D:\\OpenAI\\BuildTools\\android-sdk\\build-tools\\android-14';
const androidJar = 'D:\\OpenAI\\BuildTools\\android-sdk\\platforms\\android-34\\android.jar';
const jdkBin = 'C:\\Program Files\\Java\\jdk-25.0.4\\bin';
const javaExe = path.join(jdkBin, 'java.exe');
const javacExe = path.join(jdkBin, 'javac.exe');
const keytoolExe = path.join(jdkBin, 'keytool.exe');
const jarExe = path.join(jdkBin, 'jar.exe');

function walkFiles(dir, ext) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walkFiles(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

console.log('[1/6] Compiling resources with aapt2...');
execFileSync(path.join(btDir, 'aapt2.exe'), [
  'compile',
  '--dir', path.join(andRoot, 'src', 'main', 'res'),
  '-o', path.join(resFlatDir, 'res.zip')
], { stdio: 'inherit' });

console.log('[2/6] Linking resources with aapt2...');
const unalignedApk = path.join(buildDir, 'unsigned-unaligned.apk');
execFileSync(path.join(btDir, 'aapt2.exe'), [
  'link',
  '-I', androidJar,
  '--manifest', path.join(andRoot, 'src', 'main', 'AndroidManifest.xml'),
  '--java', genJavaDir,
  '-o', unalignedApk,
  path.join(resFlatDir, 'res.zip')
], { stdio: 'inherit' });

console.log('[3/6] Compiling Java sources with javac...');
const javaFiles = [
  ...walkFiles(path.join(andRoot, 'src', 'main', 'java'), '.java'),
  ...walkFiles(genJavaDir, '.java')
];
execFileSync(javacExe, [
  '-source', '8',
  '-target', '8',
  '-bootclasspath', androidJar,
  '-encoding', 'UTF-8',
  '-d', classesDir,
  ...javaFiles
], { stdio: 'inherit' });

console.log('[4/6] Converting bytecode to DEX with d8...');
const classFiles = walkFiles(classesDir, '.class');
execFileSync(javaExe, [
  '-cp', path.join(btDir, 'lib', 'd8.jar'),
  'com.android.tools.r8.D8',
  '--min-api', '24',
  '--lib', androidJar,
  '--output', dexDir,
  ...classFiles
], { stdio: 'inherit' });

console.log('[5/6] Adding classes.dex and assets/web with forward slashes...');
execFileSync(jarExe, [
  '-uf', unalignedApk,
  '-C', dexDir, 'classes.dex',
  '-C', path.join(andRoot, 'src', 'main'), 'assets'
], { stdio: 'inherit' });

const alignedApk = path.join(buildDir, 'unsigned-aligned.apk');
execFileSync(path.join(btDir, 'zipalign.exe'), [
  '-f', '-p', '4',
  unalignedApk,
  alignedApk
], { stdio: 'inherit' });

console.log('[6/6] Signing APK with apksigner...');
const keystore = path.join(andRoot, 'ishit-release.jks');
if (!fs.existsSync(keystore)) {
  execFileSync(keytoolExe, [
    '-genkeypair', '-v',
    '-keystore', keystore,
    '-alias', 'ishit',
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-storepass', 'ishit2026',
    '-keypass', 'ishit2026',
    '-dname', 'CN=ISHIT, OU=Dev, O=ISHIT, L=SH, ST=SH, C=CN'
  ], { stdio: 'inherit' });
}

const outApk = 'E:\\LynnH Ma\\Progarmming\\ISHIT\\dist\\ISHIT-Android.apk';
execFileSync(javaExe, [
  '-jar', path.join(btDir, 'lib', 'apksigner.jar'),
  'sign', '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
  '--ks', keystore,
  '--ks-key-alias', 'ishit',
  '--ks-pass', 'pass:ishit2026',
  '--key-pass', 'pass:ishit2026',
  '--out', outApk,
  alignedApk
], { stdio: 'inherit' });

execFileSync(javaExe, [
  '-jar', path.join(btDir, 'lib', 'apksigner.jar'),
  'verify', '--verbose',
  outApk
], { stdio: 'inherit' });

const st = fs.statSync(outApk);
console.log('APK built and verified:', outApk, 'Size:', st.size);

// 7. 清理编译临时目录与 idsig 缓存
console.log('[7/7] Cleaning temporary build artifacts...');
fs.rmSync(buildDir, { recursive: true, force: true });
fs.rmSync(outApk + '.idsig', { force: true });
