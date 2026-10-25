/**
 * Offer-version underwriting snapshot resolution.
 *
 * seller_offer_versions historically stored its snapshot figures in REAL
 * NOT NULL columns (migration 005), so a version created from an
 * underwriting reference whose figures were unknown carried a 0 storage
 * sentinel in those columns. That 0 is NOT a figure and must never be
 * presented as one: unknown stays unknown. (Migration 027 makes the
 * columns nullable so new versions store honest NULLs; resolution below
 * protects every historical row regardless.)
 *
 * Resolution rule for read models, in order:
 * 1. Explicit linkage (migration 027): version.underwriting_ref_id names
 *    the exact reference row the version was prepared from. This cures
 *    UA1 — timestamp matching alone is ambiguous when a corrected
 *    package is re-sent with its original analyzed_at.
 * 2. Timestamp match: the reference whose analyzed_at equals the
 *    version's underwriting_timestamp for the same opportunity.
 * When a reference is found, its values are authoritative — nulls
 * included. When neither identifies one (the reference was later
 * replaced and the link dissolved), the stored snapshot stands as the
 * historical record.
 */
export function resolveSnapshotFigures(db, opportunityId, version) {
  const stored = {
    arv: version.underwriting_arv_snapshot,
    rehab: version.underwriting_rehab_snapshot,
    mao: version.underwriting_mao_snapshot,
    confidence: version.underwriting_confidence,
  };
  if (!db || !opportunityId || !version) return stored;
  try {
    if (version.underwriting_ref_id) {
      const linked = db
        .prepare(
          `SELECT arv, rehab, mao, confidence FROM opportunity_underwriting_refs
           WHERE id = ? AND opportunity_id = ?`
        )
        .get(version.underwriting_ref_id, opportunityId);
      if (linked) {
        return {
          arv: linked.arv ?? null,
          rehab: linked.rehab ?? null,
          mao: linked.mao ?? null,
          confidence: linked.confidence ?? null,
        };
      }
    }
    if (!version.underwriting_timestamp) return stored;
    const ref = db
      .prepare(
        `SELECT arv, rehab, mao, confidence FROM opportunity_underwriting_refs
         WHERE opportunity_id = ? AND analyzed_at = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(opportunityId, version.underwriting_timestamp);
    if (!ref) return stored;
    return {
      arv: ref.arv ?? null,
      rehab: ref.rehab ?? null,
      mao: ref.mao ?? null,
      confidence: ref.confidence ?? null,
    };
  } catch {
    return stored;
  }
}
