const crypto = require('crypto-browserify');
crypto.randomUUID = () => self.crypto.randomUUID ? self.crypto.randomUUID() :
  '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
    (Number(c) ^ self.crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16));
const { Buffer } = require('buffer');
for (const method of ['createCipheriv', 'createDecipheriv']) {
  const original = crypto[method];
  crypto[method] = (algorithm, key, iv) => original(algorithm, key, iv === null ? Buffer.alloc(0) : iv);
}
module.exports = crypto;
