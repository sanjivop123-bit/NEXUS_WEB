const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const E=process.env,PORT=E.PORT||3000;
const KEY=E.ANTHROPIC_API_KEY;
const GKEY=E.GEMINI_API_KEY||E.GOOGLE_API_KEY||E.GOOGLE_GENERATIVE_AI_API_KEY;
const GBASE=E.GEMINI_BASE||'https://generativelanguage.googleapis.com';
const MODEL=E.MODEL||'claude-sonnet-5-5';
// Gemini models tried in order. Override first choice with GEMINI_MODEL.
const GMODELS=[E.GEMINI_MODEL,'gemini-3.5-flash','gemini-2.5-flash'].filter(Boolean);
// Usage credits: 1 credit ~ 100 tokens (400 chars). Each attached file costs 5 extra. Set CREDITS env to change.
const CREDITS=+E.CREDITS||1000,used=new Map();
const SYS='You are Nexus, a helpful, concise AI agent. Reply in the language the user writes in. Use simple markdown (**bold**, `code`, fenced code blocks) when it helps. If the user attaches files, use them. If the user asks you to send a Telegram message and the tool is available, use it.';

const send=(res,code,obj,h={})=>{res.writeHead(code,{'Content-Type':'application/json',...h});res.end(JSON.stringify(obj))};
const body=req=>new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>25e6)req.destroy()});req.on('end',()=>{try{r(JSON.parse(d))}catch{r({})}})});
const cid=(req,res)=>{let m=(req.headers.cookie||'').match(/nx=([a-f0-9]+)/),id=m&&m[1];const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();if(!id){id=crypto.randomBytes(8).toString('hex');res.setHeader('Set-Cookie',`nx=${id}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`)}return id+'|'+ip};
const left=k=>Math.max(0,CREDITS-(used.get(k)||0));
const charge=(k,chars,files)=>used.set(k,(used.get(k)||0)+Math.max(1,Math.ceil(chars/400))+5*files);

async function tg(t,text){const r=await fetch(`https://api.telegram.org/bot${t.token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:t.chat,text})});const j=await r.json();return j.ok?'Sent to Telegram.':'Telegram error: '+j.description}

function clean(b){return(b.messages||[]).slice(-20).map(m=>({role:m.role==='user'?'user':'assistant',content:String(m.content==null?'':m.content).slice(0,60000),files:Array.isArray(m.files)?m.files.filter(f=>f&&f.data&&f.mime).slice(0,4):[]}))}
const tgOf=b=>b.tg&&b.tg.token&&b.tg.chat?b.tg:null;

// ---------- Anthropic ----------
const api=async p=>{const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':KEY,'anthropic-version':'2023-06-01','anthropic-beta':'mcp-client-2025-04-04'},body:JSON.stringify(p)});const j=await r.json();if(!r.ok)throw new Error(j.error&&j.error.message||'API error');return j};
const toC=m=>({role:m.role,content:m.files.length?[...m.files.map(f=>({type:f.mime==='application/pdf'?'document':'image',source:{type:'base64',media_type:f.mime,data:f.data}})),{type:'text',text:m.content||' '}]:m.content});

// ---------- Gemini (streaming, fast thinking, model fallback) ----------
const toGem=msgs=>msgs.map(m=>({role:m.role==='user'?'user':'model',parts:[{text:m.content||' '},...m.files.map(f=>({inlineData:{mimeType:f.mime,data:f.data}}))]}));
const thinkCfg=m=>/2\.5/.test(m)?{thinkingConfig:{thinkingBudget:0}}:/gemini-3/.test(m)?{thinkingConfig:{thinkingLevel:'low'}}:null;
async function gemStream(p,onText){
 const attempts=[];for(const m of GMODELS){const tc=thinkCfg(m);if(tc)attempts.push([m,tc]);attempts.push([m,null])}
 let lastErr,skip=null;
 for(const [model,tc] of attempts){
  if(model===skip)continue;
  const payload={...p,generationConfig:{...p.generationConfig,...(tc||{})}};
  const ac=new AbortController();let timer=setTimeout(()=>ac.abort(),20000),parts=[],emitted=false,fatal=false;
  try{
   const r=await fetch(`${GBASE}/v1beta/models/${model}:streamGenerateContent?alt=sse`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':GKEY},body:JSON.stringify(payload),signal:ac.signal});
   if(!r.ok){clearTimeout(timer);const j=await r.json().catch(()=>({}));lastErr=new Error(j.error&&j.error.message||'Gemini error '+r.status);
    if(r.status===400&&tc)continue;
    if(r.status===400||r.status===404||r.status===429||r.status>=500){skip=model;continue}
    fatal=true;throw lastErr}
   let buf='';const dec=new TextDecoder();
   for await(const chunk of r.body){
    clearTimeout(timer);timer=setTimeout(()=>ac.abort(),30000);
    buf+=dec.decode(chunk,{stream:true});let i;
    while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line.startsWith('data:'))continue;
     let j;try{j=JSON.parse(line.slice(5))}catch{continue}
     const c=j.candidates&&j.candidates[0];
     if(c&&c.content&&c.content.parts)for(const x of c.content.parts){parts.push(x);if(x.text&&!x.thought){emitted=true;onText(x.text)}}}
   }
   clearTimeout(timer);return parts;
  }catch(e){clearTimeout(timer);
   if(emitted)return parts;
   if(fatal)throw e;
   lastErr=e&&e.name==='AbortError'?new Error('Gemini timed out, try again'):e;skip=model}
 }
 throw lastErr||new Error('Gemini unavailable');
}
async function chatGemini(b,msgs,onText){
 const t=tgOf(b);
 const p={systemInstruction:{parts:[{text:SYS}]},contents:toGem(msgs),generationConfig:{maxOutputTokens:4096}};
 if(t)p.tools=[{functionDeclarations:[{name:'telegram_send',description:"Send a text message to the user's Telegram chat",parameters:{type:'OBJECT',properties:{text:{type:'STRING'}},required:['text']}}]}];
 let all='';
 for(let i=0;i<4;i++){
  const parts=await gemStream(p,x=>{all+=x;onText(x)});
  const calls=parts.filter(x=>x.functionCall&&x.functionCall.name==='telegram_send');
  if(!calls.length)return all||'(no reply)';
  p.contents.push({role:'model',parts});
  const rs=[];for(const c of calls)rs.push({functionResponse:{name:'telegram_send',response:{result:await tg(t,String((c.functionCall.args||{}).text||'').slice(0,4000))}}});
  p.contents.push({role:'user',parts:rs});
 }
 return all||'Done.';
}

// Optional extra "draft" models (only when Claude is the main model)
async function others(msgs){const out=[],t=[],plain=msgs.map(m=>({role:m.role,content:m.content}));
 if(E.OPENAI_API_KEY)t.push(fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+E.OPENAI_API_KEY},body:JSON.stringify({model:E.OPENAI_MODEL||'gpt-4o',max_tokens:1000,messages:[{role:'system',content:SYS},...plain]}),signal:AbortSignal.timeout(25000)}).then(r=>r.json()).then(j=>out.push('ChatGPT draft:\n'+j.choices[0].message.content)).catch(()=>{}));
 if(GKEY)t.push(gemStream({contents:toGem(msgs)},()=>{}).then(ps=>out.push('Gemini draft:\n'+ps.filter(x=>x.text&&!x.thought).map(x=>x.text).join(''))).catch(()=>{}));
 await Promise.all(t);
 return out.length?'\n\nOther AI models drafted answers to the same question. Combine the best, most accurate parts into one final answer. Do not mention the drafts.\n\n'+out.join('\n\n'):''}

async function chatClaude(b,msgs){
 const dr=await others(msgs);const p={model:MODEL,max_tokens:1500,system:SYS+dr,messages:msgs.map(toC)};
 const mcp=(b.mcp||[]).filter(s=>/^https:\/\//.test(s.url)).slice(0,5).map(s=>({type:'url',url:s.url,name:String(s.name||'mcp').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40)||'mcp'}));
 if(mcp.length)p.mcp_servers=mcp;
 const t=tgOf(b);
 if(t)p.tools=[{name:'telegram_send',description:"Send a text message to the user's Telegram chat",input_schema:{type:'object',properties:{text:{type:'string'}},required:['text']}}];
 for(let i=0;i<4;i++){
  const j=await api(p);
  const calls=j.content.filter(c=>c.type==='tool_use'&&c.name==='telegram_send');
  if(j.stop_reason!=='tool_use'||!calls.length)return j.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'(no reply)';
  p.messages.push({role:'assistant',content:j.content});
  const rs=[];for(const c of calls)rs.push({type:'tool_result',tool_use_id:c.id,content:await tg(t,String(c.input.text||'').slice(0,4000))});
  p.messages.push({role:'user',content:rs});
 }
 return 'Done.';
}

const run=(b,msgs,onText)=>KEY?chatClaude(b,msgs).then(r=>{onText(r);return r}):chatGemini(b,msgs,onText);
const cost=(k,msgs,reply)=>charge(k,msgs.reduce((n,m)=>n+m.content.length,0)+reply.length,msgs.length?msgs[msgs.length-1].files.length:0);
const noKey='Server is missing an API key. Set GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Render environment variables.';
const noCredits='Usage credits finished. Add more credits to continue.';

http.createServer(async(req,res)=>{
 const u=req.url.split('?')[0];
 if(req.method==='GET'&&u==='/api/credits'){const k=cid(req,res);return send(res,200,{left:left(k),total:CREDITS})}
 if(req.method==='POST'&&u==='/api/chat'){
  const k=cid(req,res);
  if(!KEY&&!GKEY)return send(res,500,{error:noKey,left:left(k),total:CREDITS});
  if(!left(k))return send(res,402,{error:noCredits,left:0,total:CREDITS});
  try{const b=await body(req),msgs=clean(b);const reply=await run(b,msgs,()=>{});cost(k,msgs,reply);return send(res,200,{reply,left:left(k),total:CREDITS})}
  catch(e){console.error('chat error:',e.message);return send(res,500,{error:e.message,left:left(k),total:CREDITS})}
 }
 if(req.method==='POST'&&u==='/api/chat/stream'){
  const k=cid(req,res);
  if(!KEY&&!GKEY)return send(res,500,{error:noKey,left:left(k),total:CREDITS});
  if(!left(k))return send(res,402,{error:noCredits,left:0,total:CREDITS});
  const b=await body(req),msgs=clean(b);
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
  const w=o=>res.write('data: '+JSON.stringify(o)+'\n\n');
  try{const reply=await run(b,msgs,x=>w({t:x}));cost(k,msgs,reply);w({done:1,left:left(k),total:CREDITS})}
  catch(e){console.error('stream error:',e.message);w({error:e.message,left:left(k),total:CREDITS})}
  return res.end();
 }
 if(req.method==='POST'&&u==='/api/telegram-test'){const b=await body(req);try{return send(res,200,{result:await tg({token:b.token,chat:b.chat},'Nexus connected \u2705')})}catch(e){return send(res,500,{error:e.message})}}
 if(u==='/'||u==='/index.html'){return fs.readFile(path.join(__dirname,'public','index.html'),(e,d)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(d)})}
 res.writeHead(404);res.end('Not found');
}).listen(PORT,()=>console.log('Nexus on '+PORT+' | provider: '+(KEY?'claude':GKEY?'gemini':'NONE (no API key set)')));
