import {LocalError} from './errors.mjs';

const PUBLIC_CODES = new Set(['invalid_api_key','invalid_token','invalid_authentication','insufficient_permissions',
  'permission_denied','access_denied','insufficient_scope','insufficient_quota','rate_limit_exceeded',
  'subscription_sharing_user_not_eligible','subscription_sharing_invalid_user','subscription_sharing_user_unavailable',
  'subscription_sharing_usage_limit_exceeded','subscription_sharing_usage_unavailable',
  'subscription_sharing_route_not_supported','chatpass_v2_scope_not_authorized','chatpass_v2_invalid_authorization_context']);

// Expose only bounded, recognized diagnostics. Never include upstream text, token fields, headers, or URLs.
export function modelDiagnostic(response, body, shape = 'unknown') {
  const code = body?.error?.code || (typeof body?.error === 'string' ? body.error : null);
  const requestId = response?.headers.get('x-request-id');
  return {stage: 'models', http_status: response?.status || null,
    provider_code: code ? PUBLIC_CODES.has(code) ? code : 'unrecognized_error' : null,
    request_id: /^req_[a-f0-9]{16,64}$/.test(requestId || '') ? requestId : null,
    response_shape: shape};
}
export function modelTransportError(error) {
  const code = error?.cause?.code || error?.code;
  const reason = ['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','UND_ERR_CONNECT_TIMEOUT'].includes(code) ? code :
    ['TimeoutError','AbortError'].includes(error?.name) ? 'timeout' : 'network_error';
  return new LocalError('models_network_error', 503, {stage: 'models', http_status: null, transport: reason});
}
export function readModelCatalog(body, response) {
  const catalog = Array.isArray(body?.models), standard = !catalog && Array.isArray(body?.data);
  const shape = catalog ? 'chatgpt_catalog' : standard ? 'openai_list' : 'unknown';
  const diagnostic = modelDiagnostic(response, null, shape);
  if (!catalog && !standard) throw new LocalError('models_response_invalid', 502, diagnostic);
  const seen = new Set(), output = [];
  for (const item of catalog ? body.models : body.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    // Preserve the ChatGPT catalog visibility contract; standard /models lists have id fields.
    if (catalog && item.visibility !== 'list') continue;
    const slug = catalog ? item.slug : item.id;
    if (typeof slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    output.push({slug, display_name: typeof item.display_name === 'string' && item.display_name.length <= 160 ? item.display_name : slug});
  }
  if (!output.length) throw new LocalError('models_empty', 503, diagnostic);
  return output;
}
