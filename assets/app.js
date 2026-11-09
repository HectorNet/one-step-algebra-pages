const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const LOCAL_MODE = document.documentElement.dataset.mode === 'local';
const LOCAL_CHATGPT = document.documentElement.dataset.runtime === 'chatgpt';
let localModule;
let tutorConnection;
if(LOCAL_MODE)tutorConnection=(await import('./remote-tutor.mjs')).remoteTutor();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const math = value => esc(value).replace(/x/g, '<i>x</i>');
const icons = {
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  bulb:'<path d="M9 18h6m-5 3h4M8.5 14.5a6 6 0 1 1 7 0c-1 .7-1.5 1.6-1.5 2.5h-4c0-.9-.5-1.8-1.5-2.5Z"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  book:'<path d="M12 6C8 3 4 4 3 5v14c3-2 6-1 9 1 3-2 6-3 9-1V5c-1-1-5-2-9 1Zm0 0v14"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  send:'<path d="m4 11 16-7-7 16-2-7-7-2Zm7 2 9-9"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  chevron:'<path d="m8 10 4 4 4-4"/>',
  refresh:'<path d="M20 8a8 8 0 1 0 0 8m0-13v5h-5"/>',
  pencil:'<path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14l0 6Z"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.spark}</svg>`;
const kinds = {short_answer:'問答題',single_choice:'單選題',multiple_choice:'多選題',true_false:'是非題'};
const eventNames = {
  login:'登入練習空間',logout:'登出',practice_started:'開始練習',question_assigned:'收到新題目',question_viewed:'查看題目',
  answer_changed:'修改作答',explanation_changed:'修改作答理由',answer_submitted:'提交答案',answer_invalid:'作答格式待確認',
  step_checked:'檢查自己寫的步驟',chat_sent:'向助教提問',chat_replied:'收到輔導回覆',hint_requested:'請求提示',
  progression_decision:'產生下一步練習建議',question_skipped:'跳過題目',skill_selected:'切換練習能力',
  heartbeat:'有效練習時間',tab_visibility:'頁籤顯示狀態',window_focus:'視窗焦點變更',navigation:'切換頁面',
  paste_detected:'貼上內容',session_end:'離開頁面',help_panel_toggled:'展開解題步驟',review_started:'開始間隔複習',
  ai_connection_started:'開始 ChatGPT 授權',ai_connection_state:'變更 ChatGPT 連線狀態',
};
if(LOCAL_MODE)Object.assign(eventNames,{login:'選取本機檔案',logout:'離開本機檔案',student_created:'建立本機學生檔案',student_access_changed:'變更檔案狀態'});
const state = {boot:null,user:null,mode:null,practice:null,page:'practice',feedback:null,busy:false,
  drafts:{},dashboard:null,dashboardMode:'student_operation',selectedStudent:'',newCode:null,
  queue:[],syncing:false,syncError:false,activeMs:0,lastInteraction:performance.now(),lastTick:performance.now(),heartbeatMs:0};
let toastTimer, changeTimer;

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 4200);
}
async function api(path, body, options = {}) {
  if (LOCAL_MODE) {
    localModule ||= import('./local-engine.js');
    return (await localModule).api(path, body);
  }
  const response = await fetch(path, {credentials:'same-origin',headers:{'Content-Type':'application/json'},
    ...(body !== undefined ? {method:'POST',body:JSON.stringify(body)} : {}), ...options});
  if (!response.ok) {
    let detail; try { detail = (await response.json()).detail; } catch { detail = null; }
    const error = new Error(typeof detail === 'string' ? detail : response.status === 422 ? '輸入格式不正確，請再檢查。' : '連線暫時無法完成，請稍後再試。');
    error.status = response.status; throw error;
  }
  return response.json();
}
function skillInfo(id) {
  for (const c of state.boot.curriculum.chapters) {
    const s = c.skills.find(s => s.id === id); if (s) return {...s,chapter:c};
  }
}
function draft() {
  const id=state.practice?.question?.id;
  return state.drafts[id] ||= {answer:'',selected:[],explanation:'',work:'',chat:''};
}
function modeLabel() { return state.mode === 'teacher_trial' ? '老師試用' : state.mode === 'demo' ? '示範體驗' : '學生操作'; }
function currentProgress() { return state.practice?.progress?.find(p => p.skill_id === state.practice.question.skill_id); }
function brand() { return `<a class="brand" href="${LOCAL_MODE?'./':'/'}" aria-label="一步 One Step 首頁"><span class="brand-mark">一</span><span><strong>一步</strong><small>ONE STEP</small></span></a>`; }
function header() {
  return `<header class="topbar"><div class="topbar-left">${brand()}<span class="header-divider"></span><span class="header-caption">讓每一次思考，都向前一步。</span>
    ${state.user && state.user.role === 'teacher' && !state.user.is_demo ? `<nav class="tabbar" aria-label="老師功能"><button data-page="practice" class="${state.page==='practice'?'active':''}">練習空間</button><button data-page="dashboard" class="${state.page==='dashboard'?'active':''}">教學後台</button></nav>` : ''}</div>
    <div class="topbar-right">${state.user ? `<span class="pill ${state.mode!=='student_operation'?'trial':''}"><span class="dot"></span>${modeLabel()}</span><div class="row"><span class="avatar">${esc(state.user.name.slice(0,1))}</span><span class="user-name">${esc(state.user.name)}</span></div>${LOCAL_MODE?'<button id="tutor-settings" class="text-btn">AI 連線設定</button><button id="export-local" class="text-btn">匯出紀錄</button>':''}<button id="logout" class="text-btn">${LOCAL_MODE?'切換檔案':'登出'}</button>` : '<span class="pill neutral">七年級數學 · 課後練習</span>'}</div></header>`;
}
function renderLogin() {
  if (LOCAL_MODE) return renderLocalLogin();
  $('#app').innerHTML = `${header()}<main id="main" class="login-layout"><section class="login-hero"><span class="eyebrow">MATH, ONE STEP AT A TIME</span><h1>把不會的地方，<br>變成<em>下一步。</em></h1><p>從你自己的想法開始。<br>一次一個觀念，一步一步找到解題的方向。</p>
    <div class="hero-course"><span class="course-icon">x</span><div><strong>一元一次方程式</strong><p>3-1 式子的運算 ／ 3-2 解方程式 ／ 3-3 應用問題</p></div></div>
    <div class="math-decoration" aria-hidden="true"><span class="math-tile">x</span><span class="math-tile">＋</span><span class="math-tile">？</span><span class="math-tile">＝</span><span class="math-tile">！</span></div><div class="login-bottom">依翰林章節架構自行編寫 · 非出版社官方教材</div></section>
    <section class="login-card" aria-label="登入"><span class="eyebrow">YOUR PRACTICE SPACE</span><h2>準備好，想一想。</h2><p>使用老師提供的登入碼，<br>接續你的練習與學習紀錄。</p><form id="login-form"><label class="label" for="login-code">你的登入碼</label><input class="input" id="login-code" type="password" autocomplete="off" maxlength="256" required placeholder="輸入老師提供的登入碼"><p id="login-error" class="form-error" role="alert"></p><button class="primary" type="submit">進入練習空間 ${icon('arrow')}</button></form>
    ${state.boot.demo_available ? '<button id="demo-login" class="secondary demo-btn">先看看示範體驗</button>' : ''}
    <div class="recording">${icon('lock')}<span>${esc(state.boot.recording_notice)}</span></div><div class="login-note">老師與學生共用登入入口，權限由帳號決定。</div></section></main>`;
  $('#login-form').addEventListener('submit',async e=>{
    e.preventDefault(); const button=$('button',e.currentTarget); button.disabled=true;
    try { const data=await api('/api/login',{code:$('#login-code').value}); await signedIn(data); }
    catch(error){$('#login-error').textContent=error.message;button.disabled=false;}
  });
  $('#demo-login')?.addEventListener('click',async e=>{
    e.currentTarget.disabled=true;
    try { await signedIn(await api('/api/demo',{})); } catch(error){toast(error.message);renderLogin();}
  });
}
function renderLocalLogin() {
  const profiles=state.boot.local_profiles||[];
  $('#app').innerHTML=`${header()}<main id="main" class="login-layout"><section class="login-hero"><span class="eyebrow">GITHUB PAGES · LOCAL EDITION</span><h1>把不會的地方，<br>變成<em>下一步。</em></h1><p>從自己的想法開始，讓規則引導陪你確認每一步。<br>不用 API 金鑰，打開網頁就能練習。</p><div class="hero-course"><span class="course-icon">x</span><div><strong>一元一次方程式</strong><p>3-1 式子的運算 ／ 3-2 解方程式 ／ 3-3 應用問題</p></div></div><div class="math-decoration" aria-hidden="true"><span class="math-tile">x</span><span class="math-tile">＋</span><span class="math-tile">？</span><span class="math-tile">＝</span><span class="math-tile">！</span></div><div class="login-bottom">${LOCAL_CHATGPT?'ChatGPT 本機版 · 帳號由本人登入與授權':'GitHub Pages 體驗版 · 無雲端同步'}</div></section>
    <section class="login-card">${LOCAL_CHATGPT?'':'<div class="notice-banner">想連接自己的 ChatGPT？<a href="https://github.com/HectorNet/one-step-algebra-pages/blob/main/local/README.md" target="_blank" rel="noopener noreferrer">下載電腦本機版</a>。這裡可直接使用規則提示練習。</div>'}<span class="eyebrow">YOUR LOCAL PRACTICE SPACE</span><h2>選擇你的練習檔案。</h2><p>老師試用與學生操作分開累積。<br>使用暱稱即可，這裡不需要密碼。</p>
    ${profiles.length?`<form id="local-select-form" class="local-existing"><label class="label" for="local-profile">接續這個瀏覽器的檔案</label><select class="input" id="local-profile">${profiles.map(p=>`<option value="${p.id}">${esc(p.name)} · ${p.role==='teacher'?'老師試用':'學生操作'}</option>`).join('')}</select><button class="primary" type="submit">接續練習 ${icon('arrow')}</button></form>`:''}
    <form id="local-create-form"><label class="label" for="local-name">${profiles.length?'或建立新的本機檔案':'你的暱稱'}</label><input class="input" id="local-name" maxlength="40" placeholder="例如：小禾" autocomplete="off" required><label class="label local-role-label" for="local-role">紀錄模式</label><select class="input" id="local-role"><option value="student">學生操作</option><option value="teacher">老師試用</option></select><p id="local-error" class="form-error" role="alert"></p><button class="${profiles.length?'secondary':'primary'} local-create-button" type="submit">建立檔案並開始 ${icon('arrow')}</button></form>
    <div class="recording">${icon('book')}<span>資料只存在此瀏覽器，換裝置不會自動同步。模式用來分類紀錄，並非帳號權限保護；共用電腦上的使用者可切換檔案。</span></div></section></main>`;
  const select=async id=>signedIn(await api('/api/local/select',{id}));
  $('#local-select-form')?.addEventListener('submit',async e=>{e.preventDefault();const button=$('button',e.currentTarget);button.disabled=true;try{await select($('#local-profile').value);}catch(error){$('#local-error').textContent=error.message;button.disabled=false;}});
  $('#local-create-form').addEventListener('submit',async e=>{e.preventDefault();const button=$('button',e.currentTarget);button.disabled=true;try{const result=await api('/api/local/profiles',{name:$('#local-name').value,role:$('#local-role').value});await select(result.profile.id);}catch(error){$('#local-error').textContent=error.message;button.disabled=false;}});
}
async function signedIn(data) {
  state.user=data.user;state.mode=data.mode;state.page='practice';state.practice=null;state.feedback=null;state.newCode=null;
  if(LOCAL_CHATGPT)await tutorConnection.setContext(state.user.id,state.mode);
  try { state.queue=JSON.parse(localStorage.getItem(`onestep:${LOCAL_MODE?'local:':''}events:${state.user.id}`)||'[]'); }
  catch { state.queue=[]; }
  state.queue=state.queue.filter(x=>Date.now()-x.stored_at<86400000);
  await loadPractice(); flushEvents();
}
function sidebar() {
  const current=state.practice.question.skill_id;
  return `<aside class="sidebar" aria-label="練習章節"><span class="side-title">YOUR LEARNING PATH</span><h2>一元一次方程式</h2><p class="sidebar-sub">七年級上學期 · 第三章</p>
    ${state.boot.curriculum.chapters.map(c=>`<section class="chapter"><div class="chapter-heading"><span><span class="chapter-num">${c.id}</span>${esc(c.title)}</span>${icon('chevron')}</div>${c.skills.map(s=>{
      const p=state.practice.progress.find(p=>p.skill_id===s.id);
      return `<button class="skill-btn ${current===s.id?'active':''} ${p?.status==='mastered'?'mastered':''}" data-skill="${s.id}" ${current===s.id?'aria-current="step"':''}><span class="skill-dot"></span>${esc(s.title)}${p?.status==='mastered'?'<span class="skill-check">✓</span>':''}</button>`;
    }).join('')}</section>`).join('')}
    <div class="sidebar-foot"><strong>每個人，都有自己的步調。</strong>慢慢想也沒關係。<br>重點是你能自己說清楚。</div></aside>`;
}
function answerArea(q, completed) {
  const d=draft();
  if(q.kind==='short_answer') return `<label class="label" for="answer-input">你的答案</label><input class="input answer-input" id="answer-input" name="answer" value="${esc(d.answer)}" maxlength="240" autocomplete="off" spellcheck="false" placeholder="輸入數值、一次式或方程式" ${completed?'disabled':''}>
    <div class="math-keys" aria-label="數學輸入工具">${['x','(',')','−','/','='].map(key=>`<button type="button" data-key="${key}" aria-label="插入 ${key}" ${completed?'disabled':''}>${key}</button>`).join('')}<small>分數可用 / 輸入</small></div>`;
  return `<fieldset class="option-list" aria-label="你的答案">${q.options.map((o,i)=>`<label class="option"><input type="${q.kind==='multiple_choice'?'checkbox':'radio'}" name="option" value="${o.id}" ${d.selected.includes(o.id)?'checked':''} ${completed?'disabled':''}><span class="option-letter">${String.fromCharCode(65+i)}</span><span class="option-math">${math(o.text)}</span></label>`).join('')}</fieldset>`;
}
function feedbackHTML() {
  const feedback=state.feedback;
  if(!feedback) return '';
  if(!feedback.valid) return `<div class="feedback wrong" role="status"><strong>${esc(feedback.message)}</strong><p>修正輸入格式後再送出，不會計為答錯。</p></div>`;
  return `<div class="feedback ${feedback.correct?'':'wrong'}" role="status"><strong>${icon(feedback.correct?'check':'bulb')}${esc(feedback.message)}</strong><p>${esc(feedback.correct?feedback.decision.reason:feedback.hint)}</p>
    ${feedback.correct?`<button type="button" class="primary" id="next-question">${feedback.decision.action==='next_skill'&&feedback.decision.next_skill_id!==state.practice.question.skill_id?'前往下一個能力':'繼續下一題'} ${icon('arrow')}</button>${feedback.decision.action==='next_skill'?'<button type="button" class="secondary" id="stay-skill">留在本能力練習</button>':''}`:''}</div>`;
}
function questionHTML() {
  const q=state.practice.question, d=draft(), completed=state.practice.question_status==='solved';
  return `<article class="question-card"><div class="question-top"><div class="question-label"><b>練習 ${String(state.practice.question_number).padStart(2,'0')}</b><span class="kind-tag">${kinds[q.kind]}</span></div><div class="level-indicator" aria-label="難度 ${q.level}，共三級">${[1,2,3].map(n=>`<span class="${n<=q.level?'on':''}"></span>`).join('')}<b>${['','基礎','進階','挑戰'][q.level]}</b></div></div>
    <div class="question-body">${q.context?`<p class="question-context">${esc(q.context)}</p>`:''}<h2 class="question-prompt">${esc(q.prompt)}</h2>${q.math?`<div class="question-math" aria-label="算式 ${esc(q.math)}">${math(q.math)}</div>`:''}${q.statement?`<p class="statement">${math(q.statement)}</p>`:''}<p class="question-instruction">${esc(q.instruction)}</p>
    <form id="answer-form" class="answer-section">${answerArea(q,completed)}<div class="explanation-wrap"><label for="explanation">也說說你的想法 <small>（選填）</small></label><textarea class="input" id="explanation" rows="2" maxlength="1000" placeholder="我會這樣想，因為……" ${completed?'disabled':''}>${esc(d.explanation)}</textarea></div>
    ${!completed?`<div class="submit-row"><button type="button" class="soft-link" id="skip-question">${icon('refresh')}先換一題</button><button type="submit" class="primary request-btn">${state.feedback?.valid?'再試一次':'確認我的答案'} ${icon('arrow')}</button></div>`:''}</form>
    ${feedbackHTML()}<details class="steps-block" id="steps-details"><summary>${icon('pencil')}我的解題步驟</summary><div class="step-history">${state.practice.steps.map(s=>`<div class="step-line ${s.verdict==='correct'?'':'incorrect'}">${math(s.work)} <small>${s.verdict==='correct'?'✓ 已檢查':'待確認'}</small></div>`).join('')}</div><label class="label" for="work-input">寫下一步你自己想到的算式</label><textarea class="input" id="work-input" maxlength="240" rows="2" placeholder="可以寫出和原題等價的式子或方程式" ${completed?'disabled':''}>${esc(d.work)}</textarea><button type="button" class="secondary request-btn" id="check-step" ${completed?'disabled':''}>${icon('check')}請助教檢查這一步</button></details></div>
    <footer class="question-bottom"><span>${icon('clock')}<span id="active-time">${formatDuration(state.activeMs)}</span> 有效練習</span><span>${state.practice.assisted?'已接受輔導 · 下一題再確認獨立作答':'目前尚未使用提示'}</span></footer></article>`;
}
function planHTML() {
  const p=currentProgress();
  const decision=state.feedback?.decision;
  const count=decision?.independent_correct ?? 0;
  return `<section class="next-plan"><h3 class="next-plan-title">${icon('spark')}目前的練習方向</h3><p>${esc(decision?.reason||'先試著自己完成。系統會參考獨立作答、錯誤與提示使用情況，安排下一步。')}</p><div class="plan-progress"><progress value="${Math.min(count,3)}" max="3" aria-label="本級獨立答對證據"></progress><small>${p?.status==='mastered'?'當次確認完成':`${Math.min(count,3)} / 3 次獨立答對`}</small></div></section>
    <p class="study-note">${icon('bulb')}答得慢也沒關係。遇到困難時，我們會先拆小問題，再回來挑戰。</p>`;
}
function chatMessages() {
  const chats=state.practice.chats.flatMap(c=>[{role:'user',text:c.message,time:c.created_at},{role:'tutor',text:c.reply,time:c.created_at}]);
  const steps=state.practice.steps.flatMap(s=>[{role:'user',text:`檢查我的步驟：${s.work}`,time:s.created_at},{role:'tutor',text:s.reply||(s.verdict==='correct'?'你寫的這一步通過檢查。請自己接著完成。':'這一步還需要確認，可以先檢查相關觀念。'),time:s.created_at}]);
  return [...chats,...steps].sort((a,b)=>a.time.localeCompare(b.time));
}
function tutorHTML() {
  const d=draft(), completed=state.practice.question_status==='solved';
  return `<aside class="tutor-panel" aria-label="互動輔導助教"><header class="tutor-header"><div class="tutor-identity"><span class="tutor-avatar">${icon('spark')}</span><div><h2>一起想，別急。</h2><p>你的數學輔導助教</p></div></div><span class="pill"><span class="dot"></span>${LOCAL_MODE?(state.tutorProvider==='llm'?(LOCAL_CHATGPT?'ChatGPT 輔導':'AI 輔導'):tutorConnection.settings().hasCode?(LOCAL_CHATGPT?'ChatGPT 已授權':'AI 連線已設定'):'規則輔導'):state.boot.tutor_configured?'AI 已設定':'規則輔導'}</span></header>
    <div class="chat-area" id="chat-area" role="log" aria-live="polite" aria-label="輔導對話"><div class="chat-date">每一步，都由你自己完成</div><div class="message"><span class="mini-avatar">${icon('spark')}</span><div class="bubble"><span class="message-name">一步助教</span>嗨，準備好一起想一想了嗎？\n\n你可以問我觀念、請我給提示，或讓我檢查你自己寫出的算式。先從你知道的地方開始就好。</div></div>
      ${chatMessages().map(m=>`<div class="message ${m.role==='user'?'user':''}"><span class="mini-avatar">${icon('spark')}</span><div class="bubble">${esc(m.text)}</div></div>`).join('')}</div>
    <div class="quick-prompts"><button class="request-btn" id="hint-button" ${completed?'disabled':''}>${icon('bulb')}給我一點提示</button><button class="request-btn" id="concept-button" ${completed?'disabled':''}>${icon('book')}解釋這個觀念</button></div>
    <form class="chat-compose" id="chat-form"><div class="chat-input-row"><label class="hidden" for="chat-input">向助教提問</label><textarea id="chat-input" rows="2" maxlength="1000" placeholder="${completed?'做得很好，開始下一題再繼續聊。':'我想問……'}" ${completed?'disabled':''}>${esc(d.chat)}</textarea><button class="send-btn request-btn" id="send-message" type="submit" aria-label="送出問題" ${completed?'disabled':''}>${icon('send')}</button></div><div class="chat-compose-footer"><span>${icon('lock')}不代寫這題的解法與答案</span><span>Ctrl + Enter 送出</span></div></form>
    <div class="tutor-limit">${LOCAL_MODE?(LOCAL_CHATGPT?(tutorConnection.settings().hasCode?'使用自己的 ChatGPT 方案 · 模型只選提示卡，不顯示自由生成的文字。':'本機 ChatGPT 版 · 請在「AI 連線設定」登入並自行授權。'):(tutorConnection.settings().hasCode?'已設定 AI 連線 · AI 判讀提問，回覆使用受控提示。':'目前使用規則提示 · 可在「AI 連線設定」查看 ChatGPT 本機版。')):state.boot.tutor_configured?'AI 協助選擇教學引導，回覆經受控提示規則處理。':'目前使用預先設計的引導；老師設定模型後可啟用 AI 判讀。'}</div></aside>`;
}
function renderPractice() {
  if(!state.practice?.question) return;
  const info=skillInfo(state.practice.question.skill_id);
  $('#app').innerHTML=`${header()}<div class="app-shell">${sidebar()}<main id="main" class="workspace"><div class="workspace-heading"><div><div class="breadcrumb"><span>七年級數學</span><span>／</span><span>${info.chapter.id} ${esc(info.chapter.title)}</span></div><h1>${esc(info.title)}</h1></div><div class="session-info"><strong>專注現在這一小步。</strong><br><span id="sync-indicator" class="sync-indicator">${state.queue.length?'操作紀錄待同步':'操作紀錄已同步'}</span></div></div>
    ${state.mode==='demo'?'<div class="notice-banner">這是示範體驗，紀錄不會列入學生學習統計。正式試用請以老師建立的登入碼登入。</div>':''}
    ${LOCAL_MODE?`<div class="notice-banner">本機體驗版 · ${modeLabel()} · 進度與操作紀錄保存在這個瀏覽器，可從老師檔案匯出。右側提供受控輔導。</div>`:state.mode==='teacher_trial'?'<div class="notice-banner">你正在老師試用模式。這裡的作答會獨立記錄，學生統計會排除這些操作。</div>':''}
    <div class="workspace-columns"><section class="practice-column" aria-label="題目與作答">${questionHTML()}${planHTML()}</section>${tutorHTML()}</div></main></div>`;
  bindHeader();bindPractice();updateSync();
  const chat=$('#chat-area');chat.scrollTop=chat.scrollHeight;
}
function bindHeader() {
  $('#tutor-settings')?.addEventListener('click',showTutorSettings);
  $('#export-local')?.addEventListener('click',()=>runAction(async()=>{heartbeatRemainder();await flushEvents();downloadLocal(await api('/api/local/export'));}));
  $('#logout')?.addEventListener('click',()=>runAction(async()=>{
    heartbeatRemainder();await flushEvents();await api('/api/logout',{});state.user=null;state.practice=null;state.mode=null;state.queue=[];state.drafts={};
    if(LOCAL_MODE){await tutorConnection.disconnect();state.tutorProvider=null;}
    if(LOCAL_MODE)state.boot.local_profiles=(await api('/api/local/profiles')).profiles;
    renderLogin();
  }));
  $$('[data-page]').forEach(button=>button.addEventListener('click',()=>changePage(button.dataset.page)));
}
function showTutorSettings(){
  if(LOCAL_CHATGPT)return showChatGPTSettings();
  const info=tutorConnection.settings(),dialog=document.createElement('dialog');dialog.className='tutor-settings-dialog';
  dialog.innerHTML=`<form id="tutor-connect-form"><h2>連接 AI 輔導</h2><p>想用自己的 ChatGPT 方案？<a href="https://github.com/HectorNet/one-step-algebra-pages/blob/main/local/README.md" target="_blank" rel="noopener noreferrer">開啟電腦本機版使用說明</a>，下載後執行 npm start，再於本機版登入。GitHub Pages 的規則提示仍可繼續使用。</p><p>以下是另外部署的輔導服務設定。OpenAI 金鑰由後端保管，本頁不接受 API Key。</p><label class="label" for="tutor-endpoint">輔導服務網址</label><input class="input" id="tutor-endpoint" type="url" required value="${esc(info.endpoint)}" placeholder="https://老師提供的服務網址"><label class="label local-role-label" for="tutor-code">試用通行碼</label><input class="input" id="tutor-code" type="password" required autocomplete="off" placeholder="由老師提供，不是 API Key"><p class="recording">連線後，題目和你送出的提問會交由輔導服務判讀。暱稱、完整操作紀錄與其他學生資料不會一併傳送。通行碼只保留於這個頁籤。</p><p id="tutor-connect-error" class="form-error" role="alert"></p><div class="row"><button class="primary" type="submit">確認並連接</button><button class="secondary" type="button" id="tutor-disconnect">使用規則提示</button><button class="text-btn" type="button" id="tutor-close">關閉</button></div></form>`;
  document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
  $('#tutor-close',dialog).onclick=()=>dialog.close();
  $('#tutor-disconnect',dialog).onclick=async()=>{await tutorConnection.disconnect();state.tutorProvider='rules';dialog.close();renderPractice();toast('已切換為本機規則提示。');};
  $('#tutor-connect-form',dialog).onsubmit=async e=>{e.preventDefault();const b=$('button[type="submit"]',dialog);b.disabled=true;
    try{await tutorConnection.configure($('#tutor-endpoint',dialog).value,$('#tutor-code',dialog).value);state.tutorProvider=null;dialog.close();renderPractice();toast('AI 連線已設定；下一次提問時會嘗試模型判讀。');}
    catch(error){$('#tutor-connect-error',dialog).textContent=error.message;b.disabled=false;}
  };
}
async function showChatGPTSettings(){
  const {localStatusMessage,localDiagnosticText}=await import('./local-chatgpt.mjs');
  const dialog=document.createElement('dialog');dialog.className='tutor-settings-dialog chatgpt-settings';
  dialog.innerHTML=`<h2>用自己的 ChatGPT，陪你想。</h2><p>本機版透過 OpenAI 官方頁面登入，使用目前登入者自行授權的 ChatGPT 方案。這不是額外贈送的額度。</p><p class="recording">題目與你送出的提問會交由 OpenAI 判讀。模型只能選擇受控提示；完整學習紀錄與其他學生資料不會一併傳送。</p><div id="chatgpt-account-state" aria-live="polite"></div><p id="chatgpt-settings-error" class="form-error" role="alert"></p><div class="row"><button class="primary" id="chatgpt-add-account">Continue with ChatGPT</button><button class="secondary" id="chatgpt-refresh">重新整理狀態</button></div><p><a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noopener noreferrer">管理 ChatGPT 使用量與授權</a></p><p class="recording">每位學生需使用自己的合資格帳號。切換學習檔案會停止原連線，不會接續使用老師的方案。若帳號不支援，仍可使用規則提示。</p><div class="row"><button class="secondary" id="chatgpt-pause">暫停 AI，使用規則提示</button><button class="text-btn" id="chatgpt-close">關閉</button></div>`;
  document.body.append(dialog);dialog.showModal();
  let last='',polling=false;
  function paint(info){
    const current=JSON.stringify(info);if(current===last)return;last=current;
    $('#chatgpt-account-state',dialog).innerHTML=`<div class="notice-banner"><strong>${info.verified?'ChatGPT 已實測可用':info.ready?'已授權，等待第一次實測':'尚未啟用 AI'}</strong><p>${esc(localStatusMessage(info.status))}</p>${info.plan_authorized?'<p>已取得 ChatGPT 方案使用授權；模型存取仍須驗證。</p>':''}${info.email?`<p>目前選擇的帳號：${esc(info.email)}</p>`:''}${info.diagnostic?`<p class="chatgpt-diagnostic">${esc(localDiagnosticText(info))}</p>`:''}</div>${info.connections.length?`<ul class="chatgpt-connections">${info.connections.map(c=>`<li><div><strong>${esc(c.email)}</strong><small>連線 ${esc(c.label)} · ${c.id===info.active?'目前選擇':c.signed_in?(c.sharing?'已儲存方案授權':'已儲存登入'):'需要登入'}</small></div><button class="secondary" data-chatgpt-connect="${esc(c.id)}">${c.signed_in&&c.sharing?'重新取得模型':'登入與授權'}</button><button class="text-btn" data-chatgpt-signout="${esc(c.id)}">登出並清除授權</button></li>`).join('')}</ul>`:''}${info.models.length?`<label class="label" for="chatgpt-model">目前帳號可用的模型</label><select class="input" id="chatgpt-model">${info.models.map(m=>`<option value="${esc(m.slug)}" ${m.slug===info.model?'selected':''}>${esc(m.display_name)}</option>`).join('')}</select><p class="recording">模型清單不等於已驗證可用；收到完整模型回覆後才會確認成功。</p>`:''}<p class="recording">本機程式版本：${esc(info.runtime_version||'未提供')}。${info.connections.length?'已有連線時，可先按「重新取得模型」，沿用原授權。':''}</p>`;
    $('#chatgpt-add-account',dialog).textContent=info.connections.length?'新增其他 ChatGPT 帳號':'Continue with ChatGPT';
    $$('[data-chatgpt-connect]',dialog).forEach(b=>b.onclick=()=>{
      const c=info.connections.find(c=>c.id===b.dataset.chatgptConnect);
      if(c?.signed_in&&c.sharing)return act(()=>tutorConnection.resume(c.id));
      return connect(b.dataset.chatgptConnect);
    });
    $$('[data-chatgpt-signout]',dialog).forEach(b=>b.onclick=()=>act(async()=>{
      const result=await tutorConnection.signOut(b.dataset.chatgptSignout);
      if(!result.revoked)$('#chatgpt-settings-error',dialog).textContent='本機憑證已清除，但未能確認遠端撤銷。請至 ChatGPT 設定中中斷此應用程式的授權。';
    }));
    $('#chatgpt-model',dialog)?.addEventListener('change',e=>act(()=>tutorConnection.selectModel(e.target.value)));
    track('ai_connection_state',{destination:info.status,visible:info.ready});
  }
  async function act(operation){
    $$('button',dialog).forEach(b=>b.disabled=true);$('#chatgpt-settings-error',dialog).textContent='';
    try{await operation();paint(await tutorConnection.refresh());}
    catch(error){paint(tutorConnection.settings());$('#chatgpt-settings-error',dialog).textContent=error.message||'暫時無法連線。';}
    finally{$$('button',dialog).forEach(b=>b.disabled=false);}
  }
  async function connect(id){
    const popup=window.open('about:blank','_blank');if(popup)popup.opener=null;
    await act(async()=>{
      try{
        track('ai_connection_started',{destination:'chatgpt_plan'});
        const target=await tutorConnection.start(id);
        if(popup)popup.location.href=target;else window.location.assign(target);
      }catch(error){popup?.close();throw error;}
    });
  }
  $('#chatgpt-add-account',dialog).onclick=()=>connect();
  $('#chatgpt-refresh',dialog).onclick=()=>act(()=>tutorConnection.models());
  $('#chatgpt-close',dialog).onclick=()=>dialog.close();
  $('#chatgpt-pause',dialog).onclick=()=>act(async()=>{await tutorConnection.disconnect();await tutorConnection.setContext(state.user.id,state.mode);});
  const poll=setInterval(async()=>{if(polling||!dialog.isConnected)return;polling=true;try{paint(await tutorConnection.refresh());}finally{polling=false;}},2000);
  dialog.addEventListener('close',()=>{clearInterval(poll);dialog.remove();state.tutorProvider=tutorConnection.settings().verified?'llm':null;if(state.page==='dashboard')renderDashboard();else renderPractice();},{once:true});
  paint(await tutorConnection.refresh());
}
function downloadLocal(result){
  const url=URL.createObjectURL(new Blob([result.content],{type:result.type}));
  const a=document.createElement('a');a.href=url;a.download=result.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);
  toast('紀錄已匯出，請保存下載的檔案。');
}
async function changePage(page) {
  if(state.busy||state.page===page)return;
  heartbeatRemainder();
  track('navigation',{destination:page});flushEvents();state.page=page;
  if(page==='dashboard') await runAction(loadDashboard); else renderPractice();
}
function bindPractice() {
  $$('[data-skill]').forEach(button=>button.addEventListener('click',()=>{
    if(button.dataset.skill===state.practice.question.skill_id)return;
    runAction(()=>loadPractice(button.dataset.skill,'skill'));
  }));
  $('#answer-form').addEventListener('submit',event=>{
    event.preventDefault();runAction(submitAnswer);
  });
  $('#answer-input')?.addEventListener('input',e=>{draft().answer=e.target.value;scheduleChange('answer_changed',{length:e.target.value.length,input:'answer'});});
  $$('input[name="option"]').forEach(input=>input.addEventListener('change',()=>{
    draft().selected=$$('input[name="option"]:checked').map(input=>input.value);
    track('answer_changed',{option_ids:draft().selected,input:'option'});
  }));
  $('#explanation').addEventListener('input',e=>{draft().explanation=e.target.value;scheduleChange('explanation_changed',{length:e.target.value.length,input:'explanation'});});
  $('#work-input').addEventListener('input',e=>{draft().work=e.target.value;scheduleChange('answer_changed',{length:e.target.value.length,input:'work'});});
  $('#chat-input').addEventListener('input',e=>{draft().chat=e.target.value;});
  $$('[data-key]').forEach(button=>button.addEventListener('click',()=>{
    const input=$('#answer-input');if(!input)return;
    input.focus();input.setRangeText(button.dataset.key,input.selectionStart,input.selectionEnd,'end');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  }));
  $('#skip-question')?.addEventListener('click',()=>runAction(()=>loadPractice(null,'skip')));
  $('#next-question')?.addEventListener('click',()=>runAction(()=>loadPractice(state.feedback.decision.next_skill_id,'next')));
  $('#stay-skill')?.addEventListener('click',()=>runAction(()=>loadPractice(state.practice.question.skill_id,'next')));
  $('#hint-button').addEventListener('click',()=>runAction(()=>sendChat('給我一點提示','hint')));
  $('#concept-button').addEventListener('click',()=>runAction(()=>sendChat('請解釋這個觀念','concept')));
  $('#chat-form').addEventListener('submit',e=>{e.preventDefault();runAction(()=>sendChat(draft().chat));});
  $('#chat-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#chat-form').requestSubmit();}});
  $('#check-step').addEventListener('click',()=>runAction(checkStep));
  $('#steps-details').addEventListener('toggle',e=>{if(e.currentTarget.open)track('help_panel_toggled',{visible:true});});
  $$('input,textarea').forEach(input=>input.addEventListener('paste',()=>track('paste_detected',{input:input.id||input.name})));
}
function setBusy(value) {
  state.busy=value;
  $$('.request-btn,[data-skill],[data-page],#skip-question,#next-question,#stay-skill,#logout').forEach(button=>{
    button.disabled=value || (!!state.practice && state.practice.question_status==='solved' && ['hint-button','concept-button','check-step','send-message'].includes(button.id));
  });
}
async function runAction(action) {
  if(state.busy)return;
  setBusy(true);
  try{await action();}catch(error){
    toast(error.message||'連線暫時中斷，輸入內容會保留在畫面中。');
    if(error.status===401){state.user=null;state.practice=null;renderLogin();}
    else if(error.status===409){await loadPractice();}
  }finally{setBusy(false);}
}
async function loadPractice(skillId=null,reason='start') {
  const previous=state.practice?.question?.id;
  heartbeatRemainder();
  await flushEvents();
  const result=await api('/api/practice/start',{skill_id:skillId,previous_question_id:previous||null,reason});
  state.practice=result;state.page='practice';state.activeMs=result.active_ms||0;state.heartbeatMs=0;state.lastTick=performance.now();
  const attempts=result.attempts;
  if(attempts.length){const last=attempts[attempts.length-1];state.feedback=last.feedback;
    const d=draft();if(Array.isArray(last.answer))d.selected=last.answer;else if(result.question.kind==='short_answer')d.answer=last.answer;else d.selected=[last.answer];d.explanation=last.explanation;
  }else state.feedback=null;
  renderPractice();track('question_viewed',{page:'practice'});flushEvents();
}
async function submitAnswer() {
  const q=state.practice.question,d=draft();
  const answer=q.kind==='short_answer'?d.answer:q.kind==='multiple_choice'?d.selected:d.selected[0]||'';
  if(!answer || Array.isArray(answer)&&!answer.length){toast('先寫下答案或選擇選項，再送出。');return;}
  heartbeatRemainder();flushEvents();
  const result=await api(`/api/questions/${q.id}/attempt`,{client_id:crypto.randomUUID(),answer,explanation:d.explanation});
  state.feedback=result;
  if(result.valid){
    state.practice.progress=result.progress;
    state.practice.question_status=result.correct?'solved':'open';
    if(!result.correct)state.practice.assisted=true;
    state.practice.attempts.push({answer,explanation:d.explanation,correct:result.correct,feedback:result});
  }
  renderPractice();if(result.valid)toast(result.correct?'這一步完成了。':'先檢查一個觀念，再試一次。');
}
async function sendChat(message,action='chat') {
  message=message.trim();if(!message){toast('寫下你想問的問題。');return;}
  const q=state.practice.question;
  const result=await api(`/api/questions/${q.id}/chat`,{client_id:crypto.randomUUID(),message,action});
  state.practice.chats.push({message,reply:result.reply,provider:result.provider,created_at:new Date().toISOString()});
  state.practice.assisted=result.assisted;state.tutorProvider=result.provider;draft().chat='';renderPractice();
  if(result.provider_status==='request_limit')toast('AI 試用額度暫時用完，這次使用規則提示。');
  if(result.provider_status==='provider_unavailable')toast('AI 連線暫時無法使用，這次使用受控提示協助你。');
}
async function checkStep() {
  const work=draft().work.trim();if(!work){toast('先寫下你自己想到的一步。');return;}
  const result=await api(`/api/questions/${state.practice.question.id}/step`,{work});
  state.practice.steps.push({work,reply:result.reply,verdict:result.correct?'correct':result.valid?'incorrect':'invalid',created_at:new Date().toISOString()});
  state.practice.assisted=result.assisted;draft().work='';renderPractice();$('#steps-details').open=true;
}
function formatDuration(ms) {
  const sec=Math.floor(ms/1000);return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
}
function storeQueue() {
  if(!state.user)return;
  try{localStorage.setItem(`onestep:${LOCAL_MODE?'local:':''}events:${state.user.id}`,JSON.stringify(state.queue));}catch{state.syncError=true;}
}
function track(kind,payload={}) {
  if(!state.user)return;
  if(state.queue.length>=5000){state.syncError=true;toast('操作紀錄尚未同步，請先確認網路連線。');return;}
  state.queue.push({stored_at:Date.now(),run_id:state.practice?.run.id||null,event:{client_id:crypto.randomUUID(),kind,
    question_id:state.page==='practice'?state.practice?.question?.id||null:null,client_at:new Date().toISOString(),payload}});
  storeQueue();updateSync();
}
function scheduleChange(kind,payload) {
  clearTimeout(changeTimer);const question=state.practice?.question.id;
  changeTimer=setTimeout(()=>{if(question===state.practice?.question.id)track(kind,payload);},700);
}
function updateSync() {
  const indicator=$('#sync-indicator');if(!indicator)return;
  indicator.textContent=state.syncError?(LOCAL_MODE?'本機儲存待確認':'連線中斷，紀錄待同步'):state.queue.length?(LOCAL_MODE?'正在保存操作紀錄':'操作紀錄同步中'):(LOCAL_MODE?'紀錄已存本機':'操作紀錄已同步');
  indicator.classList.toggle('pending',state.syncError||!!state.queue.length);
}
async function flushEvents(keepalive=false) {
  if(state.syncing||!state.user||!state.queue.length)return;
  state.syncing=true;
  try{
    while(state.queue.length){
      const runId=state.queue[0].run_id;
      const batch=state.queue.filter(x=>x.run_id===runId).slice(0,40);
      await api('/api/events',{run_id:runId,events:batch.map(x=>x.event)},{keepalive});
      const sent=new Set(batch.map(x=>x.event.client_id));state.queue=state.queue.filter(x=>!sent.has(x.event.client_id));
      state.syncError=false;storeQueue();if(keepalive)break;
    }
  }catch{state.syncError=true;}finally{state.syncing=false;updateSync();}
}
function updateActiveTime() {
  const current=performance.now(),elapsed=Math.min(2000,current-state.lastTick);state.lastTick=current;
  if(!state.user||!state.practice||state.page!=='practice'||state.practice.question_status!=='open')return;
  if(document.visibilityState==='visible'&&document.hasFocus()&&current-state.lastInteraction<60000){
    state.activeMs+=elapsed;state.heartbeatMs+=elapsed;
    const target=$('#active-time');if(target)target.textContent=formatDuration(state.activeMs);
  }
  if(state.heartbeatMs>=15000){track('heartbeat',{active_ms:Math.min(30000,Math.round(state.heartbeatMs))});state.heartbeatMs=0;flushEvents();}
}
function heartbeatRemainder(){if(state.heartbeatMs>0){track('heartbeat',{active_ms:Math.min(30000,Math.round(state.heartbeatMs))});state.heartbeatMs=0;}}

async function loadDashboard() {
  const query=new URLSearchParams({mode:state.dashboardMode});if(state.selectedStudent)query.set('student_id',state.selectedStudent);
  state.dashboard=await api(`/api/teacher/dashboard?${query}`);state.page='dashboard';renderDashboard();
}
function renderDashboard() {
  const data=state.dashboard,s=data.summary;
  const percent=s.questions?Math.round(s.first_correct/s.questions*100):0;
  const exportMode=state.dashboardMode;
  const studentQuery=state.selectedStudent?`&student_id=${encodeURIComponent(state.selectedStudent)}`:'';
  $('#app').innerHTML=`${header()}<main id="main" class="dashboard"><div class="dashboard-title"><div><span class="eyebrow">TEACHER'S DESK</span><h1>看見思考的過程。</h1><p>從作答、提示與對話，找到下一次教學的起點。</p></div><div class="dashboard-controls"><label class="hidden" for="mode-filter">紀錄模式</label><select id="mode-filter"><option value="student_operation" ${exportMode==='student_operation'?'selected':''}>學生操作</option><option value="teacher_trial" ${exportMode==='teacher_trial'?'selected':''}>老師試用</option><option value="demo" ${exportMode==='demo'?'selected':''}>示範體驗</option></select><label class="hidden" for="student-filter">學生篩選</label><select id="student-filter"><option value="">全部使用者</option>${data.students.map(st=>`<option value="${st.id}" ${state.selectedStudent===st.id?'selected':''}>${esc(st.name)}</option>`).join('')}</select><button id="refresh-dashboard" class="text-btn" aria-label="重新整理統計">${icon('refresh')}</button></div></div>
    <div class="notice-banner">目前顯示「${exportMode==='student_operation'?'學生操作':exportMode==='teacher_trial'?'老師試用':'示範體驗'}」。${LOCAL_MODE?'只包含這個瀏覽器的紀錄；老師試用與學生操作分開統計，未連接 AI 或雲端資料庫。':'三種模式各自統計；AI 建議與系統實際採取的進度決策都會留下紀錄。'}</div>
    <section class="stat-grid" aria-label="學習統計"><div class="stat-card"><small>已作答使用者</small><strong>${s.learners}</strong><p>這個模式下的使用者</p></div><div class="stat-card"><small>首次作答正確率</small><strong>${s.questions?percent+'%':'—'}</strong><p>${s.first_correct} / ${s.questions} 道已作答題目</p></div><div class="stat-card"><small>獨立答對題數</small><strong>${s.independent_correct}</strong><p>首次作答，且未接受提示或檢查</p></div><div class="stat-card"><small>有效練習時間</small><strong>${Math.floor(s.active_ms/60000)}<small> 分鐘</small></strong><p>前景視窗、最近有操作的估計時間</p></div></section>
    <div class="dashboard-grid"><div><section class="panel"><div class="panel-title"><h2>${LOCAL_MODE?'本機學生檔案':'學生與登入碼'}</h2><small>使用暱稱即可</small></div><div class="panel-content"><form id="student-form" class="student-form"><label for="student-name" class="hidden">學生暱稱</label><input class="input" id="student-name" maxlength="40" placeholder="輸入學生暱稱" required><button class="primary request-btn" type="submit">建立學生</button></form>
      ${state.newCode?`<div class="student-code" role="status">已建立 ${esc(state.newCode.student.name)}。${LOCAL_MODE?'回到入口即可選取這個本機檔案。':`請私下提供登入碼，關閉後不再顯示。<code>${esc(state.newCode.code)}</code>`}<button class="text-btn" id="hide-code">關閉顯示</button></div>`:''}
      ${data.students.length?`<table class="data-table"><thead><tr><th>學生暱稱</th><th>狀態</th><th>操作</th></tr></thead><tbody>${data.students.map(st=>`<tr><td>${esc(st.name)}</td><td>${st.active?'使用中':'已暫停'}</td><td><button class="text-btn" data-toggle-student="${st.id}" data-active="${st.active?'0':'1'}">${st.active?'暫停登入':'恢復登入'}</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty-state">先建立一位學生，<br>就能開始第一次課後試用。</div>'}</div></section>
      <section class="panel"><div class="panel-title"><h2>各能力的練習證據</h2><small>獨立答對 / 作答次數</small></div><div class="panel-content">${state.boot.curriculum.chapters.flatMap(c=>c.skills).map(skill=>{
        const row=data.skills.find(x=>x.skill_id===skill.id)||{independent_correct:0,attempts:0};
        return `<div class="skill-stat"><label>${esc(skill.title)}</label><progress value="${row.independent_correct}" max="${Math.max(1,row.attempts)}" aria-label="${esc(skill.title)}獨立答對比例"></progress><span>${row.independent_correct} / ${row.attempts}</span></div>`;
      }).join('')}</div></section></div>
    <div><section class="panel"><div class="panel-title"><h2>操作時間線</h2><div class="row"><a class="export-link" href="/api/teacher/export?mode=${exportMode}&format=csv${studentQuery}" download>${icon('download')}CSV</a><a class="export-link" href="/api/teacher/export?mode=${exportMode}&format=json${studentQuery}" download>${icon('download')}完整 JSON</a></div></div><div class="panel-content event-list">${data.timeline.length?data.timeline.map(ev=>{
      let payload={};try{payload=JSON.parse(ev.payload_json);}catch{}
      const extra=ev.kind==='answer_submitted'?payload.correct?'答對':'尚待修正':ev.kind==='progression_decision'?payload.reason:ev.kind==='heartbeat'?`${Math.round((payload.active_ms||0)/1000)} 秒`:'';
      return `<div class="event-row"><span class="event-symbol">${ev.source==='server'||ev.source==='local_engine'?'✓':'·'}</span><div><p>${esc(ev.name)} · ${esc(eventNames[ev.kind]||ev.kind)}</p><small>${esc(extra)} ${LOCAL_MODE?(ev.source==='local_engine'?'・本機練習判斷':'・操作紀錄'):ev.source==='server'?'・伺服器確認':'・瀏覽器操作'}</small></div><time>${new Date(ev.received_at).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'})}</time></div>`;
    }).join(''):'<div class="empty-state">目前沒有這個模式的操作紀錄。</div>'}</div></section>
    <section class="panel"><div class="panel-title"><h2>最近的輔導對話</h2><small>用來理解學生卡住的地方</small></div><div class="panel-content event-list">${data.conversations.length?data.conversations.map(c=>`<article class="conversation"><strong>${esc(c.name)} · ${esc(skillInfo(c.skill_id)?.title||c.skill_id)} · ${c.provider==='llm'?'AI 判讀':'規則輔導'}</strong><p>${esc(c.message)}</p><p class="reply">${esc(c.reply)}</p></article>`).join(''):'<div class="empty-state">學生提問後，這裡會顯示對話紀錄。</div>'}</div></section></div></div>
    <p class="dashboard-foot">進度規則：${LOCAL_MODE?'local-pilot-1':'pilot-1'}。難度門檻是試用設定，需依實際學生表現調整。七天後複習日期會保留於進度中，目前不自動發送通知。<br>${LOCAL_MODE?'純 GitHub Pages 體驗版，使用本機規則引導，資料不會自動傳給老師或其他裝置。':data.tutor.configured?`已設定模型：${esc(data.tutor.model)}；連線失敗時會改用受控規則輔導。`:'尚未設定 AI 模型，現在使用規則輔導。'} 事件 CSV 僅包含操作事件；完整 JSON 另含已提交作答、步驟與對話。</p></main>`;
  bindHeader();
  $('#mode-filter').addEventListener('change',e=>{state.dashboardMode=e.target.value;state.selectedStudent='';runAction(loadDashboard);});
  $('#student-filter').addEventListener('change',e=>{state.selectedStudent=e.target.value;runAction(loadDashboard);});
  $('#refresh-dashboard').addEventListener('click',()=>runAction(loadDashboard));
  $('#student-form').addEventListener('submit',e=>{e.preventDefault();runAction(async()=>{state.newCode=await api('/api/teacher/students',{name:$('#student-name').value});await loadDashboard();});});
  $('#hide-code')?.addEventListener('click',()=>{state.newCode=null;renderDashboard();});
  if(LOCAL_MODE){
    $$('.export-link').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();runAction(async()=>{
      heartbeatRemainder();await flushEvents();
      const result=await api(link.getAttribute('href'));
      downloadLocal(result);
    });}));
  }
  $$('[data-toggle-student]').forEach(b=>b.addEventListener('click',()=>runAction(async()=>{await api(`/api/teacher/students/${b.dataset.toggleStudent}/active`,{active:b.dataset.active==='1'});await loadDashboard();})));
}

['pointerdown','keydown','wheel'].forEach(name=>document.addEventListener(name,()=>{state.lastInteraction=performance.now();},{passive:true}));
document.addEventListener('visibilitychange',()=>{heartbeatRemainder();track('tab_visibility',{visible:document.visibilityState==='visible'});flushEvents(true);});
window.addEventListener('focus',()=>track('window_focus',{focused:true}));
window.addEventListener('blur',()=>{heartbeatRemainder();track('window_focus',{focused:false});flushEvents(true);});
window.addEventListener('pagehide',()=>{heartbeatRemainder();track('session_end',{page:state.page});flushEvents(true);});
window.addEventListener('online',()=>flushEvents());
setInterval(updateActiveTime,1000);setInterval(()=>flushEvents(),15000);

async function boot() {
  try {
    state.boot=await api('/api/bootstrap');
    try{await signedIn(await api('/api/me'));}catch(error){if(error.status===401)renderLogin();else throw error;}
  }catch(error){$('#app').innerHTML=`<main class="loading-screen"><h1>暫時無法連線</h1><p>${esc(error.message)}</p><button class="secondary" id="retry-boot">重新連線</button></main>`;$('#retry-boot').addEventListener('click',boot);}
}
boot();
