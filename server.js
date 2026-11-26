const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000,KEY=process.env.ANTHROPIC_API_KEY,MODEL=process.env.MODEL||'claude-sonnet-5-5';
const FREE=+process.env.FREE_MESSAGES||15,used=new Map();
const SYS='You are Nexus, a helpful, concise AI agent. Reply in the language the user writes in. If the user asks you to send a Telegram message and the tool is available, use it.';
const send=(res,code,obj,h={})=>{res.writeHead(code,{'Content-Type':'application/json',...h});res.end(JSON.stringify(obj))};
const body=req=>new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>2e6)req.destroy()});req.on('end',()=>{try{r(JSON.parse(d))}catch{r({})}})});
const cid=(req,res)=>{let m=(req.headers.cookie||'').match(/nx=([a-f0-9]+)/),id=m&&m[1];const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();if(!id){id=crypto.randomBytes(8).toString('hex');res.setHeader('Set-Cookie',`nx=${id}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`)}return id+'|'+ip};
const left=k=>Math.max(0,FREE-(used.get(k)||0));
const api=async p=>{const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':KEY,'anthropic-version':'2023-06-01','anthropic-beta':'mcp-client-2025-04-04'},body:JSON.stringify(p)});const j=await r.json();if(!r.ok)throw new Error(j.error&&j.error.message||'API error');return j};
async function tg(t,text){const r=await fetch(`https://api.telegram.org/bot${t.token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:t.chat,text})});const j=await r.json();return j.ok?'Sent to Telegram.':'Telegram error: '+j.description}
async function chat(b){
 let msgs=(b.messages||[]).slice(-20).map(m=>({role:m.role==='user'?'user':'assistant',content:String(m.content).slice(0,8000)}));
 const p={model:MODEL,max_tokens:1500,system:SYS,messages:msgs};
 const mcp=(b.mcp||[]).filter(s=>/^https:\/\//.test(s.url)).slice(0,5).map(s=>({type:'url',url:s.url,name:String(s.name||'mcp').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40)||'mcp'}));
 if(mcp.length)p.mcp_servers=mcp;
 const t=b.tg&&b.tg.token&&b.tg.chat?b.tg:null;
 if(t)p.tools=[{name:'telegram_send',description:'Send a text message to the user\'s Telegram chat',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text']}}];
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
http.createServer(async(req,res)=>{
 const u=req.url.split('?')[0];
 if(req.method==='GET'&&u==='/api/credits'){const k=cid(req,res);return send(res,200,{left:left(k),total:FREE})}
 if(req.method==='POST'&&u==='/api/chat'){
  const k=cid(req,res);
  if(!KEY)return send(res,500,{error:'Server is missing ANTHROPIC_API_KEY.',left:left(k)});
  if(!left(k))return send(res,402,{error:'Free messages finished. Upgrade to Nexus Pro to continue.',left:0});
  try{const reply=await chat(await body(req));used.set(k,(used.get(k)||0)+1);return send(res,200,{reply,left:left(k)})}
  catch(e){return send(res,500,{error:e.message,left:left(k)})}
 }
 if(req.method==='POST'&&u==='/api/telegram-test'){const b=await body(req);try{return send(res,200,{result:await tg({token:b.token,chat:b.chat},'Nexus connected \u2705')})}catch(e){return send(res,500,{error:e.message})}}
 if(u==='/'||u==='/index.html'){return fs.readFile(path.join(__dirname,'public','index.html'),(e,d)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(d)})}
 res.writeHead(404);res.end('Not found');
}).listen(PORT,()=>console.log('Nexus on '+PORT));
