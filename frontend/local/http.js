const { EventEmitter } = require('events');
const { Buffer } = require('buffer');
const pending = new Map();
let sequence = 0;
let handler;
let foreground = true;

exports.setForeground = active => { foreground = active; };
exports.complete = msg => {
  const request = pending.get(msg.id);
  if (!request) return;
  pending.delete(msg.id);
  clearTimeout(request.timer);
  if (msg.error) return request.emit('error', new Error(msg.error));
  const response = new EventEmitter();
  response.statusCode = msg.status;
  response.headers = msg.headers || {};
  request.callback(response);
  response.emit('data', Buffer.from(msg.body || '', 'base64'));
  response.emit('end');
};

exports.request = (url, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  options = options || {};
  const request = new EventEmitter();
  const id = ++sequence;
  const chunks = [];
  request.callback = callback;
  request.write = chunk => chunks.push(Buffer.from(chunk));
  request.destroy = error => {
    pending.delete(id);
    clearTimeout(request.timer);
    self.postMessage({ type: 'cancelNetwork', id });
    request.emit('error', error || new Error('请求取消'));
  };
  request.end = () => {
    if (!foreground) {
      queueMicrotask(() => request.emit('error', new Error('离线模式已暂停，请保持客户端在前台')));
      return;
    }
    pending.set(id, request);
    request.timer = setTimeout(() => request.destroy(new Error('请求超时')), (options.timeout || 15000) + 1500);
    self.postMessage({ type: 'network', id, url: String(url), method: options.method || 'GET',
      headers: options.headers || {}, body: Buffer.concat(chunks).toString('base64'), timeout: options.timeout || 15000 });
  };
  return request;
};

exports.createServer = callback => {
  handler = callback;
  return { listen() { throw new Error('本地引擎不监听网络端口'); } };
};
exports.dispatch = (url, method, body, headers = {}) => new Promise((resolve, reject) => {
  const req = new EventEmitter();
  req.url = url; req.method = method; req.headers = { host: 'localhost', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  let status = 200;
  let responseHeaders = {};
  const res = {
    writeHead(code, values) { status = code; responseHeaders = values || {}; },
    end(bytes) { resolve({ status, headers: responseHeaders, body: Buffer.from(bytes || '').toString('base64') }); }
  };
  Promise.resolve(handler(req, res)).catch(reject);
  queueMicrotask(() => {
    if (body !== null && body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
});
