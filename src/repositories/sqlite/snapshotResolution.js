/**
 * Offer-version underwriting snapshot resolution.
 *
 * seller_offer_versions stores its snapshot figures in REAL NOT NULL columns
 * (migration 005), so a version created from an underwriting reference whose
 * figures are unknown carries a 0 storage sentinel in those columns. That 0
 * is NOT a figure and must never be presented as one: unknown stays unknown.
 *
 * Resolution rule for read models: a version snapshots the underwriting
 * reference whose analyzed_at equals the version's underwriting_timestamp
 * for the same opportunity. When that reference is found, its values are
 * authoritative — nulls included. When it is not found (the reference was
 * later replaced), the stored snapshot stands as the historical record.
 */
export function resolveSnapshotFigures(db, opportunityId, version) {
  const stored = {
    arv: version.underwriting_arv_snapshot,
    rehab: version.underwriting_rehab_snapshot,
    mao: version.underwriting_mao_snapshot,
    confidence: version.underwriting_confidence,
  };
  if (!db || !opportunityId || !version || !version.underwriting_timestamp) return stored;
  let ref = null;
  try {
    ref = db
      .prepare(
        `SELECT arv, rehab, mao, confidence FROM opportunity_underwriting_refs
         WHERE opportunity_id = ? AND analyzed_at = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(opportunityId, version.underwriting_timestamp);
  } catch {
    return stored;
  }
  if (!ref) return stored;
  return {
    arv: ref.arv ?? null,
    rehab: ref.rehab ?? null,
    mao: ref.mao ?? null,
    confidence: ref.confidence ?? null,
  };
}
