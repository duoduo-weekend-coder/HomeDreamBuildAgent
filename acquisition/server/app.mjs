import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { createStore } from './store.mjs';
import { AppError, requiredText } from './domain.mjs';
import { createConfig } from './acquisition/config.mjs';
import { createProviders } from './acquisition/providers.mjs';
import { createAcquisitionService } from './acquisition/service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const uploadTypes = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'application/pdf': '.pdf' };
async function readBytes(req, limit = 100000) {
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > limit) throw new AppError('Request is too large.', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function parseJson(bytes) {
  try { const body = JSON.parse(bytes.toString() || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
  catch { throw new AppError('Request must contain a JSON object.'); }
}
const readJson = async (req, limit) => parseJson(await readBytes(req, limit));
function sendJson(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); }

export function createApp(options = {}) {
  const env = options.env || process.env;
  const dataDir = options.dataDir || path.resolve(root, env.DATA_DIR || 'data');
  mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  mkdirSync(path.join(dataDir, 'private'), { recursive: true });
  const store = options.store || createStore(path.join(dataDir, 'workspace.sqlite'));
  const config = options.config || createConfig(path.join(root, 'config'));
  const providers = options.providers || createProviders(env, dataDir);
  const service = createAcquisitionService({ store, config, providers, env, dataDir, seed: options.seed !== false && env.SEED_DEMO !== 'false', agent: options.agent });

  async function upload(body, contactId) {
    const name = requiredText(body.name, 'File name', 200);
    const type = body.mimeType;
    if (!Object.hasOwn(uploadTypes, type) || (!contactId && type === 'application/pdf')) throw new AppError('Use PNG, JPEG or WebP for reference media; customer plans may also be PDFs.');
    if (typeof body.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) throw new AppError('Invalid file data.');
    const bytes = Buffer.from(body.base64, 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new AppError('Files must be between 1 byte and 8 MB.', 413);
    const valid = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : type === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' : bytes.toString('ascii', 0, 5) === '%PDF-';
    if (!valid) throw new AppError('File contents do not match the media type.');
    const id = randomUUID(), filename = `${id}${uploadTypes[type]}`;
    const sourceFile = path.join(dataDir, contactId ? 'private' : 'uploads', filename);
    let project;
    if (contactId) { const conv = service.requireRecord('conversations', contactId); project = service.requireRecord('projects', conv.projectId); }
    writeFileSync(sourceFile, bytes);
    const relative = contactId ? `collected-data/projects/${project.id}/attachments/${filename}` : `source-materials/files/${filename}`;
    store.put('acq_sync_jobs', { id: `binary-${id}`, binary: true, path: relative, sourceFile, mimeType: type, revision: randomUUID(), status: 'pending', attempts: 0 });
    let result;
    if (project) {
      result = { id, name, mimeType: type, size: bytes.length, private: true, path: relative, uploadedAt: new Date().toISOString() };
      service.put('projects', { ...project, attachments: [...project.attachments, result] });
    } else result = service.addAsset({ title: body.title || name, url: `/uploads/${filename}`, tags: body.tags || '', approved: body.approved === true, description: body.description || '' });
    if (providers.modes.drive === 'mock') await service.sync();
    return result;
  }

  async function webhook(req, res, url) {
    if (req.method === 'GET') {
      if (!env.INSTAGRAM_VERIFY_TOKEN || url.searchParams.get('hub.mode') !== 'subscribe' || !equal(url.searchParams.get('hub.verify_token'), env.INSTAGRAM_VERIFY_TOKEN)) throw new AppError('Webhook verification failed.', 403);
      res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(url.searchParams.get('hub.challenge') || '');
    }
    if (req.method !== 'POST') throw new AppError('Method not allowed.', 405);
    const bytes = await readBytes(req, 1024 * 1024);
    const signature = env.INSTAGRAM_APP_SECRET ? `sha256=${createHmac('sha256', env.INSTAGRAM_APP_SECRET).update(bytes).digest('hex')}` : '';
    if (!signature || !equal(signature, req.headers['x-hub-signature-256'])) throw new AppError('Webhook signature is invalid.', 403);
    const body = parseJson(bytes);
    let accepted = 0;
    for (const entry of body.entry || []) {
      if (String(entry.id) !== env.INSTAGRAM_ACCOUNT_ID) continue;
      for (const change of entry.changes || []) {
        // Live broadcasts have different reply deadlines and are not enabled here.
        if (change.field === 'comments') {
          const comment = service.comments.receive(change.value || {}, entry.time);
          if (comment) { accepted++; void service.comments.run(comment.id).then(() => service.sync()).catch(() => {}); }
        }
      }
      for (const item of entry.messaging || []) {
        const msg = item.message;
        if (!msg?.mid) continue;
        if (msg.is_echo) {
          await service.receiveEcho(msg.mid,item.recipient?.id);
          continue;
        }
        if (String(item.recipient?.id) !== env.INSTAGRAM_ACCOUNT_ID || !item.sender?.id || !item.timestamp) continue;
        const externalId = String(item.sender.id);
        const c = service.createContact({ handle: `ig_${externalId}`, instagramId: externalId, name: `Instagram ${externalId}`, source: 'Instagram webhook', demo: false });
        if (c.handle.startsWith('ig_') && providers.instagram.profile) void providers.instagram.profile(externalId).then(profile => {
          const latest = service.get('contacts', c.id);
          if (latest && /^[a-zA-Z0-9_.]{1,100}$/.test(profile?.username || '')) service.put('contacts', { ...latest, handle: profile.username, name: profile.name || profile.username });
        }).catch(() => {});
        const referenced = service.content.find(msg.reply_to?.story?.id || item.referral?.ref || msg.attachments?.find(a => a.type === 'share')?.payload?.url);
        const attachmentOnly = !msg.text && msg.attachments?.length;
        const text = msg.text || (attachmentOnly ? referenced ? '[Customer shared this video post]' : '[Customer shared an attachment; human review required]' : '');
        if (!text) continue;
        if (attachmentOnly && !referenced) service.handoff(c.id, 'Customer attachment received; import and review the original in Instagram.');
        await service.receive({ contactId: c.id, eventId: `${entry.id}:${msg.mid}`, text, quickReplyPayload: msg.quick_reply?.payload, receivedAt: new Date(item.timestamp).toISOString(), ...(referenced ? { postId: referenced.id } : {}) }, true);
        accepted++;
      }
    }
    return sendJson(res, { received: true, accepted });
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const url = new URL(req.url, 'http://localhost'), route = url.pathname, method = req.method;
    if (route === '/webhooks/instagram') return webhook(req, res, url);
    if (!['GET', 'HEAD'].includes(method) && req.headers.origin) {
      let origin; try { origin = new URL(req.headers.origin); } catch { throw new AppError('Invalid origin.', 403); }
      if (origin.host !== req.headers.host) throw new AppError('Cross-origin writes are not allowed.', 403);
    }
    if (route.startsWith('/api/customer/')) {
      const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
      if (route==='/api/customer/session' && method==='GET') return sendJson(res,service.customerPages.session(token));
      if (route==='/api/customer/slots' && method==='GET') return sendJson(res,await service.customerPages.slots(token));
      if (route==='/api/customer/book' && method==='POST') return sendJson(res,await service.customerPages.book(token,(await readJson(req)).slotId));
      if (route==='/api/customer/reschedule' && method==='POST') return sendJson(res,service.customerPages.startReschedule(token));
      if (route==='/api/customer/intake' && method==='POST') return sendJson(res,await service.customerPages.intake(token,(await readJson(req)).updates));
      throw new AppError('Endpoint not found.',404);
    }
    if (route.startsWith('/api/') || route.startsWith('/uploads/')) {
      if (env.WORKSPACE_TOKEN && !equal(req.headers.authorization, `Bearer ${env.WORKSPACE_TOKEN}`)) throw new AppError('Workspace token required.', 401);
    }
    if (route === '/api/health' && method === 'GET') return sendJson(res, { ok: true, mode: 'acquisition' });
    if (route === '/api/notifications' && method === 'GET') return sendJson(res, service.notifications());
    if (route === '/api/state' && method === 'GET') return sendJson(res, service.state());
    if (route === '/api/contacts' && method === 'POST') return sendJson(res, service.createContact(await readJson(req)), 201);
    if (route === '/api/settings' && method === 'PATCH') return sendJson(res, service.updateSettings(await readJson(req)));
    if (route === '/api/interactions' && method === 'POST') return sendJson(res, service.addInteraction(await readJson(req)), 201);
    if (route === '/api/content-metrics' && method === 'POST') return sendJson(res, service.addMetrics(await readJson(req)), 201);
    if (route === '/api/tasks/run' && method === 'POST') return sendJson(res, await service.runTasks());
    if (route === '/api/sync/run' && method === 'POST') return sendJson(res, await service.sync());
    if (route === '/api/config/reload' && method === 'POST') { config.reload(); service.queueConfigSnapshots(); return sendJson(res, { loaded: true, schema: config.get().schema }); }
    if (route === '/api/assets' && method === 'POST') return sendJson(res, await upload(await readJson(req, 12 * 1024 * 1024)), 201);
    if (route === '/api/library/import-drive' && method === 'POST') return sendJson(res, await service.importLibrary());
    if (route === '/api/content/sources' && method === 'POST') return sendJson(res, service.content.registerSource(await readJson(req)), 201);
    if (route === '/api/content/posts' && method === 'POST') return sendJson(res, service.content.upsert(await readJson(req, 1024 * 1024)), 201);
    const contentRoute = route.match(/^\/api\/content\/posts\/([^/]+)(?:\/(inspect))?$/);
    if (contentRoute && method === 'GET' && !contentRoute[2]) return sendJson(res, service.content.read(contentRoute[1], service.settings().quoteMode));
    if (contentRoute && method === 'POST' && contentRoute[2]) return sendJson(res, await service.content.inspect({ ...await readJson(req), postId: contentRoute[1] }, service.settings().quoteMode));
    const assetRoute = route.match(/^\/api\/assets\/([^/]+)(?:\/(file))?$/);
    if (assetRoute && method === 'PATCH' && !assetRoute[2]) return sendJson(res, service.approveAsset(assetRoute[1], (await readJson(req)).approved));
    if (assetRoute && method === 'GET' && assetRoute[2]) {
      const asset = service.requireRecord('assets', assetRoute[1]);
      if (!asset.driveFileId) throw new AppError('This asset is not a Drive image.', 404);
      const image = await providers.drive.readSourceFile(asset.driveFileId);
      res.writeHead(200, { 'content-type': image.mimeType, 'content-length': image.bytes.length, 'cache-control': 'private, no-store' }); return res.end(image.bytes);
    }
    if (['/api/estimates', '/api/leads', '/api/campaigns'].includes(route)) throw new AppError('Legacy marketing and ungated quote endpoints are disabled. Use the acquisition workflow.', 410);
    const contactRoute = route.match(/^\/api\/contacts\/([^/]+)\/(messages|mode|reply|facts|project|projects|handoff|outreach|followup|attachments|source-post|customer-link)$/);
    if (contactRoute && ['POST', 'PATCH'].includes(method)) {
      const [, id, action] = contactRoute;
      const body = await readJson(req, action === 'attachments' ? 12 * 1024 * 1024 : 100000);
      let result;
      if (action === 'customer-link') { if (!['booking','intake'].includes(body.kind)) throw new AppError('Invalid customer page.');result=service.customerPages.create(id,body.kind); }
      if (action === 'messages') {
        if (providers.modes.instagram !== 'mock') throw new AppError('Simulated inbound messages are disabled for live Instagram.', 403);
        result = await service.receive({ ...body, contactId: id, eventId: body.eventId || randomUUID() });
      }
      if (action === 'mode') result = await service.mode(id, body);
      if (action === 'reply') result = await service.humanReply(id, body);
      if (action === 'facts') result = service.saveFacts(id, body);
      if (action === 'project') result = service.updateProject(id, body);
      if (action === 'projects') result = service.newProject(id, body);
      if (action === 'handoff') result = service.handoff(id, requiredText(body.reason, 'Handoff reason', 500), body.priority, { scope: body.scope, topicKey: body.topicKey });
      if (action === 'outreach') result = service.queueOutreach(id);
      if (action === 'followup') result = service.scheduleFollowup(id, body);
      if (action === 'attachments') result = await upload(body, id);
      if (action === 'source-post') result = service.linkPost(id, body.postId);
      return sendJson(res, result);
    }
    const handoffRoute = route.match(/^\/api\/handoffs\/([^/]+)\/resolve$/);
    const retryRoute = route.match(/^\/api\/inbound-events\/([^/]+)\/retry$/);
    if (retryRoute && method === 'POST') return sendJson(res, await service.retryFailedEvent(retryRoute[1]));
    const commentRoute = route.match(/^\/api\/comments\/([^/]+)\/(public|private)\/approve$/);
    if (commentRoute && method === 'POST') return sendJson(res, await service.comments.execute(commentRoute[1], commentRoute[2]));
    if (handoffRoute && method === 'POST') return sendJson(res, await service.resolveHandoff(handoffRoute[1], await readJson(req)));
    const actionRoute = route.match(/^\/api\/(messages|outreach|bookings)\/([^/]+)\/(approve|execute|reconcile|cancel)$/);
    if (actionRoute && method === 'POST') {
      const [, kind, id, action] = actionRoute; const body = await readJson(req);
      if (kind === 'messages' && action === 'approve') return sendJson(res, await service.approveReply(id));
      if (kind === 'outreach' && action === 'execute') return sendJson(res, await service.executeOutreach(id));
      if (kind === 'outreach' && action === 'reconcile') return sendJson(res, service.reconcileOutreach(id, body));
      if (kind === 'bookings' && action === 'cancel') return sendJson(res, await service.cancelBooking(id));
      if (kind === 'bookings' && action === 'reconcile') return sendJson(res, await service.reconcileBooking(id));
    }
    if (route.startsWith('/api/')) throw new AppError('Endpoint not found.', 404);
    if (!['GET', 'HEAD'].includes(method)) throw new AppError('Method not allowed.', 405);
    const isUpload = route.startsWith('/uploads/');
    const directory = isUpload ? path.join(dataDir, 'uploads') : path.join(root, 'public');
    let relative; try { relative = decodeURIComponent(isUpload ? route.slice(9) : route.slice(1)); } catch { throw new AppError('Invalid path.'); }
    if (['', 'intake'].includes(relative) && !isUpload) relative = 'index.html';
    if (relative === 'customer' && !isUpload) relative = 'customer.html';
    const filename = path.resolve(directory, relative);
    if (!filename.startsWith(directory + path.sep) || !existsSync(filename) || !statSync(filename).isFile() || !mime[path.extname(filename)]) throw new AppError('File not found.', 404);
    res.writeHead(200, { 'content-type': mime[path.extname(filename)], 'cache-control': isUpload ? 'private, no-store' : 'no-cache', 'content-length': statSync(filename).size });
    if (method === 'HEAD') return res.end();
    return createReadStream(filename).pipe(res);
  }
  const handler = (req, res) => handle(req, res).catch(error => {
    if (res.headersSent) return res.end();
    const status = error instanceof AppError ? error.status : 500;
    if (status === 500) console.error(error);
    sendJson(res, { error: status === 500 ? 'Unexpected server error. Check the server log.' : error.message }, status);
  });
  const server = http.createServer(handler);
  return { server, handler, store, service, providers, close: () => store.close() };
}
