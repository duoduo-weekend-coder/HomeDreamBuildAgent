import http from 'node:http';

// Expose the Instagram callback and scoped customer pages through a development HTTPS tunnel.
// The application behind this proxy verifies Meta signatures and verify tokens.
export function createWebhookProxy({ targetPort = 3000, onResponse = () => {} } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const customerStatic=['/customer','/customer.js','/customer.css'].includes(url.pathname);
    const customerApi=['/api/customer/session','/api/customer/slots','/api/customer/book','/api/customer/intake','/api/customer/reschedule'].includes(url.pathname);
    if (url.pathname !== '/webhooks/instagram' && !customerStatic && !customerApi) {
      res.writeHead(404); res.end('Not found'); return;
    }
    if (!['GET', 'POST'].includes(req.method)) {
      res.writeHead(405); res.end('Method not allowed'); return;
    }
    if ((customerStatic && req.method!=='GET') || (customerApi && (['/api/customer/book','/api/customer/intake','/api/customer/reschedule'].includes(url.pathname) ? req.method!=='POST' : req.method!=='GET'))) {res.writeHead(405);res.end('Method not allowed');return;}
    if (customerApi && req.headers.origin) {
      try { if(new URL(req.headers.origin).host !== req.headers.host)throw new Error(); }
      catch {res.writeHead(403);res.end('Cross-origin write rejected');return;}
    }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { res.writeHead(413); res.end('Too large'); return; }
        chunks.push(chunk);
      }
      const headers = {};
      for (const name of ['content-type', 'x-hub-signature-256']) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
      if (customerApi && req.headers.authorization) headers.authorization=req.headers.authorization;
      const upstream = await fetch(`http://127.0.0.1:${targetPort}${url.pathname}${url.search}`, {
        method: req.method, headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(25000),
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'text/plain',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        ...(upstream.headers.get('content-security-policy') ? {'content-security-policy':upstream.headers.get('content-security-policy')} : {}),
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
      onResponse({ method: req.method, status: upstream.status });
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end('Webhook service unavailable');
    }
  });
}

if (import.meta.main) {
  const proxy = createWebhookProxy({
    targetPort: Number(process.env.PORT || 3000),
    onResponse: ({ method, status }) => console.log(`${new Date().toISOString()} Instagram webhook ${method}: ${status}`),
  });
  const port = Number(process.env.WEBHOOK_PROXY_PORT || 3001);
  proxy.listen(port, '127.0.0.1', () => console.log(`Instagram callback proxy on 127.0.0.1:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => proxy.close());
}
