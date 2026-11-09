import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes, createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
import {homedir} from 'node:os';
import {openVault} from './vault.mjs';
import {createChatGPT} from './chatgpt.mjs';
import {LocalError, requireValue} from './errors.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_FIELDS = ['id', 'skill_id', 'level', 'kind', 'prompt', 'context', 'math', 'options', 'statement', 'instruction'];
const STATIC = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ...['app.js', 'local-engine.js', 'remote-tutor.mjs', 'local-chatgpt.mjs', 'math.mjs', 'storage.mjs']
    .map(name => ['/assets/' + name, ['assets/' + name, 'text/javascript']]),
  ...['styles.css', 'readability.css'].map(name => ['/assets/' + name, ['assets/' + name, 'text/css']]),
  ...['curriculum.json', 'question-bank.json'].map(name => ['/assets/' + name, ['assets/' + name, 'application/json']]),
  ['/assets/favicon.svg', ['assets/favicon.svg', 'image/svg+xml']],
]);
const COOKIE = 'one_step_runtime';
const opaque = () => randomBytes(32).toString('base64url');
const validProfile = id => typeof id === 'string' && /^[a-zA-Z0-9-]{16,64}$/.test(id);
const MODES = new Set(['teacher_trial', 'student_operation']);
const BLOCKED = new Set(['subscription_sharing_user_not_eligible', 'subscription_sharing_invalid_user', 'chatpass_v2_scope_not_authorized']);
const BOUNDARY = /直接.{0,8}(答案|解答)|給.{0,8}(答案|完整解|解題過程)|幫我解|代.{0,3}(寫|解)|忽略.{0,15}(規則|指令)|system\s*prompt|ignore.{0,20}instruction|(?:give|tell|show).{0,20}(?:answer|solution)|solve\s+(?:it|this)/i;

async function bodyOf(request) {
  requireValue(request.headers['content-type']?.startsWith('application/json'), 'invalid_request', 415);
  const parts = []; let size = 0;
  for await (const part of request) {
    size += part.length; requireValue(size <= 8192, 'invalid_request', 413); parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new LocalError('invalid_request'); }
}
function callbackHTML(success, code) {
  // Only app-owned messages are rendered, never codes, tokens, email, or provider text.
  const messages = {consent_declined: '你未授權，仍可使用規則提示。', invalid_state: '這個登入連結已失效，請回到練習頁重新登入。',
    account_already_bound: '這個 ChatGPT 帳號已綁定另一份學習檔案。學生需以自己的帳號授權。',
    registration_incomplete: 'OpenAI 未完成註冊。請回到連線設定重試；若帳號不支援，保留規則提示。',
    session_changed: '練習檔案已切換，請回到目前檔案重新登入。'};
  return '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<title>一步｜ChatGPT 連線</title><body><main><h1>' + (success ? '授權流程已完成' : '尚未完成連線') + '</h1><p>' +
    (success ? '回到原本的練習分頁，查看帳號與模型狀態。完成實際提問後，網站才會標示 AI 已通過驗證。' :
      messages[code] || '目前無法完成連線。請回到 AI 連線設定查看狀態，或稍後重新登入。') +
    '</p><a href="/">回到練習網站</a><p>你也可以關閉這個分頁，回到原本的練習分頁。</p></main></body></html>';
}

export async function startLocalRuntime({root = ROOT, directory, vault: suppliedVault, port = 4318, fetcher = fetch,
  now = () => Date.now()} = {}) {
  const dataDirectory = directory || join(process.platform === 'win32' ? process.env.LOCALAPPDATA || homedir() :
    join(homedir(), '.config'), 'one-step-algebra');
  const vault = suppliedVault || await openVault(dataDirectory);
  const bank = JSON.parse(await readFile(join(root, 'assets/question-bank.json'), 'utf8'));
  const questions = new Map(bank.map(q => [q.id, Object.fromEntries(PUBLIC_FIELDS.filter(k => k in q).map(k => [k, q[k]]))]));
  const sessions = new Map(), tickets = new Map(), inflight = new Map(), cache = new Map(), usage = new Map();
  let origin;
  const oauth = createChatGPT({vault, fetcher, now, isPendingValid: attempt => {
    const session = sessions.get(attempt.browserId);
    return !!session && session.owner === attempt.owner && session.generation === attempt.generation;
  }});
  function deactivate(session) {
    oauth.cancel(session.id); session.controller?.abort(); session.controller = null;
    session.active = null; session.model = null; session.models = []; session.verified = false;
    session.generation++; session.status = 'not_connected'; session.diagnostic = null;
  }
  function modelFailure(session, error) {
    session.status = error instanceof LocalError ? error.code : 'models_unavailable';
    session.diagnostic = error instanceof LocalError ? error.diagnostic || null : null;
    session.models = []; session.model = null; session.verified = false;
  }
  function status(session) {
    const connections = session.owner ? oauth.list(session.owner) : [];
    const active = connections.find(c => c.id === session.active);
    return {local_runtime: true, runtime_version: '2026-11-10.1', diagnostic: session.diagnostic || null,
      plan_authorized: !!(active?.signed_in && active.sharing), context: session.owner, ready: !!(active?.signed_in && active.sharing && session.model && !BLOCKED.has(session.status)),
      connections, active: active?.id || null, email: active?.email || null, models: session.models,
      model: session.model, verified: session.verified, status: session.status};
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (value, code = 200) => { response.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'}); response.end(JSON.stringify(value)); };
    try {
      requireValue(request.headers.host === new URL(origin).host &&
        ['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress), 'host_not_allowed', 403);
      const url = new URL(request.url, origin);
      requireValue(request.url.startsWith('/') && !request.url.startsWith('//') && url.origin === origin && url.href.length < 16384, 'invalid_request');
      const cookie = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
      let session = cookie && sessions.get(cookie);
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        try {
          const result = await oauth.complete(url.searchParams), target = sessions.get(result.browserId);
          requireValue(target?.generation === result.generation && target.owner === result.owner, 'session_changed');
          target.active = result.connection.id; target.status = result.connection.sharing ? 'discovering_models' : 'plan_permission_required';
          if (result.connection.sharing) {
            try {
              const models = await oauth.models(target.active, target.owner);
              requireValue(target.generation === result.generation, 'session_changed');
              target.models = models; target.model = models[0]?.slug || null;
              target.status = 'awaiting_first_request'; target.diagnostic = null;
            } catch (error) { if (target.generation === result.generation) modelFailure(target, error); }
          }
          response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); response.end(callbackHTML(true));
        } catch (error) {
          response.writeHead(400, {'Content-Type': 'text/html; charset=utf-8'});
          response.end(callbackHTML(false, error instanceof LocalError ? error.code : 'authorization_failed'));
        }
        return;
      }
      requireValue(!request.headers.origin || request.headers.origin === origin, 'origin_not_allowed', 403);
      requireValue(!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(request.headers['sec-fetch-site']), 'origin_not_allowed', 403);
      if (request.method === 'GET' && STATIC.has(url.pathname)) {
        requireValue(!url.search || url.searchParams.size === 1 && /^[a-zA-Z0-9-]{1,80}$/.test(url.searchParams.get('v') || ''), 'invalid_request');
        if (url.pathname === '/' || url.pathname === '/index.html') {
          if (!session) {
            for (const [id, item] of sessions) if (now() - item.touched > 86400000) { deactivate(item); sessions.delete(id); }
            requireValue(sessions.size < 50, 'request_limit', 429);
            const id = opaque(); session = {id, owner: null, generation: 0, active: null, models: [], model: null,
              verified: false, status: 'not_connected', touched: now()}; sessions.set(id, session);
          }
          response.setHeader('Set-Cookie', `${COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/`);
        }
        const [file, type] = STATIC.get(url.pathname);
        response.writeHead(200, {'Content-Type': type + '; charset=utf-8'});
        const content = await readFile(join(root, file));
        response.end(file === 'index.html' ? content.toString('utf8').replace('data-mode="local"', 'data-mode="local" data-runtime="chatgpt"') : content); return;
      }
      requireValue(session, 'session_required', 401); session.touched = now();
      if (url.pathname === '/auth/continue' && request.method === 'GET') {
        const ticket = tickets.get(url.searchParams.get('ticket')); tickets.delete(url.searchParams.get('ticket'));
        requireValue(ticket && ticket.id === session.id && ticket.generation === session.generation && now() - ticket.created < 60000, 'invalid_state');
        const location = oauth.begin({owner: session.owner, browserId: session.id, generation: session.generation, connectionId: ticket.connection});
        response.writeHead(303, {Location: location}); response.end(); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/local-ai/status') { json(status(session)); return; }
      requireValue(request.method === 'POST' && request.headers.origin === origin && request.headers['x-one-step-client'] === '1', 'origin_not_allowed', 403);
      const body = await bodyOf(request);
      requireValue(body && typeof body === 'object' && !Array.isArray(body), 'invalid_request');
      if (url.pathname === '/api/local-ai/context') {
        requireValue(validProfile(body.profile_id) && MODES.has(body.mode), 'invalid_request');
        const owner = body.mode + ':' + body.profile_id;
        if (session.owner !== owner) { deactivate(session); session.owner = owner; }
        json(status(session)); return;
      }
      if (url.pathname === '/api/local-ai/pause') { deactivate(session); session.owner = null; json({ok: true}); return; }
      requireValue(session.owner, 'profile_required', 401);
      if (url.pathname === '/api/local-ai/auth/start') {
        requireValue(!body.connection_id || oauth.list(session.owner).some(c => c.id === body.connection_id), 'connection_not_found', 404);
        for (const [key, value] of tickets) if (value.id === session.id || now() - value.created > 60000) tickets.delete(key);
        const ticket = opaque(); tickets.set(ticket, {id: session.id, generation: session.generation, created: now(), connection: body.connection_id});
        json({navigate: '/auth/continue?ticket=' + ticket}); return;
      }
      if (url.pathname === '/api/local-ai/sign-out') {
        requireValue(oauth.list(session.owner).some(c => c.id === body.connection_id), 'connection_not_found', 404);
        const owner = session.owner; deactivate(session);
        // Stop all sessions that were explicitly using this same connection before revocation.
        for (const item of sessions.values()) if (item.active === body.connection_id) deactivate(item);
        json(await oauth.signOut(body.connection_id, owner)); return;
      }
      if (url.pathname === '/api/local-ai/resume' || url.pathname === '/api/local-ai/models') {
        if (url.pathname.endsWith('/resume')) {
          requireValue(oauth.list(session.owner).some(c => c.id === body.connection_id && c.signed_in && c.sharing), 'connection_not_found', 404);
          deactivate(session); session.active = body.connection_id;
        }
        requireValue(session.active, 'sign_in_required', 401);
        const generation = session.generation;
        try {
          const models = await oauth.models(session.active, session.owner);
          requireValue(generation === session.generation, 'session_changed', 409);
          session.models = models; session.model = models.some(m => m.slug === session.model) ? session.model : models[0]?.slug || null;
          if (!session.verified) session.status = 'awaiting_first_request';
          session.diagnostic = null;
        } catch (error) { if (generation === session.generation) modelFailure(session, error); throw error; }
        json(status(session)); return;
      }
      requireValue(session.active, 'sign_in_required', 401);
      if (url.pathname === '/api/local-ai/model') {
        requireValue(session.models.some(m => m.slug === body.model), 'invalid_model');
        session.model = body.model; session.verified = false;
        if(!BLOCKED.has(session.status))session.status = 'awaiting_first_request'; json(status(session)); return;
      }
      requireValue(url.pathname === '/api/local-ai/tutor', 'not_found', 404);
      requireValue(!BLOCKED.has(session.status), 'plan_permission_required', 403);
      requireValue(Object.keys(body).every(k => ['request_id', 'bank_id', 'message', 'action', 'profile_id', 'mode'].includes(k)) &&
        session.owner === body.mode + ':' + body.profile_id && typeof body.request_id === 'string' && /^[a-zA-Z0-9-]{16,64}$/.test(body.request_id) &&
        questions.has(body.bank_id) && typeof body.message === 'string' && body.message.trim() && body.message.length <= 1000 &&
        ['chat', 'hint', 'concept'].includes(body.action), 'invalid_request');
      if (BOUNDARY.test(body.message)) { json({card: 'answer_boundary', provider: 'rules', provider_status: 'answer_request'}); return; }
      requireValue(session.model, 'models_unavailable', 503);
      const generation = session.generation, active = session.active, model = session.model, owner = session.owner;
      const key = active + ':' + body.request_id, fingerprint = createHash('sha256').update(JSON.stringify([body.bank_id, body.message, body.action, model])).digest('hex');
      if (cache.has(key)) {
        const cached = cache.get(key); requireValue(cached.fingerprint === fingerprint, 'request_conflict', 409); json(cached.result); return;
      }
      requireValue(!inflight.has(active), 'request_in_progress', 409);
      const minute = active + ':' + Math.floor(now() / 60000), day = active + ':' + Math.floor(now() / 86400000);
      requireValue((usage.get(minute) || 0) < 10 && (usage.get(day) || 0) < 100, 'request_limit', 429);
      if (usage.size > 1000) usage.clear(); usage.set(minute, (usage.get(minute) || 0) + 1); usage.set(day, (usage.get(day) || 0) + 1);
      const controller = new AbortController(); session.controller = controller; inflight.set(active, controller);
      let result;
      try {
        result = await oauth.route(active, owner, model, {question: questions.get(body.bank_id), student_message: body.message, action: body.action},
          AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]));
        requireValue(generation === session.generation && session.active === active, 'session_changed', 409);
        session.verified = true; session.status = 'ok';
      } catch (error) {
        const code = error instanceof LocalError ? error.code : 'provider_unavailable';
        if (generation === session.generation) { session.status = code; session.verified = false; }
        result = {provider_status: code};
      } finally { inflight.delete(active); if (session.controller === controller) session.controller = null; }
      if (cache.size > 1000) cache.delete(cache.keys().next().value);
      cache.set(key, {fingerprint, result}); json(result);
    } catch (error) {
      if (!response.headersSent) json({error: error instanceof LocalError ? error.code : 'local_service_unavailable',
        ...(error instanceof LocalError && error.diagnostic ? {diagnostic: error.diagnostic} : {})}, error instanceof LocalError ? error.status : 503);
      else response.end();
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    origin = 'http://127.0.0.1:' + server.address().port; oauth.callback = origin + '/auth/callback';
  } catch (error) { await vault.close(); throw error; }
  return {origin, close: async () => {
    for (const session of sessions.values()) deactivate(session);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await vault.close();
  }};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    console.error('請先安裝 Node.js 24 或更新版本。'); process.exitCode = 1;
  } else {
    startLocalRuntime().then(runtime => {
      console.log(`一步數學已啟動：${runtime.origin}\n請在這台電腦的瀏覽器開啟網址，再從「AI 連線設定」登入 ChatGPT。\n關閉時按 Ctrl+C。`);
      let closing = false;
      const close = async () => { if (closing) return; closing = true; await runtime.close(); process.exitCode = 0; };
      process.once('SIGINT', close); process.once('SIGTERM', close);
    }).catch(error => {
      console.error(error.code === 'EADDRINUSE' ? '4318 埠已被使用，請關閉另一個本機實例後重試。' :
        error.message === 'local_runtime_already_running' ? '另一個一步數學服務正在執行。若曾強制關機，請參閱 local/README.md 的鎖定檔說明。' : '本機服務未能啟動，請確認 Node.js 版本與儲存目錄權限。');
      process.exitCode = 1;
    });
  }
}
