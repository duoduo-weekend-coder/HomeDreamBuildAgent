import test from 'node:test';
import assert from 'node:assert/strict';
import {createWhatsAppNotifications} from '../server/acquisition/whatsapp-notifications.mjs';
function fixture(env={}){const data={handoffs:[{id:'h',contactId:'c',projectId:'p',requestKind:'live_chat',status:'waiting'}],contacts:[{id:'c',handle:'customer'}],team_notifications:[]};const get=(k,id)=>data[k].find(x=>x.id===id),put=(k,x)=>{data[k]=data[k].filter(y=>y.id!==x.id).concat([x]);return x;};return {data,worker:createWhatsAppNotifications({env,list:k=>data[k],get,put,active:h=>!h.archivedTest})};}
const env={TEAM_NOTIFICATION_CHANNEL:'whatsapp',WHATSAPP_ACCESS_TOKEN:'test-token',WHATSAPP_PHONE_NUMBER_ID:'123456789',WHATSAPP_API_VERSION:'v25.0',WHATSAPP_TEAM_RECIPIENT:'+12065550123',WHATSAPP_TEMPLATE_NAME:'team_request',WHATSAPP_TEMPLATE_LANGUAGE:'en_US'};

test('WhatsApp setup blocks sends, deduplicates handoffs, and cancels requests already handled',async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);globalThis.fetch=()=>{throw new Error('must not send');};
 const {data,worker}=fixture({TEAM_NOTIFICATION_CHANNEL:'whatsapp'});worker.enqueue(data.handoffs[0]);worker.enqueue(data.handoffs[0]);assert.equal(data.team_notifications.length,1);await worker.run();assert.equal(data.team_notifications[0].status,'setup_required');
 data.handoffs[0].status='resolved';await worker.run();assert.equal(data.team_notifications[0].status,'cancelled');
});

test('WhatsApp sends one approved template to the configured team recipient and records acceptance only',async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);const requests=[];globalThis.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({messages:[{id:'wamid.test'}]})};};
 const {data,worker}=fixture(env);worker.enqueue(data.handoffs[0]);await Promise.all([worker.run(),worker.run()]);await worker.run();assert.equal(requests.length,1);assert.equal(requests[0].body.to,'12065550123');assert.equal(requests[0].body.type,'template');assert.equal(requests[0].body.template.components[0].parameters.length,3);assert.equal(data.team_notifications[0].status,'accepted');
});

test('WhatsApp uncertain and interrupted sends are not automatically retried',async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);let sends=0;globalThis.fetch=async()=>{sends++;throw new Error('response lost');};
 const {data,worker}=fixture(env);worker.enqueue(data.handoffs[0]);await worker.run();await worker.run();assert.equal(sends,1);assert.equal(data.team_notifications[0].status,'send_unknown');
 data.team_notifications[0].status='sending';worker.recover();assert.equal(data.team_notifications[0].status,'send_unknown');
});
