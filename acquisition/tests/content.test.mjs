import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createApp } from '../server/app.mjs';
import { createProviders } from '../server/acquisition/providers.mjs';
import { inject } from './http-harness.mjs';

const example=JSON.parse(readFileSync(new URL('../config/video-metadata.example.json',import.meta.url)));
function fixture(t,options={}) {
  const dataDir=mkdtempSync('/tmp/home-dream-video-');const providers=createProviders({},dataDir);options.modifyProviders?.(providers);
  const app=createApp({dataDir,env:{},seed:false,providers,...options});
  t.after(()=>{app.close();rmSync(dataDir,{recursive:true,force:true});});
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const result=await inject(app.handler,route,{method,body:body===undefined?undefined:JSON.stringify(body)});return {status:result.status,body:result.json()};};
  return {app,request,providers};
}

test('video metadata is versioned, idempotent and validates segment → raw source provenance',async t=>{
  const f=fixture(t);const first=await f.request('/api/content/posts',example);assert.equal(first.status,201);
  const repeat=await f.request('/api/content/posts',example);assert.equal(repeat.body.id,first.body.id);
  assert.equal((await f.request('/api/content/posts',{...example,title:'Changed without revision'})).status,409);
  const next=await f.request('/api/content/posts',{...example,revision:2,title:'New cut'});assert.equal(next.body.id,first.body.id);
  assert.equal(f.app.service.list('post_versions').length,2);
  assert.equal((await f.request('/api/content/posts',example)).status,409);
  const invalid=structuredClone(example);invalid.contentId='bad-ref';invalid.segments[0].rawAssetIds=['nonexistent'];assert.equal((await f.request('/api/content/posts',invalid)).status,400);
  invalid.segments[0].rawAssetIds=['raw-exterior'];invalid.segments[0].endSeconds=99;assert.equal((await f.request('/api/content/posts',invalid)).status,400);
});

test('unlinked video questions ask for the original post and do not silently pick a sample',async t=>{
  const f=fixture(t);f.app.service.content.upsert(example);
  const c=f.app.service.createContact({handle:'context.test'});
  await f.app.service.receive({contactId:c.id,eventId:'unlinked',text:'What style is in the video?'});
  const reply=f.app.service.list('messages').find(m=>m.direction==='outbound');assert.match(reply.text,/share the post link/);
  assert.equal(f.app.service.get('conversations',c.id).sourcePostId,null);
  assert.deepEqual(f.app.service.state().contacts[0].project.facts,{});
});

test('exact post context answers verified source facts without contaminating customer project details',async t=>{
  const f=fixture(t);const post=f.app.service.content.upsert(example),c=f.app.service.createContact({handle:'source.test'});
  await f.app.service.receive({contactId:c.id,eventId:'video-fact',postId:post.id,text:'What exterior style is shown in the video?'});
  const reply=f.app.service.list('messages').find(m=>m.direction==='outbound');assert.match(reply.text,/modern concept illustration/);assert.match(reply.text,/demo reference metadata/);
  assert.equal(f.app.service.get('conversations',c.id).sourcePostId,post.id);
  assert.equal(f.app.service.list('tool_runs').find(r=>r.name==='get_post_context').result.revision,1);
  assert.deepEqual(f.app.service.state().contacts[0].project.facts,{});
});

test('unavailable vision escalates only the question and continues discovery before inviting a meeting',async t=>{
  const f=fixture(t);const post=f.app.service.content.upsert(example),c=f.app.service.createContact({handle:'segment.test'});
  await f.app.service.receive({contactId:c.id,eventId:'video-segment',postId:post.id,text:'What material is the floor at 8 seconds in this video?'});
  const inspection=f.app.service.list('tool_runs').find(r=>r.name==='inspect_video_segment');assert.ok(inspection);assert.equal(inspection.result.visualInspectionPerformed,false);assert.equal(inspection.result.segmentId,'interior');assert.equal(inspection.result.status,'inspection_unavailable');
  assert.match(f.app.service.list('handoffs')[0].reason,/segment interior/);
  assert.equal(f.app.service.get('conversations',c.id).mode,'auto');
  assert.doesNotMatch(f.app.service.list('messages').find(m=>m.direction==='outbound').text,/free initial consultation/);
});

test('customer-visible verified facts exclude hidden facts, inferences and prices when quotes are off',async t=>{
  const f=fixture(t);const input=structuredClone(example);
  input.facts=[{id:'private',key:'address',value:'Private address',sourceAssetIds:['raw-exterior'],verified:true,customerVisible:false},{id:'guess',key:'size',value:'2400 sqft',sourceAssetIds:['raw-exterior'],verified:false,customerVisible:true},{id:'price',key:'price',value:'$999999',sourceAssetIds:['raw-exterior'],verified:true,customerVisible:true}];
  const p=f.app.service.content.upsert(input);const context=f.app.service.content.read(p.id,'off');assert.deepEqual(context.verifiedFacts,[]);
  assert.ok(!JSON.stringify(context).includes('Private address'));assert.ok(!JSON.stringify(context).includes('$999999'));
});

test('a different unknown Instagram post clears previous context instead of answering from the wrong video',async t=>{
  const f=fixture(t);const post=f.app.service.content.upsert(example),c=f.app.service.createContact({handle:'switch.test'});
  f.app.service.linkPost(c.id,post.id);
  await f.app.service.receive({contactId:c.id,eventId:'unknown-link',text:'What is in this video? https://www.instagram.com/reel/unknown_test/'});
  assert.equal(f.app.service.get('conversations',c.id).sourcePostId,null);
  assert.match(f.app.service.list('messages').find(m=>m.direction==='outbound').text,/share the post link/);
});

test('Claude video inspection sends timestamped sampled frames and preserves uncertainty and usage',async t=>{
  const f=fixture(t,{env:{VIDEO_VISION_PROVIDER:'claude',ANTHROPIC_API_KEY:'test-key',ANTHROPIC_MODEL:'test-model'},modifyProviders:p=>{p.drive.readSourceFile=async()=>({bytes:Buffer.from('test-image-bytes'),mimeType:'image/png'});}});
  const input=structuredClone(example);input.segments[1].keyframes=[{atSeconds:8,driveFileId:'test-frame',mimeType:'image/png'}];const post=f.app.service.content.upsert(input);
  const original=globalThis.fetch;let sent;globalThis.fetch=async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({content:[{type:'text',text:JSON.stringify({canAnswer:false,answer:'',observations:['A light-colored floor is visible.'],uncertainties:['Material cannot be verified from the image.']})}],usage:{input_tokens:100,output_tokens:20}})};};t.after(()=>globalThis.fetch=original);
  const r=await f.request(`/api/content/posts/${post.id}/inspect`,{segmentId:'interior',question:'What flooring is visible?'});
  assert.equal(r.body.visualInspectionPerformed,true);assert.deepEqual(r.body.frameTimes,[8]);assert.equal(r.body.evidenceType,'visual_observations_not_verified_project_facts');
  assert.equal(sent.messages[0].content.filter(b=>b.type==='image').length,1);
  assert.ok(f.app.service.list('usage').some(u=>u.provider==='claude-vision'));
});

test('a source-only video can answer a visual question by extracting frames before any escalation',async t=>{
  let extractions=0;
  const f=fixture(t,{env:{VIDEO_VISION_PROVIDER:'claude',ANTHROPIC_API_KEY:'test',ANTHROPIC_MODEL:'test'},modifyProviders:p=>{p.video.frames=async(id,bounds)=>{extractions++;assert.equal(id,'original-video-file');assert.equal(bounds.atSeconds,8);return [{frame:{atSeconds:8},image:{bytes:Buffer.from('fixture'),mimeType:'image/jpeg'}}];};}});
  const post=(await f.request('/api/content/sources',{contentId:'no-metadata',title:'Original reel',videoDriveFileId:'original-video-file'})).body;
  assert.equal(post.durationSeconds,null);assert.deepEqual(post.segments,[]);
  const original=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({content:[{type:'text',text:JSON.stringify({canAnswer:true,answer:'The cabinets visible in that frame are white.',observations:['White cabinet fronts'],uncertainties:[]})}]})});t.after(()=>globalThis.fetch=original);
  const c=f.app.service.createContact({handle:'visual.answer'});
  await f.app.service.receive({contactId:c.id,eventId:'visual-answer',postId:post.id,text:'What color are the cabinets at 8 seconds in this video?'});
  assert.equal(extractions,1);assert.equal(f.app.service.list('handoffs').length,0);
  assert.match(f.app.service.list('messages').find(m=>m.direction==='outbound').text,/white/);
  assert.equal(f.app.service.list('tool_runs').find(r=>r.name==='inspect_video_segment').result.frameSource,'extracted_from_original_video');
});

test('inconclusive video inspection precedes topic escalation; an explicit booking request opens the calendar without disabling AI',async t=>{
  let inspected=0;const f=fixture(t,{env:{VIDEO_VISION_PROVIDER:'claude',ANTHROPIC_API_KEY:'test',ANTHROPIC_MODEL:'test'},modifyProviders:p=>{p.video.frames=async()=>[{frame:{atSeconds:2},image:{bytes:Buffer.from('fixture'),mimeType:'image/jpeg'}}];}});
  const p=f.app.service.content.registerSource({contentId:'unknown-material',videoDriveFileId:'source-file'}),c=f.app.service.createContact({handle:'still.active'});
  const original=globalThis.fetch;globalThis.fetch=async()=>{inspected++;return {ok:true,json:async()=>({content:[{type:'text',text:JSON.stringify({canAnswer:false,answer:'',observations:['A light countertop'],uncertainties:['Exact material cannot be determined visually.']})}]})};};t.after(()=>globalThis.fetch=original);
  await f.app.service.receive({contactId:c.id,eventId:'uncertain',postId:p.id,text:'What exact countertop material is in this video?'});
  assert.equal(inspected,1);assert.equal(f.app.service.list('handoffs')[0].scope,'topic');assert.equal(f.app.service.get('conversations',c.id).mode,'auto');
  assert.match(f.app.service.list('messages').find(m=>m.direction==='outbound').text,/checked the relevant video frames/);
  await f.app.service.receive({contactId:c.id,eventId:'meeting-yes',text:'Book a meeting'});
  assert.ok(f.app.service.list('messages').some(m=>m.text.includes('/customer#')));
  const token=f.app.service.list('messages').find(m=>m.text.includes('/customer#')).text.match(/\/customer#([A-Za-z0-9_-]+)/)[1];const {slots}=await f.app.service.customerPages.slots(token);await f.app.service.customerPages.book(token,slots[0].id);
  assert.equal(f.app.service.list('bookings').length,1);assert.equal(f.app.service.list('handoffs')[0].status,'waiting');
});
