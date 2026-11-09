// The browser receives account summaries and approved card IDs only, never OAuth credentials.
const CARDS = new Set(['hint', 'concept', 'check_work', 'encourage', 'off_topic', 'answer_boundary']);
const MESSAGES = {
  not_connected: '尚未連接 ChatGPT。', awaiting_first_request: '已授權；請提問一次以驗證模型可用。',
  discovering_models: '正在讀取這個帳號可用的模型。', ok: '已完成真實模型請求，正在使用你的 ChatGPT 方案。',
  plan_permission_required: '登入不等於額度授權。請再次連接，確認授權使用 ChatGPT 方案。',
  subscription_sharing_user_not_eligible: '這個帳號或工作區尚不支援 ChatGPT 方案串接；暫時使用規則提示。',
  subscription_sharing_usage_limit_exceeded: '已達方案或此應用程式的使用上限，請到 ChatGPT 的使用量設定查看。',
  subscription_sharing_usage_unavailable: '暫時無法確認使用額度，請稍後再試。',
  subscription_sharing_invalid_user: '這個帳號的授權已無法確認，請重新登入。',
  subscription_sharing_route_not_supported: '此帳號尚不允許這個串接方式，暫時使用規則提示。',
  subscription_sharing_unsupported_capability: '目前模型不支援這個請求，暫時使用規則提示。',
  chatpass_v2_scope_not_authorized: '這次授權不允許模型請求，請確認帳號及授權範圍。',
  sign_in_required: '請重新登入 ChatGPT，之後再試一次。',
  models_unavailable: '暫時無法取得模型，請重新整理模型或稍後再試。',
  request_limit: '已達本機試用的請求限制，先使用規則提示。',
  request_in_progress: '上一個請求尚在處理，請稍後再試。',
  session_changed: '另一個分頁已切換學習檔案，請重新選擇檔案並授權。',
  provider_unavailable: '模型暫時無法回應，這次改用規則提示。',
};
export const localStatusMessage = code => MESSAGES[code] || '目前無法完成連線，請重新登入或稍後再試。';

export function makeLocalChatGPT({fetcher = fetch} = {}) {
  let context, info = {connections: [], ready: false, verified: false, status: 'not_connected', models: []};
  async function call(path, body) {
    const response = await fetcher('/api/local-ai/' + path, {credentials: 'same-origin', redirect: 'error',
      headers: {'Content-Type': 'application/json', 'X-One-Step-Client': '1'}, signal: AbortSignal.timeout(path === 'tutor' ? 50000 : 25000),
      ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)})});
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(localStatusMessage(data.error)), {code: data.error});
    return data;
  }
  const settings = () => ({...info, localChatGPT: true, hasCode: !!info.ready, endpoint: ''});
  async function refresh() {
    try {
      info = await call('status');
      if (context && info.context !== context.mode + ':' + context.profile_id) {
        info = {...info, ready: false, verified: false, active: null, email: null, model: null, connections: [], models: [], status: 'session_changed'};
      }
    } catch (error) { info = {...info, ready: false, verified: false, status: error.code || 'provider_unavailable'}; }
    return settings();
  }
  async function setContext(profile_id, mode) {
    context = {profile_id, mode};
    try { info = await call('context', context); }
    catch (error) { info = {...info, ready: false, status: error.code || 'provider_unavailable'}; }
    return settings();
  }
  async function disconnect() {
    context = null;
    try { await call('pause', {}); }
    finally { info = {connections: [], ready: false, verified: false, status: 'not_connected', models: []}; }
  }
  async function route(input) {
    if (!context || !info.ready) return null;
    if (input.local_profile_id !== context.profile_id || input.local_mode !== context.mode) return {provider_status: 'session_changed'};
    try {
      const data = await call('tutor', {request_id: input.request_id, bank_id: input.bank_id, message: input.message, action: input.action, ...context});
      await refresh();
      if (data.provider === 'llm' && CARDS.has(data.card) && Object.keys(data).every(k => ['card', 'provider', 'provider_status'].includes(k))) return data;
      return {provider_status: Object.hasOwn(MESSAGES, data.provider_status) ? data.provider_status : 'provider_unavailable'};
    } catch (error) { await refresh(); return {provider_status: error.code || 'provider_unavailable'}; }
  }
  return {settings, refresh, setContext, disconnect, route,
    start: async connection_id => {
      if (context) await setContext(context.profile_id, context.mode);
      return (await call('auth/start', {connection_id})).navigate;
    },
    signOut: async connection_id => { const result = await call('sign-out', {connection_id}); await refresh(); return result; },
    models: async () => { info = await call('models', {}); return settings(); },
    selectModel: async model => { info = await call('model', {model}); return settings(); },
  };
}
