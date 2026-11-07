// Provider secrets never enter this module. The classroom code authorizes our backend only.
const CARDS = new Set(['hint','concept','check_work','encourage','off_topic','answer_boundary']);
const DEFAULT_ENDPOINT='https://one-step-tutor-hectornet.quirkylion66.chatgpt.site';
const CONFIG_KEY='one-step-tutor-endpoint-v1', CODE_KEY='one-step-tutor-code-v1';
export function endpointURL(value){
  const url=new URL(String(value).trim());
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('請使用不含帳密或參數的 HTTPS 輔導服務網址。');
  url.pathname=url.pathname.replace(/\/+$/,'');return url.href.replace(/\/$/,'');
}
export function makeRemoteTutor({preferences,session,fetcher=fetch}){
  let ready=false;
  const settings=()=>({endpoint:preferences.getItem(CONFIG_KEY)||DEFAULT_ENDPOINT,hasCode:!!session.getItem(CODE_KEY),ready});
  async function configure(endpoint,code){
    const base=endpointURL(endpoint);
    code=String(code||'').trim();
    if(!code||code.length<16||code.length>200||/^sk-/.test(code))throw new Error('這裡只接受老師提供的試用通行碼，不能填 OpenAI API Key。');
    let response;try{response=await fetcher(base+'/api/status',{headers:{Authorization:'Bearer '+code},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(8000)});}catch{throw new Error('目前無法連接輔導服務。服務可能尚未開放，請先使用規則提示。');}
    if(!response.ok)throw new Error(response.status===401?'試用通行碼不正確。':'輔導服務尚未完成設定，請稍後再試。');
    const result=await response.json();
    if(result.ready!==true)throw new Error('輔導服務的 AI 尚未啟用，現在仍可使用規則提示。');
    preferences.setItem(CONFIG_KEY,base);session.setItem(CODE_KEY,code);ready=true;
    return settings();
  }
  function disconnect(){session.removeItem(CODE_KEY);ready=false;}
  async function route(input){
    const {endpoint,hasCode}=settings();if(!endpoint||!hasCode)return null;
    try{
      const response=await fetcher(endpoint+'/api/tutor',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.getItem(CODE_KEY)},
        credentials:'omit',redirect:'error',signal:AbortSignal.timeout(12000),body:JSON.stringify({request_id:input.request_id,bank_id:input.bank_id,message:input.message,action:input.action})});
      if(!response.ok){ready=false;return {provider_status:response.status===429?'request_limit':'provider_unavailable'};}
      const result=await response.json();
      if(result.provider!=='llm'||!CARDS.has(result.card)||Object.keys(result).some(k=>!['card','provider','provider_status'].includes(k)))return {provider_status:'provider_unavailable'};
      ready=true;return {card:result.card,provider:'llm',provider_status:'ok'};
    }catch{ready=false;return {provider_status:'provider_unavailable'};}
  }
  return {settings,configure,disconnect,route};
}
let singleton;
export function remoteTutor(){return singleton||=makeRemoteTutor({preferences:localStorage,session:sessionStorage});}
