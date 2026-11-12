/** Explicit, retryable PIPELINE -> Mission Control outbox dispatcher.
 * No delivery occurs inside the closing transaction. A caller must opt in.
 */
export async function deliverMissionControlHandoff({ transactions, opportunityId, handoffId, endpoint, secret, fetchImpl = fetch, actor = 'mission-control-dispatch', timeoutMs = 10000 }) {
  if (!transactions || !opportunityId || !handoffId) throw new Error('handoff_context_required');
  if (!secret || typeof secret !== 'string') throw new Error('handoff_secret_required');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('invalid_handoff_endpoint'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('secure_handoff_endpoint_required');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1/integrations/pipeline/acquisition-handoff') throw new Error('invalid_handoff_endpoint');
  const handoff = transactions.listHandoffs(opportunityId).find(item => item.id === handoffId);
  if (!handoff || handoff.targetSystem !== 'mission-control') throw new Error('acquisition_handoff_not_found');
  if (handoff.status === 'acknowledged') return { acknowledged: true, alreadyAcknowledged: true, handoffId };
  transactions.recordHandoffEvent({ handoffId, eventType: 'dispatch_attempted', actor });
  let response;
  try {
    response = await fetchImpl(url.href, { method: 'POST', headers: { 'authorization': `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ handoffId, payload: handoff.payload }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (![200, 201].includes(response.status)) throw new Error(`receiver_http_${response.status}`);
    const result = await response.json();
    if (result?.ok !== true || !result.data?.project?.id || result.data.project.sourceHandoffId !== handoffId || result.data.project.sourceOpportunityId !== opportunityId || typeof result.data?.duplicate !== 'boolean') throw new Error('invalid_handoff_acknowledgment');
    transactions.recordHandoffEvent({ handoffId, eventType: 'acknowledged', actor, externalRef: String(result.data.project.id || '').slice(0,500) || null });
    return { acknowledged: true, duplicate: result.data.duplicate, handoffId };
  } catch (error) {
    transactions.recordHandoffEvent({ handoffId, eventType: 'failed', actor, detail: String(error?.message || 'delivery_failed').slice(0,500) });
    return { acknowledged: false, handoffId, error: String(error?.message || 'delivery_failed') };
  }
}
