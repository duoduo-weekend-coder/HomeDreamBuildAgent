import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { createApp } from '../server/app.mjs';
import { inject } from './http-harness.mjs';

// Runtime/render smoke test, not a substitute for browser layout or accessibility QA.
test('all workspace views render against the real API; demo controls update facts and bookings',async t=>{
  const directory=mkdtempSync('/tmp/home-dream-ui-'),app=createApp({dataDir:directory,env:{}});
  t.after(()=>{app.close();rmSync(directory,{recursive:true,force:true});});
  const elements=new Map(['#app','#toast','#lead-dialog'].map(key=>[key,{innerHTML:'',textContent:'',className:'',close(){},showModal(){}}]));
  const alerts=[];class NotificationMock {static permission='granted';constructor(title,options){alerts.push({title,options});}}
  const context=vm.createContext({Notification:NotificationMock,document:{querySelector:q=>elements.get(q)||null,querySelectorAll:()=>[],addEventListener(){}},sessionStorage:{getItem(){return null;},setItem(){}},location:{pathname:'/',search:''},URL,URLSearchParams,Date,Intl,console,FormData,setTimeout:()=>0,clearTimeout(){},fetch:async(route,options={})=>{const r=await inject(app.handler,route,options);return {ok:r.status<400,status:r.status,json:r.json};}});
  vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(elements.get('#app').innerHTML,/Conversations/);
  elements.set('#team-alerts',{innerHTML:'',hidden:true});const before=elements.get('#app').innerHTML;
  vm.runInContext("showTeamRequests([{id:'request-one',contactId:'customer',handle:'chat.customer',kind:'live_chat'}]);showTeamRequests([{id:'request-one',contactId:'customer',handle:'chat.customer',kind:'live_chat'}])",context);
  assert.equal(alerts.length,1);assert.match(elements.get('#team-alerts').innerHTML,/Wants a reply in Instagram/);assert.equal(elements.get('#app').innerHTML,before);
  vm.runInContext('showTeamRequests([])',context);assert.equal(elements.get('#team-alerts').hidden,true);
  for(const page of ['inbox','comments','prospects','pipeline','analytics','library','settings']) {vm.runInContext(`page=${JSON.stringify(page)};render()`,context);assert.ok(elements.get('#app').innerHTML.length>2500,page);}
  const c=app.service.state().contacts.find(c=>c.handle==='alex.demo');
  await vm.runInContext(`page='inbox';selected=${JSON.stringify(c.id)};action('simulate',selected,{dataset:{text:'budget: $950k'}})`,context);
  assert.equal(app.service.state().contacts.find(x=>x.id===c.id).project.facts.budget.value,'$950k');
  await vm.runInContext("action('simulate',selected,{dataset:{text:'Book a meeting'}})",context);
  assert.match(elements.get('#app').innerHTML,/customer#/);
  const link=app.service.list('messages').find(m=>m.text.includes('/customer#')).text;const token=link.match(/\/customer#([A-Za-z0-9_-]+)/)[1];const {slots}=await app.service.customerPages.slots(token);await app.service.customerPages.book(token,slots[0].id);await vm.runInContext('refresh()',context);
  assert.match(elements.get('#app').innerHTML,/Cancel meeting/);
  assert.equal(app.service.list('bookings').length,1);
  await vm.runInContext("page='analytics';render()",context);
  assert.match(elements.get('#app').innerHTML,/No outbound campaign has started/);assert.match(elements.get('#app').innerHTML,/Customers replied to/);assert.match(elements.get('#app').innerHTML,/America\/Los_Angeles/);
  vm.runInContext("page='inbox';render()",context);
  vm.runInContext("action('intake',selected,{dataset:{}})",context);
  assert.match(elements.get('#lead-dialog').innerHTML,/name="permit"/);
  app.service.createContact({handle:'escape.test',name:'<img src=x onerror=alert(1)>'});await vm.runInContext("refresh()",context);
  assert.ok(!elements.get('#app').innerHTML.includes('<img src=x'));
  assert.match(elements.get('#app').innerHTML,/&lt;img/);
});
