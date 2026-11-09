import {grade,checkStep} from './math.mjs';
import {indexedStore} from './storage.mjs';
import {remoteTutor} from './remote-tutor.mjs';

const PUBLIC=new Set(['id','skill_id','level','chapter_id','skill_title','template_id','kind','prompt','context','math','options','statement','instruction','answer_type']);
const publicQuestion=q=>Object.fromEntries(Object.entries(q).filter(([key])=>PUBLIC.has(key)));
const clone=x=>structuredClone(x);
const boundary='我可以檢查你自己寫的答案或步驟，也可以陪你想；這題的解法與答案需要由你完成。先告訴我，你卡在題意、列式，還是計算？';
const answerRequest=/直接.{0,8}(答案|解答)|給.{0,8}(答案|完整解|解題過程)|幫我解|代.{0,3}(寫|解)|忽略.{0,15}(規則|指令)|system\s*prompt|ignore.{0,20}instruction|(?:give|tell|show).{0,20}(?:answer|solution)|solve\s+(?:it|this)/i;
const CLIENT_EVENTS=new Set(['question_viewed','answer_changed','explanation_changed','tab_visibility','window_focus','heartbeat','navigation','paste_detected','session_end','help_panel_toggled','ai_connection_started','ai_connection_state']);
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const modeFor=user=>user.role==='teacher'?'teacher_trial':'student_operation';

export function makeAPI({store,curriculum,bank,session,uuid=()=>crypto.randomUUID(),clock=()=>new Date().toISOString(),router=null}){
  const skills=Object.fromEntries(curriculum.chapters.flatMap(c=>c.skills.map(s=>[s.id,{...s,chapter_id:c.id}]))),order=Object.keys(skills);
  const pools=new Map();
  for(const q of bank){const key=`${q.skill_id}:${q.level}:${q.kind}`;if(!pools.has(key))pools.set(key,[]);pools.get(key).push(q);}
  const sessionKey='one-step-local-profile-v1',sessionIdKey='one-step-local-session-v1';
  function current(d,teacher=false){
    const user=d.profiles.find(u=>u.id===session.getItem(sessionKey)&&u.active);
    if(!user)fail(401,'請先選擇本機學習檔案。');
    if(teacher&&user.role!=='teacher')fail(403,'請切換到老師試用檔案。');
    return user;
  }
  function record(d,user,kind,payload={},run=null,questionId=null,extra={}){
    const event={id:uuid(),actor_id:user.id,actor_role:user.role,mode:run?.mode||(user.role==='teacher'?'teacher_admin':'student_operation'),
      run_id:run?.id||null,question_id:questionId,kind,payload_json:JSON.stringify(payload),client_at:null,received_at:clock(),
      session_id:session.getItem(sessionIdKey),source:'local_engine',...extra};
    d.events.push(event);return event;
  }
  function createProfile(d,name,role){
    name=String(name||'').trim();
    if(!name||name.length>40||!['teacher','student'].includes(role))fail(422,'請填寫 40 字以內的暱稱並選擇模式。');
    const user={id:uuid(),name,role,active:true,is_demo:false,created_at:clock()};d.profiles.push(user);return user;
  }
  const getProgress=(d,user,mode,skill)=>d.progress.find(p=>p.user_id===user.id&&p.mode===mode&&p.skill_id===skill)||{user_id:user.id,mode,skill_id:skill,level:1,status:'practicing',review_due_at:null,stage_after_seq:0};
  function progressList(d,user,mode){
    return order.map(skill=>{
      const attempts=d.attempts.filter(a=>a.user_id===user.id&&a.mode===mode&&a.skill_id===skill);
      return {...getProgress(d,user,mode,skill),title:skills[skill].title,chapter_id:skills[skill].chapter_id,
        total:attempts.length,correct:attempts.filter(a=>a.correct).length,independent:attempts.filter(a=>a.correct&&a.first_attempt&&a.independent).length};
    });
  }
  function owned(d,user,id){
    const row=d.questions.find(q=>q.id===id),run=row&&d.runs.find(r=>r.id===row.run_id&&r.user_id===user.id);
    if(!row||!run)fail(404,'找不到這次練習的題目。');return {row,run,q:row.private};
  }
  function packagePractice(d,user,run,row){
    return {run:{id:run.id,mode:run.mode},question:publicQuestion(row.private),question_number:d.questions.filter(q=>q.run_id===run.id).length,
      question_status:row.status,assisted:row.assisted,hint_count:row.hint_count,active_ms:row.active_ms,
      progress:progressList(d,user,run.mode),
      chats:d.chats.filter(c=>c.question_id===row.id).map(clone),steps:d.steps.filter(s=>s.question_id===row.id).map(clone),
      attempts:d.attempts.filter(a=>a.question_id===row.id).map(a=>({answer:JSON.parse(a.answer_json),explanation:a.explanation,correct:a.correct,feedback:clone(a.feedback)}))};
  }
  function decide(d,user,run,row,v,first,independent,explanation){
    const q=row.private,old=getProgress(d,user,run.mode,q.skill_id),p={...old};
    const relevant=d.attempts.filter(a=>a.user_id===user.id&&a.mode===run.mode&&a.skill_id===q.skill_id&&a.first_attempt&&a.seq>p.stage_after_seq&&a.level===p.level).slice(-12).reverse();
    const correct= relevant.slice(0,6).filter(a=>a.correct&&a.independent);
    let action='practice',reason='再用不同題目確認這個觀念。';
    if(p.status==='mastered'&&!v.correct){p.status='practicing';p.review_due_at=null;}
    if(old.status==='mastered'&&v.correct){action='next_skill';reason='這個能力已完成當次確認，可以選擇下一個能力。';}
    else if(!v.correct&&first&&relevant.length>=2&&relevant.slice(0,2).every(a=>!a.correct)){
      p.level=Math.max(1,p.level-1);p.status='practicing';action='simplify';reason='先減少計算負擔，集中練習目前卡住的觀念。';
    }else if(v.correct&&!independent){action='independent_check';reason='這題已完成；下一題請試著不使用提示，確認能自己做到。';}
    else if(v.correct&&independent&&correct.length>=3&&new Set(correct.map(a=>a.template_id)).size>=2&&correct.some(a=>a.kind==='short_answer')){
      if(/用猜|猜的|不知道為什麼|不確定理由/.test(explanation)){action='independent_check';reason='計算已通過，再用一題確認你的理解。';}
      else if(p.level<3){p.level++;action='level_up';reason='已有多次獨立作答的證據，下一題增加一個難度面向。';}
      else {p.status='mastered';p.review_due_at=new Date(Date.parse(clock())+7*86400000).toISOString();action='next_skill';reason='已完成這個能力的當次確認；七天後再回來複習。';}
    }else if(!v.correct){reason='先檢查目前的錯誤，再用同一觀念的題目練習。';}
    if(p.level!==old.level||p.status!==old.status)p.stage_after_seq=d.seq;
    p.updated_at=clock();
    const index=d.progress.findIndex(x=>x.user_id===user.id&&x.mode===run.mode&&x.skill_id===q.skill_id);
    if(index<0)d.progress.push(p);else d.progress[index]=p;
    const next=order[order.indexOf(q.skill_id)+1];
    if(action==='next_skill'&&!next)reason='已完成本章最後一個能力的當次確認，可以選擇其他能力複習。';
    return {action,reason,level:p.level,status:p.status,next_skill_id:action==='next_skill'&&next?next:q.skill_id,
      independent_correct:correct.length,target:3,review_due_at:p.review_due_at,ai_recommendation:'not_used',policy_version:'local-pilot-1'};
  }
  function start(d,user,body){
    if(body.skill_id&&!skills[body.skill_id])fail(422,'找不到這個能力。');
    let run=d.runs.find(r=>r.user_id===user.id);
    if(!run){run={id:uuid(),user_id:user.id,mode:modeFor(user),created_at:clock()};d.runs.push(run);record(d,user,'practice_started',{},run);}
    const previous=d.questions.filter(q=>q.run_id===run.id).at(-1);
    if(previous&&(body.reason||'start')==='start'&&!body.skill_id)return packagePractice(d,user,run,previous);
    if(previous&&body.reason!=='start'&&body.previous_question_id!==previous.id)fail(409,'題目已更新，請重新整理。');
    if(previous?.status==='open'){previous.status='skipped';record(d,user,'question_skipped',{reason:body.reason},run,previous.id);}
    const skill=body.skill_id||previous?.skill_id||order[0];let p=getProgress(d,user,run.mode,skill);
    if(p.status==='mastered'&&p.review_due_at<=clock()){
      p.status='practicing';p.stage_after_seq=d.seq;record(d,user,'review_started',{skill_id:skill},run);
    }
    const past=d.questions.filter(q=>q.user_id===user.id&&q.skill_id===skill&&q.level===p.level);
    const kind=['short_answer','single_choice','multiple_choice','true_false'][past.length%4];
    const pool=pools.get(`${skill}:${p.level}:${kind}`)||pools.get(`${skill}:${p.level}:short_answer`);
    const used=new Set(past.map(q=>q.bank_id));const unused=pool.filter(q=>!used.has(q.id));const choices=unused.length?unused:pool;
    const source=clone(choices[Math.floor(Math.random()*choices.length)]),bankId=source.id;
    source.id=uuid();
    const row={id:source.id,bank_id:bankId,user_id:user.id,run_id:run.id,skill_id:skill,level:p.level,private:source,
      status:'open',assisted:false,hint_count:0,active_ms:0,created_at:clock(),seq:++d.seq};
    d.questions.push(row);record(d,user,'question_assigned',{skill_id:skill,level:p.level,kind:source.kind,curriculum_version:curriculum.version},run,row.id);
    if(body.reason==='skill')record(d,user,'skill_selected',{skill_id:skill},run);
    return packagePractice(d,user,run,row);
  }
  function attempt(d,user,id,body){
    const prior=d.attempts.find(a=>a.client_id===body.client_id);
    if(prior){if(prior.user_id!==user.id||prior.question_id!==id)fail(409,'重複的作答識別碼。');return clone(prior.feedback);}
    const {row,run,q}=owned(d,user,id);if(row.status!=='open')fail(409,'這題已完成或已跳過。');
    const v=grade(q,body.answer);
    if(!v.valid){record(d,user,'answer_invalid',{message:v.message},run,id);return {valid:false,message:v.message};}
    const first=!d.attempts.some(a=>a.question_id===id),independent=first&&!row.assisted;
    const a={id:uuid(),client_id:body.client_id,question_id:id,user_id:user.id,mode:run.mode,skill_id:q.skill_id,level:q.level,
      template_id:q.template_id,kind:q.kind,answer_json:JSON.stringify(body.answer),explanation:String(body.explanation||'').slice(0,1000),
      correct:v.correct,first_attempt:first,independent,misconception:q.misconception,elapsed_ms:Math.max(0,Date.parse(clock())-Date.parse(row.created_at)),created_at:clock(),seq:++d.seq};
    d.attempts.push(a);const decision=decide(d,user,run,row,v,first,independent,a.explanation);
    const feedback={valid:true,correct:v.correct,independent,message:v.correct?(independent?'答對了，這是你自己的成果。':'答對了，再用一題確認能獨立完成。'):'還差一點，先檢查這個觀念。',
      hint:v.correct?null:skills[q.skill_id].hints[0],decision,provider:'rules',provider_status:'local_only',progress:progressList(d,user,run.mode)};
    a.feedback=clone(feedback);row.status=v.correct?'solved':'open';row.assisted||=!v.correct;
    record(d,user,'answer_submitted',{attempt_id:a.id,correct:v.correct,independent,first_attempt:first,misconception:q.misconception},run,id);
    record(d,user,'progression_decision',decision,run,id);return feedback;
  }
  function step(d,user,id,body){
    const {row,run,q}=owned(d,user,id);if(row.status!=='open')fail(409,'請在尚未完成的題目檢查步驟。');
    const v=checkStep(q,body.work),reply=!v.valid?v.message:v.correct?'你寫的這一步通過檢查。請自己接著完成，或把最終答案提交到左側。':'這一步還需要調整。'+skills[q.skill_id].hints[Math.min(row.hint_count,2)];
    d.steps.push({id:uuid(),question_id:id,user_id:user.id,mode:run.mode,work:body.work,verdict:!v.valid?'invalid':v.correct?'correct':'incorrect',reply,created_at:clock()});
    row.assisted||=v.valid;record(d,user,'step_checked',{valid:v.valid,correct:v.correct},run,id);
    return {...v,reply,assisted:row.assisted};
  }
  function chat(d,user,id,body,remote=null){
    const prior=d.chats.find(c=>c.client_id===body.client_id);
    if(prior){if(prior.user_id!==user.id||prior.question_id!==id)fail(409,'重複的訊息識別碼。');return {reply:prior.reply,card_id:prior.card_id,provider:prior.provider,provider_status:prior.provider_status||'local_only',assisted:prior.assisted};}
    const {row,run,q}=owned(d,user,id);if(row.status!=='open')fail(409,'這題已完成，請開始下一題再繼續。');
    const message=String(body.message||'').trim();if(!message||message.length>1000)fail(422,'請輸入 1000 字以內的問題。');
    const skill=skills[q.skill_id];let card='hint',reply;
    if(answerRequest.test(message))card='answer_boundary';
    else if(body.action==='concept'||/是什麼|意思|觀念|為什麼|公理|分配律|同類項/.test(message))card='concept';
    else if(body.action!=='hint'&&(/對嗎|檢查|算式|步驟/.test(message)||message.includes('=')))card='check_work';
    else if(/不會|好難|放棄|挫折/.test(message))card='encourage';
    if(card!=='answer_boundary'&&remote?.provider==='llm'&&['hint','concept','check_work','encourage','off_topic','answer_boundary'].includes(remote.card))card=remote.card;
    const provider=remote?.provider==='llm'?'llm':'rules',provider_status=remote?.provider_status||'local_only';
    if(card==='answer_boundary')reply=boundary;
    else if(card==='concept')reply=skill.concept+'\n\n你能指出這個觀念和目前哪個地方有關嗎？';
    else if(card==='off_topic')reply='我們先專注在這一題。你想確認題意、相關觀念，還是自己寫出的步驟？';
    else if(card==='encourage')reply='可以慢慢想。先寫下你確定的一小步，再檢查這一步的理由。需要時，也可以先練一題較簡單的同類題。';
    else if(card==='check_work'){
      const match=message.match(/(?:^|[：:\s])([xX0-9(（+−\-][xX0-9+−\-*/×÷().=＝（）\s]{1,200})(?:[？?。]|$)/);
      const v=match?checkStep(q,match[1]):null;
      reply=!v?'請把你自己寫出的算式放到左側的「我的解題步驟」，再點選檢查。':!v.valid?v.message:v.correct?'你寫的這一步通過檢查。請自己接著完成，或把最終答案提交到左側。':'這一步還需要調整。'+skill.hints[Math.min(row.hint_count,2)];
    }else reply=skill.hints[Math.min(row.hint_count,2)]+'\n\n先寫下一個你願意嘗試的想法，我們再檢查。';
    row.assisted||=card!=='answer_boundary';
    d.chats.push({id:uuid(),client_id:body.client_id,question_id:id,user_id:user.id,mode:run.mode,message,reply,card_id:card,provider,provider_status,assisted:row.assisted,created_at:clock(),skill_id:q.skill_id});
    record(d,user,'chat_sent',{action:body.action||'chat'},run,id);record(d,user,'chat_replied',{card_id:card,provider,provider_status},run,id);
    if(card==='hint'){record(d,user,'hint_requested',{hint_index:Math.min(row.hint_count,2)},run,id);row.hint_count++;}
    return {reply,provider,provider_status,card_id:card,assisted:row.assisted};
  }
  function events(d,user,body){
    const run=body.run_id?d.runs.find(r=>r.id===body.run_id&&r.user_id===user.id):null;
    if(body.run_id&&!run)fail(404,'找不到這次練習。');
    if(!Array.isArray(body.events)||body.events.length>40)fail(422,'事件批次格式不正確。');
    let accepted=0;
    for(const e of body.events){
      if(!CLIENT_EVENTS.has(e.kind)||!e.client_id||Object.keys(e.payload||{}).some(k=>!['length','input','option_ids','visible','focused','active_ms','page','destination'].includes(k)))fail(422,'事件欄位不受支援。');
      const row=e.question_id?d.questions.find(q=>q.id===e.question_id&&q.run_id===run?.id):null;
      if(e.question_id&&!row)fail(404,'題目不屬於這次練習。');
      if(d.events.some(x=>x.client_id===e.client_id))continue;
      if(e.kind==='heartbeat'&&(!Number.isInteger(e.payload.active_ms)||e.payload.active_ms<0||e.payload.active_ms>30000))fail(422,'時間格式不正確。');
      record(d,user,e.kind,e.payload,run,e.question_id,{client_id:e.client_id,client_at:e.client_at||null,source:'browser'});
      if(row&&e.kind==='heartbeat')row.active_ms+=e.payload.active_ms;
      accepted++;
    }return {accepted};
  }
  function dashboard(d,user,query){
    const mode=query.get('mode')||'student_operation',selected=query.get('student_id');
    const filter=row=>row.mode===mode&&(!selected||row.user_id===selected);
    const attempts=d.attempts.filter(filter),first=attempts.filter(a=>a.first_attempt);
    record(d,user,'dashboard_viewed',{filter_mode:mode,student_id:selected});
    return {mode,summary:{attempts:attempts.length,questions:first.length,first_correct:first.filter(a=>a.correct).length,
      independent_correct:first.filter(a=>a.correct&&a.independent).length,learners:new Set(attempts.map(a=>a.user_id)).size,
      active_ms:d.questions.filter(q=>filter({...q,mode:d.runs.find(r=>r.id===q.run_id).mode})).reduce((n,q)=>n+q.active_ms,0)},
      students:d.profiles.filter(u=>u.role==='student').map(clone),
      timeline:d.events.filter(e=>e.mode===mode&&(!selected||e.actor_id===selected)).slice(-80).reverse().map(e=>({...e,name:d.profiles.find(u=>u.id===e.actor_id)?.name||'本機檔案'})),
      skills:order.map(id=>({skill_id:id,attempts:attempts.filter(a=>a.skill_id===id).length,independent_correct:attempts.filter(a=>a.skill_id===id&&a.correct&&a.independent&&a.first_attempt).length})),
      progress:selected?progressList(d,{id:selected},mode):[],
      conversations:d.chats.filter(filter).slice(-30).reverse().map(c=>({...c,name:d.profiles.find(u=>u.id===c.user_id)?.name||'本機檔案'})),
      tutor:{configured:false,model:null},policy_version:'local-pilot-1'};
  }
  function exportData(d,user,query){
    const mode=query.get('mode')||'student_operation',selected=query.get('student_id'),format=query.get('format')||'json';
    const filter=row=>(mode==='all'||row.mode===mode)&&(!selected||row.user_id===selected);
    record(d,user,'data_exported',{filter_mode:mode,format,student_id:selected});
    const events=d.events.filter(e=>filter({...e,user_id:e.actor_id})).map(e=>({...e,name:d.profiles.find(u=>u.id===e.actor_id)?.name||''}));
    if(format==='csv'){
      const fields=['id','actor_id','name','actor_role','mode','session_id','run_id','question_id','kind','payload_json','client_at','received_at','source'];
      const cell=value=>{let s=String(value??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
      return {filename:`one-step-events-${mode}.csv`,type:'text/csv;charset=utf-8',content:'\ufeff'+[fields,...events.map(e=>fields.map(f=>e[f]))].map(row=>row.map(cell).join(',')).join('\r\n')};
    }
    const data={format:'one-step-local-v1',exported_at:clock(),export_id:uuid(),scope:'this-browser-only',filter_mode:mode,filter_student_id:selected,
      curriculum_version:curriculum.version,profiles:d.profiles.filter(u=>!selected||u.id===selected).map(({id,name,role})=>({id,name,role})),events,
      attempts:d.attempts.filter(filter),steps:d.steps.filter(filter),chats:d.chats.filter(filter),progress:d.progress.filter(filter),
      questions:d.questions.filter(q=>filter({...q,mode:d.runs.find(r=>r.id===q.run_id).mode})).map(q=>publicQuestion(q.private))};
    return {filename:`one-step-records-${mode}.json`,type:'application/json',content:JSON.stringify(data,null,2)};
  }
  return async function api(path,body){
    const url=new URL(path,'https://local.invalid');
    const chatMatch=url.pathname.match(/^\/api\/questions\/([^/]+)\/chat$/);let remote=null;
    if(chatMatch&&router){
      // The network wait must happen outside the IndexedDB transaction.
      const request=await store.transact(d=>{
        const user=current(d),{row}=owned(d,user,chatMatch[1]),message=String(body?.message||'').trim();
        if(row.status!=='open')fail(409,'這題已完成，請開始下一題再繼續。');
        if(!message||message.length>1000)fail(422,'請輸入 1000 字以內的問題。');
        if(d.chats.some(c=>c.client_id===body.client_id)||answerRequest.test(message)||/對嗎|檢查|算式|步驟|=/.test(message))return null;
        // Reserve assistance before waiting, so another tab cannot claim independent credit.
        row.assisted=true;
        return {request_id:body.client_id,bank_id:row.bank_id,message,action:body.action||'chat',local_profile_id:user.id,local_mode:modeFor(user)};
      });
      if(request){try{remote=await router(request);}catch{remote={provider_status:'provider_unavailable'};}}
    }
    return store.transact(d=>{

      if(url.pathname==='/api/bootstrap')return {curriculum:clone(curriculum),demo_available:false,tutor_configured:false,local_mode:true,local_profiles:d.profiles.filter(u=>u.active).map(clone),
        recording_notice:'作答、步驟、對話與操作紀錄只存在這個瀏覽器。請使用暱稱；老師試用與學生操作分開統計，可匯出保存。'};
      if(url.pathname==='/api/local/profiles'&&!body)return {profiles:d.profiles.filter(u=>u.active).map(clone)};
      if(url.pathname==='/api/local/profiles'&&body){const u=createProfile(d,body.name,body.role);return {profile:clone(u)};}
      if(url.pathname==='/api/local/select'){
        const u=d.profiles.find(x=>x.id===body.id&&x.active);if(!u)fail(404,'找不到這個本機檔案。');
        session.setItem(sessionKey,u.id);session.setItem(sessionIdKey,uuid());record(d,u,'login',{},null,null,{mode:modeFor(u)});return {user:clone(u),mode:modeFor(u)};
      }
      const user=current(d,url.pathname.startsWith('/api/teacher/'));
      if(url.pathname==='/api/me')return {user:clone(user),mode:modeFor(user),tutor_configured:false};
      if(url.pathname==='/api/local/export'){
        const query=new URLSearchParams({mode:modeFor(user),student_id:user.id,format:'json'});
        return exportData(d,user,query);
      }
      if(url.pathname==='/api/logout'){record(d,user,'logout',{},null,null,{mode:modeFor(user)});session.removeItem(sessionKey);session.removeItem(sessionIdKey);return {ok:true};}
      if(url.pathname==='/api/practice/start')return start(d,user,body||{});
      const match=url.pathname.match(/^\/api\/questions\/([^/]+)\/(attempt|step|chat)$/);
      if(match)return ({attempt,step,chat})[match[2]](d,user,match[1],body||{},remote);
      if(url.pathname==='/api/events')return events(d,user,body);
      if(url.pathname==='/api/teacher/dashboard')return dashboard(d,user,url.searchParams);
      if(url.pathname==='/api/teacher/export')return exportData(d,user,url.searchParams);
      if(url.pathname==='/api/teacher/students'&&body){const u=createProfile(d,body.name,'student');record(d,user,'student_created',{student_id:u.id});return {student:clone(u),code:null};}
      if(url.pathname==='/api/teacher/students')return {students:d.profiles.filter(u=>u.role==='student').map(clone)};
      const active=url.pathname.match(/^\/api\/teacher\/students\/([^/]+)\/active$/);
      if(active){const u=d.profiles.find(u=>u.id===active[1]&&u.role==='student');if(!u)fail(404,'找不到本機學生檔案。');u.active=!!body.active;record(d,user,'student_access_changed',{student_id:u.id,active:u.active});return {ok:true};}
      fail(404,'這個功能不在本機體驗版中。');
    });
  };
}

let browserAPI;
export async function api(path,body){
  if(!browserAPI)browserAPI=Promise.all(['curriculum.json','question-bank.json'].map(async file=>{
    const r=await fetch(new URL(file,import.meta.url));if(!r.ok)throw new Error('練習資料載入失敗，請重新整理。');return r.json();
  })).then(([curriculum,bank])=>makeAPI({store:indexedStore(),curriculum,bank,session:sessionStorage,router:input=>remoteTutor().route(input)}));
  return (await browserAPI)(path,body);
}
