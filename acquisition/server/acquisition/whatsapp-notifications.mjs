// Team alerts only. A successful API response is acceptance, not delivery evidence.
export function createWhatsAppNotifications({env,list,get,put,active}) {
 const required=['WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_API_VERSION','WHATSAPP_TEAM_RECIPIENT','WHATSAPP_TEMPLATE_NAME','WHATSAPP_TEMPLATE_LANGUAGE'];
 function status(){
  if(env.TEAM_NOTIFICATION_CHANNEL!=='whatsapp')return {mode:'disabled',label:'WhatsApp team alerts · not enabled'};
  const missing=required.filter(k=>!env[k]);
  const valid=!missing.length&&/^\+?[1-9]\d{7,14}$/.test(env.WHATSAPP_TEAM_RECIPIENT)&&/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID)&&/^v\d+\.\d+$/.test(env.WHATSAPP_API_VERSION)&&/^[a-z0-9_]+$/.test(env.WHATSAPP_TEMPLATE_NAME)&&/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(env.WHATSAPP_TEMPLATE_LANGUAGE);
  return {mode:valid?'ready':'setup_required',label:valid?'WhatsApp team alerts · configured':'WhatsApp team alerts · setup required'};
 }
 function enqueue(h){
  if(env.TEAM_NOTIFICATION_CHANNEL!=='whatsapp'||h.requestKind!=='live_chat')return;
  const id=`whatsapp-${h.id}`;if(get('team_notifications',id))return;
  return put('team_notifications',{id,handoffId:h.id,contactId:h.contactId,projectId:h.projectId,channel:'whatsapp',status:status().mode==='ready'?'queued':'setup_required'});
 }
 function recover(){for(const n of list('team_notifications').filter(n=>n.status==='sending'))put('team_notifications',{...n,status:'send_unknown',error:'Interrupted during WhatsApp send; verify before retrying.'});}
 let running;
 async function run(){
  if(running)return running;
  running=(async()=>{
   for(const n of list('team_notifications').filter(n=>['queued','setup_required'].includes(n.status))){
    const h=get('handoffs',n.handoffId);
    if(!h||h.status!=='waiting'||!active(h)){put('team_notifications',{...n,status:'cancelled',reason:'Team request is no longer waiting.'});continue;}
    if(status().mode!=='ready')continue;
    const recipient=env.WHATSAPP_TEAM_RECIPIENT.replace(/^\+/,'');
    put('team_notifications',{...n,status:'sending',attemptedAt:new Date().toISOString()});
    try{
     const body={messaging_product:'whatsapp',recipient_type:'individual',to:recipient,type:'template',template:{name:env.WHATSAPP_TEMPLATE_NAME,language:{code:env.WHATSAPP_TEMPLATE_LANGUAGE},components:[{type:'body',parameters:[{type:'text',text:'@'+get('contacts',n.contactId).handle},{type:'text',text:'Requested a team reply in Instagram'},{type:'text',text:h.id}]}]}};
     const response=await fetch(`https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{method:'POST',signal:AbortSignal.timeout(20000),headers:{authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body)});
     if(!response.ok){put('team_notifications',{...n,status:response.status>=500?'send_unknown':'failed',error:`WhatsApp API returned HTTP ${response.status}.`});continue;}
     const result=await response.json();if(!result.messages?.[0]?.id)throw new Error('Missing WhatsApp message ID');
     put('team_notifications',{...n,status:'accepted',externalId:result.messages[0].id,acceptedAt:new Date().toISOString()});
    }catch{put('team_notifications',{...n,status:'send_unknown',error:'WhatsApp send result is uncertain; no automatic resend.'});}
   }
  })();try{await running;}finally{running=null;}
 }
 return {status,enqueue,recover,run};
}
