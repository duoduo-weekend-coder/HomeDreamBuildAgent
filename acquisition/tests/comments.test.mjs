import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { createProviders } from '../server/acquisition/providers.mjs';
import { inject } from './http-harness.mjs';

function fixture(t) {
  const dataDir = mkdtempSync('/tmp/acquisition-comments-');
  const env = { INSTAGRAM_ACCOUNT_ID: '900', INSTAGRAM_APP_SECRET: 'test-secret' };
  const app = createApp({ dataDir, env, seed: false });
  t.after(() => { app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const receive = (id='100', text='How much does it cost to build?', sender='200', time=Date.now()/1000) => app.service.comments.receive({ id, text, from: { id: sender, username: `customer${sender}` }, media: { id: '300' } }, time);
  return { app, service: app.service, receive, env, dataDir };
}

test('signed comments webhook deduplicates, ignores own/foreign/live comments and never opens a DM window', async t => {
  const f=fixture(t);
  const change={field:'comments',value:{comment_id:'100',text:'Can you build in Bellevue?',from:{id:'200',username:'test.customer'},media:{id:'300'}}};
  const body=JSON.stringify({entry:[{id:'900',time:Math.floor(Date.now()/1000),changes:[change,change,{...change,value:{...change.value,comment_id:'101',from:{id:'900'}}},{...change,field:'live_comments'}]},{id:'wrong-account',time:Date.now()/1000,changes:[change]}]});
  const signature='sha256='+createHmac('sha256',f.env.INSTAGRAM_APP_SECRET).update(body).digest('hex');
  const response=await inject(f.app.handler,'/webhooks/instagram',{method:'POST',headers:{'x-hub-signature-256':signature},body});
  assert.equal(response.status,200);
  assert.equal(f.service.list('comments').length,1);
  assert.equal(f.service.list('interactions').length,1);
  const c=f.service.list('contacts')[0];assert.equal(c.handle,'test.customer');
  assert.equal(f.service.get('conversations',c.id).replyWindowUntil,null);
  await f.service.tick();
  const job=f.service.list('comments')[0];
  assert.equal(job.public.status,'simulated_sent');assert.equal(job.private.status,'simulated_sent');
  await f.service.tick();assert.equal(f.service.list('messages').length,1);
  assert.equal(f.service.get('conversations',c.id).replyWindowUntil,null);
  assert.equal(f.service.state().contacts[0].signals.intent,'high');
  await f.service.receive({contactId:c.id,eventId:'actual-dm',text:'Bellevue'});
  assert.ok(f.service.get('conversations',c.id).replyWindowUntil);
  assert.equal(f.service.comments.funnel().dmResponses,1);
  assert.equal(f.service.comments.funnel().responseRate,1);
});

test('existing DM threads and repeated comments do not receive another private acquisition message', async t=>{
  const f=fixture(t),a=f.receive();await f.service.comments.run(a.id);
  const b=f.receive('101');await f.service.comments.run(b.id);
  assert.equal(f.service.get('comments',b.id).private,null);
  const c=f.service.createContact({handle:'already.chatting',instagramId:'201',demo:false});
  await f.service.receive({contactId:c.id,eventId:'dm-before-comment',text:'Hi'});
  const d=f.receive('102','Can you build in Seattle?','201');await f.service.comments.run(d.id);
  assert.equal(f.service.get('comments',d.id).private,null);
  assert.equal(f.service.comments.funnel().privateRepliesSent,1);
});

test('review mode creates separate drafts; a new DM blocks approving the stale invitation', async t=>{
  const f=fixture(t);f.service.updateSettings({replyMode:'review'});
  const a=f.receive();await f.service.comments.run(a.id);
  let job=f.service.get('comments',a.id);assert.equal(job.public.status,'draft');assert.equal(job.private.status,'draft');
  await f.service.receive({contactId:a.contactId,eventId:'new-dm',text:'Hi'});
  job=await f.service.comments.execute(a.id,'private');assert.equal(job.private.status,'blocked');
  job=await f.service.comments.execute(a.id,'public');assert.equal(job.public.status,'simulated_sent');
  await assert.rejects(()=>f.service.comments.execute(a.id,'public'),/unsent draft/);
});

test('seven-day deadline, opt-out and human ownership prevent sends; compliments are low intent',async t=>{
  const f=fixture(t);
  for(const [id,text,sender,time] of [['100','Quote please','200',Date.now()/1000-8*86400],['101','Do not contact me','201',Date.now()/1000]]) {
    const c=f.receive(id,text,sender,time);await f.service.comments.run(c.id);assert.equal(f.service.get('comments',c.id).status,'skipped');
  }
  assert.equal(f.service.list('contacts').find(c=>c.instagramId==='201').doNotContact,true);
  const a=f.receive('102','Quote please','202');await f.service.mode(a.contactId,{mode:'human'});await f.service.comments.run(a.id);assert.equal(f.service.get('comments',a.id).status,'skipped');
  const b=f.receive('103','Beautiful!','203');await f.service.comments.run(b.id);const job=f.service.get('comments',b.id);
  assert.equal(job.intent,'low');assert.equal(job.private,null);assert.equal(job.public.status,'simulated_sent');
});

test('uncertain private sends and process restarts cannot cause automatic duplicate outreach',async t=>{
  const f=fixture(t);f.service.providers.instagram.replyToComment=async({privateReply})=>{if(privateReply)throw new Error('Connection ended after dispatch');return {status:'sent',externalId:'public-result'};};
  const a=f.receive();await f.service.comments.run(a.id);assert.equal(f.service.get('comments',a.id).private.status,'send_unknown');
  const b=f.receive('101');await f.service.comments.run(b.id);assert.equal(f.service.get('comments',b.id).private,null);
  await assert.rejects(()=>f.service.comments.execute(a.id,'private'),/unsent draft/);
  f.service.put('comments',{...f.service.get('comments',a.id),private:{text:'Test',status:'sending'}});f.service.recoverInterrupted();assert.equal(f.service.get('comments',a.id).private.status,'send_unknown');
});

test('Instagram public and private replies use distinct official endpoints and recipients',async t=>{
  const dir=mkdtempSync('/tmp/comment-provider-'),old=globalThis.fetch,requests=[];
  t.after(()=>{globalThis.fetch=old;rmSync(dir,{recursive:true,force:true});});
  globalThis.fetch=async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify(url.endsWith('/messages')?{message_id:'private-1'}:{id:'public-1'}));};
  const p=createProviders({INSTAGRAM_PROVIDER:'instagram',INSTAGRAM_ACCOUNT_ID:'900',INSTAGRAM_API_VERSION:'v26.0',INSTAGRAM_ACCESS_TOKEN:'test-token',INSTAGRAM_APP_SECRET:'test-secret',INSTAGRAM_VERIFY_TOKEN:'test-verify'},dir);
  assert.equal((await p.instagram.replyToComment({commentId:'100',text:'Thanks',privateReply:false})).externalId,'public-1');
  assert.equal((await p.instagram.replyToComment({commentId:'100',text:'Hello',privateReply:true})).externalId,'private-1');
  assert.ok(requests[0].url.endsWith('/100/replies'));assert.deepEqual(requests[0].body,{message:'Thanks'});
  assert.ok(requests[1].url.endsWith('/900/messages'));assert.deepEqual(requests[1].body,{recipient:{comment_id:'100'},message:{text:'Hello'}});
});
