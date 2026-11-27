const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const E = process.env;
const KEY = E.ANTHROPIC_API_KEY;
const GKEY = E.GEMINI_API_KEY || E.GOOGLE_API_KEY || E.GOOGLE_GENERATIVE_AI_API_KEY;
const MODEL = E.MODEL || 'claude-sonnet-5-5';
// Gemini models tried in order (first that exists wins). Override with GEMINI_MODEL.
const GMODELS = [E.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-2.5-flash'].filter(Boolean);
const FREE = +E.FREE_MESSAGES || 15, used = new Map();
const SYS = 'You are Nexus, a helpful, concise AI agent. Reply in the language the user writes in. If the user asks you to send a Telegram message and the tool is available, use it.';

const send = (res, code, obj, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(d)); } catch { r({}); } }); });
const cid = (req, res) => {
  let m = (req.headers.cookie || '').match(/nx=([a-f0-9]+)/), id = m && m[1];
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!id) { id = crypto.randomBytes(8).toString('hex'); res.setHeader('Set-Cookie', `nx=${id}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`); }
  return id + '|' + ip;
};
const left = k => Math.max(0, FREE - (used.get(k) || 0));

async function tg(t, text) {
  const r = await fetch(`https://api.telegram.org/bot${t.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: t.chat, text }) });
  const j = await r.json();
  return j.ok ? 'Sent to Telegram.' : 'Telegram error: ' + j.description;
}

// ---------- Anthropic ----------
const api = async p => {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'mcp-client-2025-04-04' }, body: JSON.stringify(p) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error && j.error.message || 'API error');
  return j;
};

// ---------- Gemini ----------
async function gemCall(payload) {
  let lastErr;
  for (const model of GMODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GKEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55000)
    });
    const j = await r.json();
    if (r.ok) return j;
    lastErr = new Error((j.error && j.error.message) || 'Gemini API error');
    if (r.status !== 404) throw lastErr; // only fall through to next model if model not found
  }
  throw lastErr;
}

async function chatGemini(b, msgs) {
  const contents = msgs.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
  const t = b.tg && b.tg.token && b.tg.chat ? b.tg : null;
  const p = { systemInstruction: { parts: [{ text: SYS }] }, contents, generationConfig: { maxOutputTokens: 4096 } };
  if (t) p.tools = [{ functionDeclarations: [{ name: 'telegram_send', description: "Send a text message to the user's Telegram chat", parameters: { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] } }] }];
  for (let i = 0; i < 4; i++) {
    const j = await gemCall(p);
    const cand = j.candidates && j.candidates[0];
    if (!cand || !cand.content) {
      const why = (j.promptFeedback && j.promptFeedback.blockReason) || (cand && cand.finishReason) || '';
      return why ? `(no reply: ${why})` : '(no reply)';
    }
    const parts = cand.content.parts || [];
    const calls = parts.filter(x => x.functionCall && x.functionCall.name === 'telegram_send');
    if (!calls.length) return parts.filter(x => x.text && !x.thought).map(x => x.text).join('\n') || '(no reply)';
    p.contents.push(cand.content);
    const rs = [];
    for (const c of calls) rs.push({ functionResponse: { name: 'telegram_send', response: { result: await tg(t, String((c.functionCall.args || {}).text || '').slice(0, 4000)) } } });
    p.contents.push({ role: 'user', parts: rs });
  }
  return 'Done.';
}

// Optional extra "draft" models (only used when Claude is the main model)
async function others(msgs) {
  const out = [], t = [];
  if (E.OPENAI_API_KEY) t.push(fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + E.OPENAI_API_KEY }, body: JSON.stringify({ model: E.OPENAI_MODEL || 'gpt-4o', max_tokens: 1000, messages: [{ role: 'system', content: SYS }, ...msgs] }), signal: AbortSignal.timeout(25000) }).then(r => r.json()).then(j => out.push('ChatGPT draft:\n' + j.choices[0].message.content)).catch(() => {}));
  if (GKEY) t.push(gemCall({ contents: msgs.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })) }).then(j => out.push('Gemini draft:\n' + j.candidates[0].content.parts.filter(x => x.text && !x.thought).map(x => x.text).join('\n'))).catch(() => {}));
  await Promise.all(t);
  return out.length ? '\n\nOther AI models drafted answers to the same question. Combine the best, most accurate parts into one final answer. Do not mention the drafts.\n\n' + out.join('\n\n') : '';
}

async function chatClaude(b, msgs) {
  const dr = await others(msgs);
  const p = { model: MODEL, max_tokens: 1500, system: SYS + dr, messages: msgs };
  const mcp = (b.mcp || []).filter(s => /^https:\/\//.test(s.url)).slice(0, 5).map(s => ({ type: 'url', url: s.url, name: String(s.name || 'mcp').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'mcp' }));
  if (mcp.length) p.mcp_servers = mcp;
  const t = b.tg && b.tg.token && b.tg.chat ? b.tg : null;
  if (t) p.tools = [{ name: 'telegram_send', description: "Send a text message to the user's Telegram chat", input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];
  for (let i = 0; i < 4; i++) {
    const j = await api(p);
    const calls = j.content.filter(c => c.type === 'tool_use' && c.name === 'telegram_send');
    if (j.stop_reason !== 'tool_use' || !calls.length) return j.content.filter(c => c.type === 'text').map(c => c.text).join('\n') || '(no reply)';
    p.messages.push({ role: 'assistant', content: j.content });
    const rs = [];
    for (const c of calls) rs.push({ type: 'tool_result', tool_use_id: c.id, content: await tg(t, String(c.input.text || '').slice(0, 4000)) });
    p.messages.push({ role: 'user', content: rs });
  }
  return 'Done.';
}

async function chat(b) {
  const msgs = (b.messages || []).slice(-20).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 8000) }));
  // Claude if an Anthropic key exists, otherwise Gemini
  return KEY ? chatClaude(b, msgs) : chatGemini(b, msgs);
}

http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (req.method === 'GET' && u === '/api/credits') { const k = cid(req, res); return send(res, 200, { left: left(k), total: FREE }); }
  if (req.method === 'POST' && u === '/api/chat') {
    const k = cid(req, res);
    if (!KEY && !GKEY) return send(res, 500, { error: 'Server is missing an API key. Set GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Render environment variables.', left: left(k) });
    if (!left(k)) return send(res, 402, { error: 'Free messages finished. Upgrade to Nexus Pro to continue.', left: 0 });
    try { const reply = await chat(await body(req)); used.set(k, (used.get(k) || 0) + 1); return send(res, 200, { reply, left: left(k) }); }
    catch (e) { console.error('chat error:', e.message); return send(res, 500, { error: e.message, left: left(k) }); }
  }
  if (req.method === 'POST' && u === '/api/telegram-test') { const b = await body(req); try { return send(res, 200, { result: await tg({ token: b.token, chat: b.chat }, 'Nexus connected \u2705') }); } catch (e) { return send(res, 500, { error: e.message }); } }
  if (u === '/' || u === '/index.html') { return fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); }); }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('Nexus on ' + PORT + ' | provider: ' + (KEY ? 'claude' : GKEY ? 'gemini' : 'NONE (no API key set)')));
