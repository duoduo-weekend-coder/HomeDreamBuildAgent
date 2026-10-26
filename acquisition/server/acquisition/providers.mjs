import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../domain.mjs';
import { runBrowserOutreach } from './browser-runner.mjs';
import { calendarSlots } from './calendar-slots.mjs';
import { extractVideoFrames } from './video-frames.mjs';
import { instagramQuickReplies } from './quick-replies.mjs';

async function checkedFetch(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) }); }
  catch { throw new AppError('Provider result is uncertain. Reconcile before retrying a write.', 502); }
  if (!response.ok) throw new AppError(`Provider request failed (${response.status}).`, 502);
  return response.status === 204 ? {} : response.json();
}

function googleTokenProvider(env) {
  let cached;
  let expiresAt = 0;
  return async () => {
    if (env.GOOGLE_ACCESS_TOKEN) return env.GOOGLE_ACCESS_TOKEN;
    if (cached && expiresAt > Date.now() + 60000) return cached;
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) throw new AppError('Google credentials are not configured.', 503);
    const result = await checkedFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
    cached = result.access_token; expiresAt = Date.now() + result.expires_in * 1000;
    return cached;
  };
}

export function createProviders(env, dataDir) {
  const modes = { drive: env.DRIVE_PROVIDER || 'mock', calendar: env.CALENDAR_PROVIDER || 'mock', instagram: env.INSTAGRAM_PROVIDER || 'mock', browser: env.BROWSER_PROVIDER || 'mock' };
  for (const [key, value] of Object.entries(modes)) if (!(key === 'browser' && value === 'browser_use') && !['mock', key === 'drive' || key === 'calendar' ? 'google' : key === 'instagram' ? 'instagram' : 'manual'].includes(value)) throw new Error(`Unsupported ${key} provider: ${value}`);
  if (modes.drive === 'google' && !env.GOOGLE_DRIVE_ROOT_ID) throw new Error('GOOGLE_DRIVE_ROOT_ID is required for live Drive.');
  if ((modes.drive === 'google' || modes.calendar === 'google') && !env.GOOGLE_ACCESS_TOKEN && !(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN)) throw new Error('Google access token or OAuth refresh credentials are required.');
  if (modes.instagram === 'instagram' && (!env.INSTAGRAM_ACCESS_TOKEN || !env.INSTAGRAM_ACCOUNT_ID || !env.INSTAGRAM_API_VERSION || !env.INSTAGRAM_APP_SECRET || !env.INSTAGRAM_VERIFY_TOKEN)) throw new Error('Instagram account, token, API version and webhook credentials are required.');
  const token = googleTokenProvider(env);
  const mirror = path.join(dataDir, 'drive-mirror');
  mkdirSync(mirror, { recursive: true });
  const google = async (url, options = {}) => checkedFetch(url, { ...options, headers: { authorization: `Bearer ${await token()}`, ...options.headers } });
  async function ensureFolder(name, parent) {
    const q = `'${parent.replace(/'/g, "\\'")}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const found = await google(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    if (found.files?.length) return found.files[0].id;
    return (await google('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) })).id;
  }
  const drive = {
    async listSourceFiles() {
      if (modes.drive !== 'google' || !env.GOOGLE_DRIVE_MEDIA_FOLDER_ID) throw new AppError('Set live Google Drive and GOOGLE_DRIVE_MEDIA_FOLDER_ID to import original reference images.', 409);
      const parent = env.GOOGLE_DRIVE_MEDIA_FOLDER_ID.replace(/'/g, "\\'");
      const q = `'${parent}' in parents and trashed = false and (mimeType = 'image/png' or mimeType = 'image/jpeg' or mimeType = 'image/webp')`;
      let pageToken, files = [];
      do {
        const result = await google(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,size,description)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
        files.push(...(result.files || []).filter(file => Number(file.size) <= 8 * 1024 * 1024)); pageToken = result.nextPageToken;
      } while (pageToken && files.length < 500);
      return files;
    },
    async readSourceFile(fileId) {
      if (modes.drive !== 'google') throw new AppError('Live Drive is not configured.', 409);
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new AppError(`Drive image could not be read (${response.status}).`, 502);
      const mimeType = response.headers.get('content-type')?.split(';')[0];
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new AppError('Unsupported reference image.', 400);
      let size = 0; const chunks = [];
      for await (const chunk of response.body) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new AppError('Reference exceeds 8 MB.', 413); chunks.push(Buffer.from(chunk)); }
      return { bytes: Buffer.concat(chunks), mimeType };
    },
    async readVideoFile(fileId) {
      if (modes.drive !== 'google') throw new AppError('Live Drive video access is not configured.',409);
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {headers:{authorization:`Bearer ${await token()}`},signal:AbortSignal.timeout(45000)});
      if(!response.ok)throw new AppError(`Original video could not be read (${response.status}).`,502);
      if(!['video/mp4','video/quicktime','application/octet-stream'].includes(response.headers.get('content-type')?.split(';')[0]))throw new AppError('Expected an original MP4/MOV video.');
      let size=0;const chunks=[];
      for await(const chunk of response.body){size+=chunk.length;if(size>64*1024*1024)throw new AppError('Use a video proxy under 64 MB for on-demand inspection.',413);chunks.push(Buffer.from(chunk));}
      return Buffer.concat(chunks);
    },
    async save(relative, value, { mimeType = 'application/json' } = {}) {
      if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.split('/').includes('..')) throw new AppError('Invalid Drive record path.');
      const content = mimeType === 'text/plain' ? String(value) : JSON.stringify(value, null, 2);
      if (modes.drive === 'mock') {
        const file = path.join(mirror, relative); mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`; writeFileSync(temp, content); renameSync(temp, file);
        return { status: 'local_mirror', fileId: null, path: relative };
      }
      const pieces = relative.split('/'); const name = pieces.pop();
      let parent = env.GOOGLE_DRIVE_ROOT_ID;
      for (const piece of pieces) parent = await ensureFolder(piece, parent);
      const q = `'${parent}' in parents and name = '${name}' and trashed = false`;
      const found = await google(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      let id = found.files?.[0]?.id;
      if (!id) id = (await google('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parents: [parent], mimeType }) })).id;
      await google(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true`, { method: 'PATCH', headers: { 'content-type': mimeType }, body: content });
      return { status: 'synced', fileId: id, path: relative };
    },
    async saveBinary(relative, sourceFile, mimeType) {
      if (modes.drive === 'mock') { const dest = path.join(mirror, relative); mkdirSync(path.dirname(dest), { recursive: true }); copyFileSync(sourceFile, dest); return { status: 'local_mirror', fileId: null, path: relative }; }
      const parts = relative.split('/'); const name = parts.pop(); let parent = env.GOOGLE_DRIVE_ROOT_ID;
      for (const piece of parts) parent = await ensureFolder(piece, parent);
      const q = `'${parent}' in parents and name = '${name}' and trashed = false`;
      const found = await google(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      let id = found.files?.[0]?.id;
      if (!id) id = (await google('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parents: [parent], mimeType }) })).id;
      await google(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true`, { method: 'PATCH', headers: { 'content-type': mimeType }, body: readFileSync(sourceFile) });
      return { status: 'synced', fileId: id, path: relative };
    }
  };
  const calendar = {
    async availability(business, bookings, { limit = 3 } = {}) {
      const slots = calendarSlots(business).map(slot => ({ ...slot, id: createHash('sha256').update(slot.start).digest('hex').slice(0,16) }));
      if (!slots.length) return [];
      let busy = bookings.filter(b => ['confirmed', 'simulated', 'pending', 'unknown'].includes(b.status)).flatMap(b => [{ start: b.start, end: b.end },...(['pending','unknown'].includes(b.rescheduleAttempt?.status)?[{start:b.rescheduleAttempt.start,end:b.rescheduleAttempt.end}]:[])]);
      if (modes.calendar === 'google') {
        const calendarId = env.GOOGLE_CALENDAR_ID || 'primary';
        const result = await google('https://www.googleapis.com/calendar/v3/freeBusy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeMin: slots[0].start, timeMax: slots.at(-1).end, timeZone: business.timezone, items: [{ id: calendarId }] }) });
        const record = result.calendars?.[calendarId];
        if (!record || record.errors?.length) throw new AppError('Calendar availability could not be verified.', 502);
        busy = busy.concat(record.busy || []);
      }
      return slots.filter(slot => !busy.some(b => Date.parse(slot.start) < Date.parse(b.end) && Date.parse(slot.end) > Date.parse(b.start))).slice(0, limit);
    },
    async book({ slot, contact, requestKey, business, summary }) {
      const id = createHash('sha256').update(requestKey).digest('hex');
      if (modes.calendar === 'mock') return { externalId: `demo-${id.slice(0, 12)}`, status: 'simulated', provider: 'mock', url: null };
      const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID || 'primary');
      const result = await google(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, summary: `${business.meetingTitle} · ${contact.name}`, description: summary, start: { dateTime: slot.start, timeZone: business.timezone }, end: { dateTime: slot.end, timeZone: business.timezone }, ...(contact.email ? { attendees: [{ email: contact.email }] } : {}), extendedProperties: { private: { requestKey } } }) });
      return { externalId: result.id, status: 'confirmed', provider: 'google', url: result.htmlLink || null };
    },
    async reschedule({ booking, slot, requestKey }) {
      if(modes.calendar==='mock')return {externalId:booking.externalId,status:'simulated',provider:'mock',url:booking.url||null};
      if(booking.provider!=='google'||!booking.externalId)throw new AppError('The original calendar event must be verified before changing it.',409);
      const url=`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID||'primary')}/events/${encodeURIComponent(booking.externalId)}`;
      const current=await google(url);
      if(current.status==='cancelled')throw new AppError('The original calendar event was cancelled. Verify it before booking again.',409);
      const same=(a,b)=>Date.parse(a)===Date.parse(b);
      if(current.extendedProperties?.private?.rescheduleRequestKey===requestKey && same(current.start?.dateTime,slot.start) && same(current.end?.dateTime,slot.end))return {externalId:current.id,status:'confirmed',provider:'google',url:current.htmlLink||null};
      if(!same(current.start?.dateTime,booking.start)||!same(current.end?.dateTime,booking.end)||!current.etag)throw new AppError('The calendar event changed elsewhere. Verify its current time before changing it.',409);
      const result=await google(url+'?sendUpdates=all',{method:'PATCH',headers:{'content-type':'application/json','If-Match':current.etag},body:JSON.stringify({start:{dateTime:slot.start,timeZone:slot.timezone},end:{dateTime:slot.end,timeZone:slot.timezone},extendedProperties:{...current.extendedProperties,private:{...current.extendedProperties?.private,rescheduleRequestKey:requestKey}}})});
      return {externalId:result.id,status:'confirmed',provider:'google',url:result.htmlLink||null};
    },
    async reconcileReschedule(booking) {
      if(modes.calendar==='mock')return {status:'simulated',start:booking.start,end:booking.end,timezone:booking.timezone,outcome:'not_applied'};
      const event=await google(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID||'primary')}/events/${encodeURIComponent(booking.externalId)}`);
      if(event.status==='cancelled')return {status:'cancelled',outcome:'cancelled'};
      if(!event.start?.dateTime||!event.end?.dateTime)throw new AppError('Calendar result needs manual verification.',409);
      const attempt=booking.rescheduleAttempt;
      const applied=event.extendedProperties?.private?.rescheduleRequestKey===attempt?.requestKey && Date.parse(event.start.dateTime)===Date.parse(attempt.start) && Date.parse(event.end.dateTime)===Date.parse(attempt.end);
      const unchanged=Date.parse(event.start.dateTime)===Date.parse(booking.start) && Date.parse(event.end.dateTime)===Date.parse(booking.end);
      return {status:'confirmed',start:event.start.dateTime,end:event.end.dateTime,timezone:event.start.timeZone||booking.timezone,outcome:applied?'applied':unchanged?'not_applied':'external_change',url:event.htmlLink||null};
    },
    async reconcile(requestKey) {
      if (modes.calendar === 'mock') return null;
      const id = createHash('sha256').update(requestKey).digest('hex');
      const result = await google(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID || 'primary')}/events/${id}`);
      return { externalId: result.id, status: result.status === 'cancelled' ? 'cancelled' : 'confirmed', provider: 'google', url: result.htmlLink || null };
    },
    async cancel(booking) {
      if (modes.calendar === 'google' && booking.provider === 'google') await google(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID || 'primary')}/events/${encodeURIComponent(booking.externalId)}?sendUpdates=all`, { method: 'DELETE' });
      return { status: 'cancelled' };
    }
  };
  const instagram = {
    async profile(id) {
      if (modes.instagram === 'mock') return null;
      return checkedFetch(`https://graph.instagram.com/${env.INSTAGRAM_API_VERSION}/${encodeURIComponent(id)}?fields=username,name`, { headers: { authorization: `Bearer ${env.INSTAGRAM_ACCESS_TOKEN}` } });
    },
    async replyToComment({ commentId, text, privateReply }) {
      if (modes.instagram === 'mock') return { status: 'simulated_sent', externalId: `demo-comment-${randomUUID()}`, delivery: 'unknown' };
      if (!/^\d+$/.test(commentId) || !text?.trim() || Buffer.byteLength(text, 'utf8') > 1000) throw new AppError('Invalid comment reply.', 400);
      const endpoint = privateReply ? `${env.INSTAGRAM_ACCOUNT_ID}/messages` : `${commentId}/replies`;
      const body = privateReply ? { recipient: { comment_id: commentId }, message: { text } } : { message: text };
      const result = await checkedFetch(`https://graph.instagram.com/${env.INSTAGRAM_API_VERSION}/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${env.INSTAGRAM_ACCESS_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const externalId = privateReply ? result.message_id : result.id;
      if (!externalId) throw new AppError('Instagram did not confirm a reply ID.', 502);
      return { status: 'sent', externalId, delivery: 'unknown' };
    },
    async send({ contact, text, media, quickReplies }) {
      const choices = instagramQuickReplies(quickReplies);
      if (modes.instagram === 'mock') return { status: 'simulated_sent', externalId: `demo-message-${randomUUID()}`, delivery: 'unknown' };
      if (!contact.instagramId || contact.demo) throw new AppError('A verified real Instagram identity is required.', 409);
      if (media?.length) throw new AppError('Live media delivery needs public/attachment URLs; source Drive files remain private.', 503);
      if (Buffer.byteLength(text, 'utf8') > 1000) throw new AppError('Instagram text exceeds 1000 bytes; shorten the reply.', 400);
      const result = await checkedFetch(`https://graph.instagram.com/${env.INSTAGRAM_API_VERSION}/${env.INSTAGRAM_ACCOUNT_ID}/messages`, { method: 'POST', headers: { authorization: `Bearer ${env.INSTAGRAM_ACCESS_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ recipient: { id: contact.instagramId }, message: { text, ...(choices.length ? { quick_replies: choices } : {}) } }) });
      return { status: 'sent', externalId: result.message_id, delivery: 'unknown' };
    }
  };
  const browser = {
    async send(job, contact, stillEligible) {
      if (modes.browser === 'browser_use') return runBrowserOutreach({job,contact,env,dataDir,stillEligible});
      if (modes.browser === 'manual') return { status: 'needs_manual_execution', externalId: null, evidence: null };
      return { status: 'simulated_sent', externalId: `demo-browser-${job.id}`, evidence: 'Mock browser adapter; no browser or Instagram account was opened.' };
    }
  };
  return { modes, drive, calendar, instagram, browser, video: { frames: async (fileId, bounds) => extractVideoFrames(await drive.readVideoFile(fileId), bounds, env) }, mirror, status: {
    drive: { mode: modes.drive, label: modes.drive === 'mock' ? 'Local Drive mirror · not cloud-synced' : 'Google Drive API · credentials configured' },
    calendar: { mode: modes.calendar, label: modes.calendar === 'mock' ? 'Simulated Google Calendar' : 'Google Calendar API · credentials configured' },
    instagram: { mode: modes.instagram, label: modes.instagram === 'mock' ? 'Instagram event & message simulator' : 'Instagram API · credentials configured' },
    browser: { mode: modes.browser, label: modes.browser === 'mock' ? 'Browser outreach simulator' : modes.browser === 'browser_use' ? 'Browser Use + Claude · verify UI outcomes' : 'Manual browser handoff' }
  } };
}
