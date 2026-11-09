import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createHash, sign, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, stat, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {join} from 'node:path';
import {createChatGPT, readCardStream} from '../local/chatgpt.mjs';
import {openVault} from '../local/vault.mjs';
import {startLocalRuntime} from '../local/server.mjs';
import {makeLocalChatGPT} from '../assets/local-chatgpt.mjs';
import {makeAPI} from '../assets/local-engine.js';
import {memoryStore} from '../assets/storage.mjs';

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'test-key', alg: 'RS256', use: 'sig'};
const time = Date.parse('2026-11-09T12:00:00Z');
const clientId = 'oaiapp_test_registration';
const TOKEN_VALUE = 'PRIVATE_FAKE_OAUTH_ACCESS';
const REFRESH = 'PRIVATE_FAKE_REFRESH';
const profile1 = 'teacher-profile-00000001', profile2 = 'student-profile-00000002';
const claims = nonce => ({iss: 'https://auth.openai.com', sub: 'subject-teacher', aud: clientId,
  iat: time / 1000, exp: time / 1000 + 3600, nonce, email: 'test@example.invalid'});
function jwt(payload, header = {alg: 'RS256', kid: jwk.kid}) {
  const data = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return data + '.' + sign('sha256', Buffer.from(data), privateKey).toString('base64url');
}
function memoryVault(initial = {}) {
  let data = {version: 1, host_id: 'urn:uuid:00000000-0000-4000-8000-000000000001', connections: [], ...initial};
  return {read: () => structuredClone(data), change: async operation => operation(data), close: async () => {}};
}
function events(output = {card: 'concept'}, terminal = 'response.completed') {
  return new Response('data: ' + JSON.stringify({type: 'response.output_text.delta', delta: JSON.stringify(output)}) + '\n\n' +
    'data: ' + JSON.stringify({type: terminal}) + '\n\n', {headers: {'Content-Type': 'text/event-stream'}});
}
function provider() {
  const mock = {nonce: '', payload: null, output: {card: 'concept'}, calls: [], refreshes: 0, revoke: true, models: true};
  mock.fetcher = async (url, options = {}) => {
    mock.calls.push({url, options});
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({issuer: 'https://auth.openai.com',
      jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/oauth/revoke'});
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({keys: [jwk]});
    if (url.endsWith('/api/accounts/oauth/token')) {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('client_id'), clientId);
      assert.equal(form.get('resource'), 'https://api.openai.com/v1');
      assert.equal(form.has('client_secret'), false);
      if (form.get('grant_type') === 'authorization_code') {
        if (mock.challenge) assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), mock.challenge);
      } else { mock.refreshes++; assert.equal(form.has('scope'), false); }
      if (mock.tokenError) return Response.json({error: mock.tokenError}, {status: 400});
      return Response.json({access_token: TOKEN_VALUE, refresh_token: REFRESH + mock.refreshes,
        id_token: jwt(mock.payload || claims(mock.nonce)), token_type: 'Bearer', expires_in: 3600,
        scope: mock.scope || 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct'});
    }
    if (url.endsWith('/oauth/revoke')) return new Response('', {status: mock.revoke ? 200 : 503});
    if (url.endsWith('/v1/models')) {
      if (!mock.models) return Response.json({error: {}}, {status: 503});
      return Response.json({models: [{slug: 'model-test', display_name: 'Test model', visibility: 'list'},
        {slug: 'hidden', display_name: 'Hidden', visibility: 'hidden'}]});
    }
    if (url.endsWith('/v1/responses')) {
      assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN_VALUE);
      if (mock.inferenceError) return Response.json({error: {code: mock.inferenceError, message: 'PRIVATE PROVIDER DETAILS'}}, {status: 403});
      return events(mock.output);
    }
    throw new Error('Unexpected mock URL');
  };
  return mock;
}
async function completedOAuth({payload, callbackClient = clientId, scope} = {}) {
  const vault = memoryVault(), mock = provider(); mock.payload = payload; mock.scope = scope;
  const oauth = createChatGPT({vault, fetcher: mock.fetcher, now: () => time});
  oauth.callback = 'http://127.0.0.1:4318/auth/callback';
  const url = new URL(oauth.begin({owner: 'teacher_trial:' + profile1, browserId: 'browser1', generation: 0}));
  mock.nonce = url.searchParams.get('nonce'); mock.challenge = url.searchParams.get('code_challenge');
  const query = new URLSearchParams({state: url.searchParams.get('state'), code: 'test-code', client_id: callbackClient});
  return {oauth, vault, mock, url, query};
}

test('OAuth uses PKCE, stable host and loopback; issued client ID is used for exchange and returning sign-in', async () => {
  const f = await completedOAuth();
  assert.equal(f.url.origin, 'https://auth.openai.com');
  assert.equal(f.url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(f.url.searchParams.get('redirect_uri'), f.oauth.callback);
  assert.equal(f.url.searchParams.get('agent_name_hint'), 'One Step Algebra');
  assert.equal(f.url.searchParams.get('code_challenge_method'), 'S256');
  const result = await f.oauth.complete(f.query);
  assert.equal(result.connection.sharing, true); assert.equal(JSON.stringify(result).includes(TOKEN_VALUE), false);
  const returning = new URL(f.oauth.begin({owner: 'teacher_trial:' + profile1, browserId: 'browser1', generation: 0, connectionId: result.connection.id}));
  assert.equal(returning.searchParams.get('client_id'), clientId);
  assert.equal(returning.searchParams.get('ext_agent_host_id'), f.url.searchParams.get('ext_agent_host_id'));
  assert.equal(returning.searchParams.has('agent_name_hint'), false);
  assert.equal(returning.searchParams.get('id_token_hint'), f.vault.read().connections[0].id_token);
});

test('callback rejects wrong, replayed or duplicate state, missing issued client and mismatched client', async () => {
  const f = await completedOAuth();
  await assert.rejects(f.oauth.complete(new URLSearchParams({state: 'fake', code: 'test'})), /invalid_state/);
  assert.equal(f.mock.calls.length, 0);
  const duplicate = new URLSearchParams(f.query); duplicate.append('state', 'fake');
  await assert.rejects(f.oauth.complete(duplicate), /invalid_callback/);
  f.query.delete('client_id'); await assert.rejects(f.oauth.complete(f.query), /registration_incomplete/);
  assert.equal(f.mock.calls.length, 0);
  const g = await completedOAuth(), result = await g.oauth.complete(g.query);
  await assert.rejects(g.oauth.complete(g.query), /invalid_state/);
  const url = new URL(g.oauth.begin({owner: 'teacher_trial:' + profile1, browserId: 'browser1', generation: 0, connectionId: result.connection.id}));
  await assert.rejects(g.oauth.complete(new URLSearchParams({state: url.searchParams.get('state'), code: 'test', client_id: 'oaiapp_other'})), /client_mismatch/);
});

test('unverified JWT claims cannot save credentials: nonce, issuer, audience, expiry, signature and algorithm', async () => {
  for (const mutate of [p => ({...p, nonce: 'wrong'}), p => ({...p, iss: 'https://evil.invalid'}),
    p => ({...p, aud: 'other-client'}), p => ({...p, exp: time / 1000 - 1}), p => ({...p, sub: ''})]) {
    const f = await completedOAuth(); f.mock.payload = mutate(claims(f.mock.nonce));
    await assert.rejects(f.oauth.complete(f.query), /invalid_identity/);
    assert.equal(f.vault.read().connections.some(c => c.access_token), false);
  }
  for (const kind of ['signature', 'algorithm']) {
    const f = await completedOAuth(), original = f.mock.fetcher;
    const oauth = createChatGPT({vault: f.vault, now: () => time, fetcher: async (url, options) => {
      const result = await original(url, options);
      if (!url.endsWith('/api/accounts/oauth/token')) return result;
      const body = await result.json();
      if (kind === 'algorithm') body.id_token = jwt(claims(f.mock.nonce), {alg: 'none', kid: jwk.kid});
      else body.id_token = body.id_token.slice(0, -6) + 'BADBAD';
      return Response.json(body);
    }});
    oauth.callback = f.oauth.callback;
    const url = new URL(oauth.begin({owner: 'owner', browserId: 'b', generation: 0}));
    f.mock.nonce = url.searchParams.get('nonce'); f.mock.challenge = url.searchParams.get('code_challenge');
    await assert.rejects(oauth.complete(new URLSearchParams({state: url.searchParams.get('state'), code: 'x', client_id: clientId})), /invalid_identity/);
  }
});

test('identity-only authorization never enables plan inference', async () => {
  const f = await completedOAuth({scope: 'openid email profile'}), result = await f.oauth.complete(f.query);
  assert.equal(result.connection.sharing, false);
  await assert.rejects(f.oauth.models(result.connection.id, 'teacher_trial:' + profile1), /plan_permission_required/);
  assert.equal(f.mock.calls.some(c => c.url.includes('/v1/')), false);
});

test('refresh is serialized and rotating tokens replace old records; sign-out revokes and clears tokens', async () => {
  const f = await completedOAuth(), result = await f.oauth.complete(f.query), owner = 'teacher_trial:' + profile1;
  await f.vault.change(data => { data.connections[0].expires_at = 0; });
  const values = await Promise.all([f.oauth.access(result.connection.id, owner), f.oauth.access(result.connection.id, owner)]);
  assert.deepEqual(values, [TOKEN_VALUE, TOKEN_VALUE]); assert.equal(f.mock.refreshes, 1);
  assert.equal(f.vault.read().connections[0].refresh_token, REFRESH + '1');
  const signedOut = await f.oauth.signOut(result.connection.id, owner);
  assert.equal(signedOut.revoked, true);
  const saved = f.vault.read().connections[0]; assert.equal(saved.client_id, clientId);
  assert.equal(['access_token', 'refresh_token', 'id_token'].some(k => k in saved), false);
});

test('terminal refresh clears credentials while a transient failure preserves them; failed revocation is disclosed', async () => {
  const f = await completedOAuth(), result = await f.oauth.complete(f.query), owner = 'teacher_trial:' + profile1;
  await f.vault.change(data => { data.connections[0].expires_at = 0; });
  f.mock.tokenError = 'temporary_failure'; await assert.rejects(f.oauth.access(result.connection.id, owner));
  assert.equal(!!f.vault.read().connections[0].refresh_token, true);
  f.mock.tokenError = 'invalid_grant'; await assert.rejects(f.oauth.access(result.connection.id, owner), /sign_in_required/);
  assert.equal(!!f.vault.read().connections[0].refresh_token, false);
  const g = await completedOAuth(), r = await g.oauth.complete(g.query); g.mock.revoke = false;
  assert.equal((await g.oauth.signOut(r.connection.id, owner)).revoked, false);
});

test('SSE requires completed inference and exact approved enum, rejects answer text and partial output', async () => {
  assert.deepEqual(await readCardStream(events({card: 'hint'})), {card: 'hint', provider: 'llm', provider_status: 'ok'});
  for (const bad of [{card: 'hint', answer: 'PRIVATE_ANSWER'}, {card: 'x = 4'}, {card: {text: 'answer'}}, ['hint']]) {
    await assert.rejects(readCardStream(events(bad)));
  }
  await assert.rejects(readCardStream(new Response('data: {"type":"response.output_text.delta","delta":"{}"}\n\n')), /incomplete_response/);
  await assert.rejects(readCardStream(events({card: 'hint'}, 'response.failed')), /provider_unavailable/);
  const source = await events().text(), bytes = new TextEncoder().encode(source.replaceAll('\n', '\r\n'));
  const split = new Response(new ReadableStream({start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close();
  }}));
  assert.equal((await readCardStream(split)).card, 'concept');
});

async function runtimeFixture(t) {
  const mock = provider(), vault = memoryVault(), runtime = await startLocalRuntime({port: 0, vault, fetcher: mock.fetcher, now: () => time});
  t.after(runtime.close);
  const home = await fetch(runtime.origin); const cookie = home.headers.get('set-cookie').split(';')[0];
  const call = (path, body, more = {}) => fetch(runtime.origin + path, {redirect: 'manual',
    headers: {Cookie: cookie, ...(body === undefined ? {} : {Origin: runtime.origin, 'Content-Type': 'application/json', 'X-One-Step-Client': '1'}), ...more},
    ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)})});
  async function connect(profile = profile1, mode = 'teacher_trial', connection_id) {
    await call('/api/local-ai/context', {profile_id: profile, mode});
    const start = await (await call('/api/local-ai/auth/start', {connection_id})).json();
    const redirect = await call(start.navigate), url = new URL(redirect.headers.get('location'));
    mock.nonce = url.searchParams.get('nonce'); mock.challenge = url.searchParams.get('code_challenge');
    const result = await call('/auth/callback?' + new URLSearchParams({state: url.searchParams.get('state'), client_id: clientId, code: 'test'}));
    return {result, url, status: await (await call('/api/local-ai/status')).json()};
  }
  return {mock, vault, runtime, home, cookie, call, connect};
}

test('local HTTP runtime authenticates, discovers account models, streams enum and never exposes provider or bank secrets', async t => {
  const f = await runtimeFixture(t);
  assert.match(await f.home.text(), /data-runtime="chatgpt"/);
  const {result, status} = await f.connect(); assert.equal(result.status, 200);
  assert.equal(status.ready, true); assert.equal(status.verified, false); assert.equal(status.models.length, 1);
  const bank = JSON.parse(await readFile(new URL('../assets/question-bank.json', import.meta.url)));
  const input = {profile_id: profile1, mode: 'teacher_trial', request_id: randomUUID(), bank_id: bank[0].id, message: '什麼是等量公理？', action: 'chat'};
  const result1 = await (await f.call('/api/local-ai/tutor', input)).json();
  assert.deepEqual(result1, {card: 'concept', provider: 'llm', provider_status: 'ok'});
  assert.equal((await (await f.call('/api/local-ai/status')).json()).verified, true);
  const providerCall = f.mock.calls.find(c => c.url.endsWith('/v1/responses')), sent = JSON.parse(providerCall.options.body);
  assert.equal(sent.store, false); assert.equal(sent.stream, true); assert.equal(Array.isArray(sent.input), true);
  const context = JSON.parse(sent.input[0].content);
  assert.equal(['answer', 'hints', 'explanation', 'work_answer', 'seed'].some(k => k in context.question), false);
  assert.equal(JSON.stringify(context).includes(profile1), false);
  assert.equal(['max_output_tokens', 'temperature', 'previous_response_id', 'tools'].some(k => k in sent), false);
  await f.call('/api/local-ai/tutor', input);
  assert.equal(f.mock.calls.filter(c => c.url.endsWith('/v1/responses')).length, 1);
  const altered = await f.call('/api/local-ai/tutor', {...input, message: '另一個問題'}); assert.equal(altered.status, 409);
  const boundary = await (await f.call('/api/local-ai/tutor', {...input, request_id: randomUUID(), message: '給我答案'})).json();
  assert.equal(boundary.card, 'answer_boundary'); assert.equal(f.mock.calls.filter(c => c.url.endsWith('/v1/responses')).length, 1);
  f.mock.output = {card: 'hint', answer: 'PRIVATE_ANSWER'};
  const invalid = await (await f.call('/api/local-ai/tutor', {...input, request_id: randomUUID()})).json();
  assert.equal(invalid.provider, undefined); assert.equal(JSON.stringify(invalid).includes('PRIVATE_'), false);
  f.mock.inferenceError = 'subscription_sharing_user_not_eligible';
  const denied = await (await f.call('/api/local-ai/tutor', {...input, request_id: randomUUID()})).json();
  assert.equal(denied.provider_status, f.mock.inferenceError); assert.equal(JSON.stringify(denied).includes('PRIVATE'), false);
  assert.equal((await (await f.call('/api/local-ai/status')).json()).ready, false);
  const count = f.mock.calls.length;
  assert.equal((await f.call('/api/local-ai/tutor', {...input, request_id: randomUUID()})).status, 403);
  assert.equal(f.mock.calls.length, count);
  const summary = await (await f.call('/api/local-ai/status')).text();
  assert.equal(summary.includes(TOKEN_VALUE) || summary.includes(REFRESH) || summary.includes('id_token'), false);
});

test('Host, Origin and CSRF protections; static server cannot serve credentials, source or arbitrary files', async t => {
  const f = await runtimeFixture(t);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(f.runtime.origin, {headers: {Host: 'evil.invalid'}}, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await f.call('/api/local-ai/context', {profile_id: profile1, mode: 'teacher_trial'}, {Origin: 'https://evil.invalid'})).status, 403);
  assert.equal((await fetch(f.runtime.origin + '/api/local-ai/context', {method: 'POST', headers: {Cookie: f.cookie, 'Content-Type': 'application/json'}, body: '{}'})).status, 403);
  assert.equal((await fetch(f.runtime.origin + '/api/local-ai/status')).status, 401);
  for (const path of ['/.env.local', '/local/chatgpt.mjs', '/chatgpt.json', '/assets/../.env.local', '/assets/%2e%2e/.env.local']) {
    const response = await f.call(path); assert.notEqual(response.status, 200);
    assert.equal((await response.text()).includes(TOKEN_VALUE), false);
  }
});

test('switching teacher to student pauses the connection and blocks teacher subscription reuse', async t => {
  const f = await runtimeFixture(t), teacher = await f.connect();
  await f.call('/api/local-ai/context', {profile_id: profile2, mode: 'student_operation'});
  const status = await (await f.call('/api/local-ai/status')).json();
  assert.equal(status.ready, false); assert.deepEqual(status.connections, []);
  assert.equal((await f.call('/api/local-ai/auth/start', {connection_id: teacher.status.active})).status, 404);
  const student = await f.connect(profile2, 'student_operation');
  assert.equal(student.result.status, 400); assert.match(await student.result.text(), /另一份學習檔案/);
  assert.equal(f.vault.read().connections.filter(c => c.access_token).length, 1);
});

test('a pending login cannot become active after switching learning profiles', async t => {
  const f = await runtimeFixture(t);
  await f.call('/api/local-ai/context', {profile_id: profile1, mode: 'teacher_trial'});
  const start = await (await f.call('/api/local-ai/auth/start', {})).json();
  const url = new URL((await f.call(start.navigate)).headers.get('location'));
  await f.call('/api/local-ai/context', {profile_id: profile2, mode: 'student_operation'});
  const result = await f.call('/auth/callback?' + new URLSearchParams({state: url.searchParams.get('state'), code: 'test', client_id: clientId}));
  assert.equal(result.status, 400); assert.equal(f.mock.calls.length, 0);
});

test('browser adapter refuses model free text and never sends OAuth credentials', async () => {
  const sent = [], context = {profile_id: profile1, mode: 'teacher_trial'};
  const adapter = makeLocalChatGPT({fetcher: async (path, options) => {
    sent.push({path, options});
    if (path.endsWith('tutor')) return Response.json({card: 'hint', provider: 'llm', reply: 'PRIVATE_ANSWER'});
    return Response.json({ready: true, context: context.mode + ':' + context.profile_id, status: 'ok', connections: [], models: []});
  }});
  await adapter.setContext(profile1, 'teacher_trial');
  const result = await adapter.route({request_id: randomUUID(), bank_id: 'bank-1', message: '提示', action: 'hint', local_profile_id: profile1, local_mode: 'teacher_trial'});
  assert.equal(result.provider, undefined); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(sent.some(c => 'Authorization' in c.options.headers), false);
  await adapter.setContext(profile2, 'student_operation');
  assert.equal((await adapter.route({local_profile_id: profile1, local_mode: 'teacher_trial'})).provider_status, 'session_changed');
});

test('malicious AI cards cannot add answers to student feedback or logs; teacher and student logs stay separate', async () => {
  const curriculum = JSON.parse(await readFile(new URL('../assets/curriculum.json', import.meta.url)));
  const bank = JSON.parse(await readFile(new URL('../assets/question-bank.json', import.meta.url)));
  const map = new Map(), session = {getItem: k => map.get(k), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k)};
  const store = memoryStore(), api = makeAPI({store, curriculum, bank, session, router: async () => ({provider: 'llm', card: 'concept', reply: 'PRIVATE_ANSWER'})});
  for (const role of ['teacher', 'student']) {
    const {profile} = await api('/api/local/profiles', {name: role, role}); await api('/api/local/select', {id: profile.id});
    const practice = await api('/api/practice/start', {});
    const result = await api('/api/questions/' + practice.question.id + '/chat', {client_id: randomUUID(), message: '什麼是這個觀念？', action: 'chat'});
    assert.equal(result.reply.includes('PRIVATE_ANSWER'), false);
  }
  const data = await store.transact(d => d);
  assert.deepEqual(new Set(data.chats.map(c => c.mode)), new Set(['teacher_trial', 'student_operation']));
  assert.equal(JSON.stringify(data.events).includes('PRIVATE_ANSWER'), false);
});

test('credential vault uses private atomic files, rejects symlinks and prevents concurrent refresh processes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'one-step-test-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const vault = await openVault(dir);
  assert.equal((await vault.read()).host_id.startsWith('urn:uuid:'), true);
  await assert.rejects(openVault(dir), /local_runtime_already_running/);
  await vault.change(data => { data.connections.push({id: 'test', access_token: TOKEN_VALUE}); });
  assert.equal(JSON.parse(await readFile(join(dir, 'chatgpt.json'))).connections[0].access_token, TOKEN_VALUE);
  if (process.platform !== 'win32') {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'chatgpt.json'))).mode & 0o777, 0o600);
  }
  const originalHost = vault.read().host_id; await vault.close();
  const restored = await openVault(dir); assert.equal(restored.read().host_id, originalHost); await restored.close();
  const target = await mkdtemp(join(tmpdir(), 'one-step-target-')); t.after(() => rm(target, {recursive: true, force: true}));
  await rm(join(dir, 'chatgpt.json')); await symlink(join(target, 'secret'), join(dir, 'chatgpt.json'));
  await assert.rejects(openVault(dir), /unsafe_storage/);
});
