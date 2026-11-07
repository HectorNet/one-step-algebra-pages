import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createTutorService} from '../backend/tutor-service.mjs';
import {makeRemoteTutor,endpointURL} from '../assets/remote-tutor.mjs';
import {makeAPI} from '../assets/local-engine.js';
import {memoryStore} from '../assets/storage.mjs';

const origin='https://hectornet.github.io',secret='pilot-code-for-automated-tests',key='provider-secret-never-shared';
const q={id:'bank-1',skill_id:'basic',level:1,kind:'short_answer',prompt:'找出 x',math:'x+1=5',answer:'PRIVATE_ANSWER',work_answer:'PRIVATE_WORK',seed:'PRIVATE_SEED'};
const kv=()=>{const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
function fixture(card='concept'){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../backend/tutor-schema.sql',import.meta.url),'utf8'));
  const DB={prepare:sql=>({bind:(...values)=>({first:async()=>db.prepare(sql).get(...values)||null,run:async()=>db.prepare(sql).run(...values)})})};
  const calls=[],env={DB,PILOT_ACCESS_CODE:secret,OPENAI_API_KEY:key,OPENAI_MODEL:'mock-model',MAX_DAILY_REQUESTS:'3',MAX_MINUTE_REQUESTS:'2'};
  const service=createTutorService({bank:[q],fetcher:async(url,init)=>{calls.push({url,init});return Response.json({choices:[{message:{content:JSON.stringify(typeof card==='string'?{card}:card)}}]});},now:()=>new Date('2026-11-08T00:01:00Z')});
  const call=(id='request-0000000001',overrides={},headers={})=>service.fetch(new Request('https://tutor.test/api/tutor',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+secret,'Content-Type':'application/json',...headers},body:JSON.stringify({request_id:id,bank_id:q.id,message:'我想理解等量公理的意思',action:'chat',...overrides})}),env);
  return {db,env,service,calls,call};
}
test('backend requires allowed origin and classroom authorization before spending',async()=>{
  const f=fixture();assert.equal((await f.call(undefined,{}, {Origin:'https://other.test'})).status,403);
  assert.equal((await f.call(undefined,{}, {Authorization:'Bearer wrong'})).status,401);
  assert.equal(f.calls.length,0);
  const status=await f.service.fetch(new Request('https://tutor.test/api/status',{headers:{Origin:origin,Authorization:'Bearer '+secret}}),f.env);
  assert.deepEqual(await status.json(),{ready:true});
  assert.equal(status.headers.get('access-control-allow-origin'),origin);
  f.env.OPENAI_API_KEY='';assert.equal((await f.call()).status,503);
});
test('model receives canonical public fields; response cannot leak keys or model text',async()=>{
  const f=fixture();const response=await f.call(),data=await response.json();
  assert.deepEqual(data,{card:'concept',provider:'llm',provider_status:'ok'});
  const sent=JSON.parse(f.calls[0].init.body);
  assert.equal(f.calls[0].init.headers.Authorization,'Bearer '+key);
  assert.equal(JSON.stringify(sent).includes('PRIVATE_'),false);
  assert.equal(JSON.stringify(data).includes(key),false);
  assert.equal(f.db.prepare('SELECT response FROM tutor_requests').get().response.includes('公理'),false);
});
test('answer requests skip model; schema violations cannot return a generated answer',async()=>{
  const f=fixture();const reply=await (await f.call(undefined,{message:'直接給我答案和完整解題過程'})).json();
  assert.equal(reply.card,'answer_boundary');assert.equal(f.calls.length,0);
  const bad=fixture({card:'concept',reply:'x=4'});const result=await bad.call();
  assert.equal(result.status,503);assert.equal((await result.text()).includes('x=4'),false);
});
test('quota is enforced in SQLite and duplicate requests do not spend twice',async()=>{
  const f=fixture();assert.equal((await f.call()).status,200);assert.equal((await f.call()).status,200);assert.equal(f.calls.length,1);
  assert.equal((await f.call(undefined,{message:'changed message'})).status,409);
  assert.equal((await f.call('request-0000000002')).status,200);
  assert.equal((await f.call('request-0000000003')).status,429);assert.equal(f.calls.length,2);
});
test('unapproved input fields and oversized bodies never reach the provider',async()=>{
  const f=fixture();assert.equal((await f.call(undefined,{answer:'injected',student_name:'name'})).status,400);
  assert.equal((await f.call(undefined,{message:'a'.repeat(9000)})).status,400);assert.equal(f.calls.length,0);
});
test('client stores only service URL and tab-scoped classroom code, never provider keys',async()=>{
  const preferences=kv(),session=kv(),calls=[];
  const remote=makeRemoteTutor({preferences,session,fetcher:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/status')?{ready:true}:{card:'hint',provider:'llm',provider_status:'ok'});}});
  await assert.rejects(remote.configure('https://tutor.test',' sk-real-secret-key-value '));assert.equal(calls.length,0);
  assert.throws(()=>endpointURL('https://name:password@tutor.test'));
  assert.throws(()=>endpointURL('http://tutor.test'));
  await remote.configure('https://tutor.test/',secret);assert.equal(remote.settings().ready,true);
  await remote.route({request_id:'id',bank_id:'bank',message:'觀念',action:'chat',name:'MUST_NOT_SEND',answer:'MUST_NOT_SEND'});
  assert.equal(calls[1].options.body.includes('MUST_NOT_SEND'),false);
  remote.disconnect();assert.equal(await remote.route({}),null);
});
test('client rejects unreviewed remote text and fails back safely',async()=>{
  const remote=makeRemoteTutor({preferences:kv(),session:kv(),fetcher:async url=>Response.json(url.endsWith('/status')?{ready:true}:{card:'hint',provider:'llm',reply:'unreviewed solution'})});
  await remote.configure('https://tutor.test',secret);assert.equal((await remote.route({})).provider_status,'provider_unavailable');
});
test('network wait is outside storage transaction and cannot earn independent credit',async()=>{
  const bank=JSON.parse(readFileSync(new URL('../assets/question-bank.json',import.meta.url))),curriculum=JSON.parse(readFileSync(new URL('../assets/curriculum.json',import.meta.url)));
  const store=memoryStore(),session=kv();let finish,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const api=makeAPI({store,session,bank,curriculum,router:()=>{entered();return new Promise(resolve=>{finish=resolve;});}});
  const {profile}=await api('/api/local/profiles',{name:'anonymous test',role:'student'});await api('/api/local/select',{id:profile.id});
  const p=await api('/api/practice/start',{}),chatPath=`/api/questions/${p.question.id}/chat`;
  const pending=api(chatPath,{client_id:crypto.randomUUID(),message:'我需要一點提示',action:'hint'});await started;
  const privateQuestion=await store.transact(d=>d.questions.find(q=>q.id===p.question.id).private);
  const attempt=await api(`/api/questions/${p.question.id}/attempt`,{client_id:crypto.randomUUID(),answer:privateQuestion.answer,explanation:''});
  assert.equal(attempt.independent,false);finish({card:'hint',provider:'llm',provider_status:'ok'});
  await assert.rejects(pending,error=>error.status===409);
});

test('public bank retains all 1056 original grading variants', async()=>{const {grade}=await import('../assets/math.mjs');const bank=JSON.parse(readFileSync(new URL('../assets/question-bank.json',import.meta.url)));assert.equal(bank.length,1056);for(const q of bank)assert.equal(grade(q,q.answer).correct,true,q.id);});

test('disabled billing gate makes no provider calls',async()=>{const f=fixture();f.env.API_ENABLED='0';assert.equal((await f.call()).status,503);assert.equal(f.calls.length,0);});
test('inactive service never saves a classroom code',async()=>{const remote=makeRemoteTutor({preferences:kv(),session:kv(),fetcher:async()=>Response.json({ready:false})});await assert.rejects(remote.configure('https://tutor.test',secret),/尚未啟用/);assert.equal(remote.settings().hasCode,false);});
