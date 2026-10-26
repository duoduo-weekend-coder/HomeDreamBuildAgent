import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createWebhookProxy } from '../tools/instagram-webhook-proxy.mjs';

test('public proxy preserves webhook signatures and exposes only scoped customer routes', async t => {
  const seen = [];
  const origin = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, signature: req.headers['x-hub-signature-256'], body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization });
    res.writeHead(req.method === 'GET' ? 200 : 403, { 'content-type': 'text/plain' });
    res.end(req.method === 'GET' ? 'challenge-value' : 'invalid signature');
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const proxy = createWebhookProxy({ targetPort: origin.address().port });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); origin.closeAllConnections(); origin.close(); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  for (const route of ['/', '/api/state', '/uploads/test.png', '/webhooks/instagram/extra']) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  assert.equal((await fetch(base + '/webhooks/instagram', { method: 'DELETE' })).status, 405);
  assert.equal(seen.length, 0);
  const challenge = await fetch(base + '/webhooks/instagram?hub.mode=subscribe&hub.challenge=challenge-value');
  assert.equal(await challenge.text(), 'challenge-value');
  const bytes = '{ "message": "客户", "spacing":  true }';
  const signed = await fetch(base + '/webhooks/instagram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=example', authorization: 'Bearer should-not-forward' }, body: bytes });
  assert.equal(signed.status, 403);
  assert.equal(seen[1].body, bytes);
  assert.equal(seen[1].signature, 'sha256=example');
  assert.equal(seen[1].authorization, undefined);
  assert.equal((await fetch(base + '/webhooks/instagram', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
  assert.equal(seen.length, 2);
  const page=await fetch(base+'/customer');assert.equal(page.status,200);
  await fetch(base+'/api/customer/session',{headers:{authorization:'Bearer scoped-customer-capability'}});assert.equal(seen.at(-1).authorization,'Bearer scoped-customer-capability');
  await fetch(base+'/api/customer/reschedule',{method:'POST',headers:{authorization:'Bearer scoped-change'},body:'{}'});assert.equal(seen.at(-1).url,'/api/customer/reschedule');assert.equal(seen.at(-1).authorization,'Bearer scoped-change');
  assert.equal((await fetch(base+'/api/customer/reschedule')).status,405);
  assert.equal((await fetch(base+'/api/customer/book',{method:'POST',headers:{origin:'https://unrelated.example'},body:'{}'})).status,403);
  for(const route of ['/api/customer/contacts','/api/contacts','/customer.html','/customer/extra'])assert.equal((await fetch(base+route)).status,404);
});
