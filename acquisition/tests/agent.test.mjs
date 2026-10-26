import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../server/acquisition/agent.mjs';
import { readFileSync } from 'node:fs';
const config={business:JSON.parse(readFileSync(new URL('../config/business-profile.json',import.meta.url))),schema:JSON.parse(readFileSync(new URL('../config/qualification.schema.json',import.meta.url)))};
const baseState={contact:{name:'Customer'},conversation:{offeredSlots:[]},project:{facts:{},asked:{}},messages:[{direction:'outbound',status:'cancelled',text:'Do not include this unsent message'},{direction:'inbound',text:'Location: Bellevue'}]};

test('Claude tool loop sends results back, logs usage, and excludes unsent drafts from history',async t=>{
  const requests=[],calls=[],usage=[];const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>requests.length===1?{stop_reason:'tool_use',usage:{input_tokens:50},content:[{type:'tool_use',id:'call-1',name:'update_customer_fields',input:{updates:[{fieldId:'location',value:'Bellevue',status:'confirmed'}]}}]}:{stop_reason:'end_turn',usage:{output_tokens:20},content:[{type:'text',text:'Thanks! What size of home do you have in mind?'}]}};};t.after(()=>globalThis.fetch=original);
  const agent=createAgent({ACQUISITION_AI_PROVIDER:'claude',ANTHROPIC_API_KEY:'test',ANTHROPIC_MODEL:'test'});
  const reply=await agent.run({config,text:'Location: Bellevue',snapshot:()=>baseState,quoteMode:'off',tools:[{name:'update_customer_fields',input_schema:{type:'object'}}],call:async(name,input)=>{calls.push({name,input});return {saved:['location']};},recordUsage:x=>usage.push(x)});
  assert.equal(calls.length,1);assert.equal(usage.length,2);assert.match(reply,/What size/);
  assert.equal(requests[0].messages.length,1);assert.equal(requests[1].messages.at(-1).content[0].type,'tool_result');
  assert.match(requests[0].system,/get_post_context/);assert.match(requests[0].system,/sourcePostId/);
});

test('truncated Claude responses cannot become partial customer messages',async t=>{
  const original=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({stop_reason:'max_tokens',content:[{type:'text',text:'Incomplete booking confirmation'}]})});t.after(()=>globalThis.fetch=original);
  const agent=createAgent({ACQUISITION_AI_PROVIDER:'claude',ANTHROPIC_API_KEY:'test',ANTHROPIC_MODEL:'test'});
  await assert.rejects(()=>agent.run({config,text:'Hi',snapshot:()=>baseState,quoteMode:'off',tools:[],call:async()=>({})}),/truncated/);
});

test('empty completion after tools retries text only without repeating actions',async t=>{
  const requests=[],calls=[];const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);requests.push(body);return {ok:true,json:async()=> requests.length===1 ? {stop_reason:'tool_use',content:[{type:'tool_use',id:'q1',name:'note_question',input:{fieldId:'location'}}]} : requests.length===2 ? {stop_reason:'end_turn',content:[]} : {stop_reason:'end_turn',content:[{type:'text',text:'Which city is your project in?'}]}};};
  t.after(()=>globalThis.fetch=original);
  const agent=createAgent({ACQUISITION_AI_PROVIDER:'claude',ANTHROPIC_API_KEY:'test',ANTHROPIC_MODEL:'test'});
  const reply=await agent.run({config,text:'build a house',snapshot:()=>baseState,quoteMode:'off',tools:[{name:'note_question',input_schema:{type:'object'}}],call:async(name)=>{calls.push(name);return {recorded:'location',sent:false};}});
  assert.equal(reply,'Which city is your project in?');assert.deepEqual(calls,['note_question']);assert.deepEqual(requests[2].tool_choice,{type:'none'});
});

test('transient model network failure retries inference without repeating tools',async t=>{
  const original=globalThis.fetch;let requests=0,calls=0;
  globalThis.fetch=async()=>{requests++;if(requests===1)throw new TypeError('fetch failed');return {ok:true,json:async()=>({stop_reason:'end_turn',content:[{type:'text',text:'Which city is your project in?'}]})};};t.after(()=>globalThis.fetch=original);
  const agent=createAgent({ACQUISITION_AI_PROVIDER:'claude',ANTHROPIC_API_KEY:'test',ANTHROPIC_MODEL:'test'});
  const reply=await agent.run({config,text:'Hi',snapshot:()=>baseState,quoteMode:'off',tools:[],call:async()=>{calls++;return {};}});
  assert.match(reply,/Which city/);assert.equal(requests,2);assert.equal(calls,0);
});
