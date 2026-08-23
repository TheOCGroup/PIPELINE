const DEFAULT_BASE_URL = 'https://backend.composio.dev/api/v3.1';

function getConfig() {
  const enabled = String(process.env.COMPOSIO_ENABLED || '').toLowerCase() === 'true';
  const apiKey = process.env.COMPOSIO_API_KEY || '';
  const baseUrl = (process.env.COMPOSIO_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');

  return { enabled, apiKey, baseUrl };
}

export function isComposioConfigured() {
  const { enabled, apiKey } = getConfig();
  return enabled && Boolean(apiKey);
}

function assertConfigured() {
  const { enabled, apiKey, baseUrl } = getConfig();
  if (!enabled) throw new Error('Composio integration is disabled. Set COMPOSIO_ENABLED=true to enable it.');
  if (!apiKey) throw new Error('COMPOSIO_API_KEY is required when Composio integration is enabled.');
  return { apiKey, baseUrl };
}

async function request(path, options = {}) {
  const { apiKey, baseUrl } = assertConfigured();
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }

  if (!response.ok) {
    const error = new Error(`Composio request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

export async function createComposioSession({ userId, toolkits = [], callbackUrl } = {}) {
  if (!userId) throw new Error('userId is required to create a Composio session.');

  const payload = { user_id: String(userId) };
  if (toolkits.length) payload.toolkits = { enabled: toolkits };
  if (callbackUrl) {
    payload.manage_connections = {
      enabled: true,
      callback_url: callbackUrl,
      enable_wait_for_connections: false,
      enable_connection_removal: true,
    };
  }

  return request('/tool_router/session', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getComposioSession(sessionId) {
  if (!sessionId) throw new Error('sessionId is required.');
  return request(`/tool_router/session/${encodeURIComponent(sessionId)}`);
}

export async function searchComposioTools(sessionId, useCase) {
  if (!sessionId) throw new Error('sessionId is required.');
  if (!useCase) throw new Error('useCase is required.');
  return request(`/tool_router/session/${encodeURIComponent(sessionId)}/search`, {
    method: 'POST',
    body: JSON.stringify({ queries: [{ use_case: useCase }] }),
  });
}

export async function executeComposioTool(sessionId, toolSlug, args = {}) {
  if (!sessionId) throw new Error('sessionId is required.');
  if (!toolSlug) throw new Error('toolSlug is required.');
  return request(`/tool_router/session/${encodeURIComponent(sessionId)}/execute`, {
    method: 'POST',
    body: JSON.stringify({ tool_slug: toolSlug, arguments: args }),
  });
}

export async function createComposioConnectionLink(sessionId, toolkit, callbackUrl) {
  if (!sessionId) throw new Error('sessionId is required.');
  if (!toolkit) throw new Error('toolkit is required.');
  return request(`/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
    method: 'POST',
    body: JSON.stringify({ toolkit, callback_url: callbackUrl }),
  });
}
