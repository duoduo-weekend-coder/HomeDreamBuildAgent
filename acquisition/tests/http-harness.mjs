import { Readable, Writable } from 'node:stream';

// Exercise the production HTTP handler without binding a socket. This works
// inside restricted CI sandboxes and captures streamed file responses too.
export async function inject(handler, route, options = {}) {
  const body = options.body === undefined ? null : Buffer.from(options.body);
  const req = Readable.from(body ? [body] : []);
  req.method = options.method || 'GET';
  req.url = route;
  req.headers = { host: 'localhost:3000', ...options.headers };
  const chunks = [];
  const headers = new Map();
  const res = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (key, value) => headers.set(key.toLowerCase(), value);
  res.writeHead = (status, values = {}) => {
    res.statusCode = status; res.headersSent = true;
    for (const [key, value] of Object.entries(values)) res.setHeader(key, value);
    return res;
  };
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await handler(req, res);
  await finished;
  const bytes = Buffer.concat(chunks);
  return { status: res.statusCode, headers: Object.fromEntries(headers), bytes, text: () => bytes.toString(), json: () => JSON.parse(bytes.toString()) };
}
