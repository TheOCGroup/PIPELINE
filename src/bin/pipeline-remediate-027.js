/**
 * PIPELINE migration-027 historical remediation tool (Option A, governed).
 *
 * Operates on ONE database file passed as an argument. Default mode is a
 * dry run: it prints a JSON manifest of every change it WOULD make and
 * writes nothing. `--apply` performs the changes in a single transaction.
 *
 * Rules (from MIGRATION-READINESS-REVIEW-2026-10-25 §4; never guess):
 * - Linkage backfill: a version with underwriting_ref_id NULL is linked
 *   to the underwriting reference of the same opportunity whose
 *   analyzed_at equals the version's underwriting_timestamp — ONLY when
 *   exactly one such reference exists. Zero or multiple matches stay
 *   unlinked and are reported.
 * - Sentinel null-out: per figure column (arv / rehab / mao), a stored 0
 *   becomes NULL only when the version's LINKED reference figure is NULL
 *   (the stored 0 was the NOT NULL sentinel for "unknown"). Any other
 *   stored value is preserved byte-for-byte.
 * - Immutability: versions in status pending_approval / approved are
 *   protected by the terms trigger. Without `--include-immutable`, their
 *   changes are reported as deferred_immutable and NOT attempted. With
 *   it, the tool drops the terms trigger inside the same transaction,
 *   applies the manifest, recreates the trigger with migration 027's
 *   exact definition, and verifies the full trigger inventory is
 *   identical before and after.
 * - Historical underwriting_source_id strings are never rewritten.
 *
 * Usage: node src/bin/pipeline-remediate-027.js <dbPath> [--apply] [--include-immutable]
 */
import { DatabaseSync } from "node:sqlite";

const TERMS_TRIGGER_SQL = `CREATE TRIGGER trg_prevent_pending_or_approved_offer_version_terms_update
BEFORE UPDATE ON seller_offer_versions
FOR EACH ROW
WHEN (OLD.version_status = 'pending_approval' OR OLD.version_status = 'approved')
  AND (NEW.strategy_type != OLD.strategy_type
    OR NEW.purchase_price != OLD.purchase_price
    OR NEW.earnest_money != OLD.earnest_money
    OR NEW.inspection_days != OLD.inspection_days
    OR NEW.closing_days != OLD.closing_days
    OR COALESCE(NEW.expiration_at, '') != COALESCE(OLD.expiration_at, '')
    OR NEW.contingencies_json != OLD.contingencies_json
    OR COALESCE(NEW.seller_facing_terms, '') != COALESCE(OLD.seller_facing_terms, '')
    OR COALESCE(NEW.internal_notes, '') != COALESCE(OLD.internal_notes, '')
    OR NEW.underwriting_source_type != OLD.underwriting_source_type
    OR NEW.underwriting_source_id != OLD.underwriting_source_id
    OR NEW.underwriting_version_id != OLD.underwriting_version_id
    OR NEW.underwriting_ref_id IS NOT OLD.underwriting_ref_id
    OR NEW.underwriting_arv_snapshot IS NOT OLD.underwriting_arv_snapshot
    OR NEW.underwriting_rehab_snapshot IS NOT OLD.underwriting_rehab_snapshot
    OR NEW.underwriting_mao_snapshot IS NOT OLD.underwriting_mao_snapshot
    OR COALESCE(NEW.underwriting_confidence, 0) != COALESCE(OLD.underwriting_confidence, 0)
    OR COALESCE(NEW.underwriting_limitations, '') != COALESCE(OLD.underwriting_limitations, '')
    OR COALESCE(NEW.underwriting_timestamp, '') != COALESCE(OLD.underwriting_timestamp, ''))
BEGIN
    SELECT RAISE(FAIL, 'Modifying terms of a pending_approval or approved seller_offer_version is prohibited. Revisions must create a new version.');
END`;

const FIGURES = [
  ["underwriting_arv_snapshot", "arv"],
  ["underwriting_rehab_snapshot", "rehab"],
  ["underwriting_mao_snapshot", "mao"],
];

export function planRemediation(db) {
  const versions = db
    .prepare(
      `SELECT v.*, o.opportunity_id AS opportunity_id
         FROM seller_offer_versions v JOIN seller_offers o ON o.id = v.offer_id
        ORDER BY v.created_at, v.id`,
    )
    .all();
  const manifest = [];
  for (const v of versions) {
    const entry = {
      versionId: v.id,
      offerId: v.offer_id,
      opportunityId: v.opportunity_id,
      versionStatus: v.version_status,
      actions: [],
      disposition: "unchanged",
    };
    // Resolve the governing reference: existing link, else unique timestamp match.
    let ref = null;
    let linkAction = null;
    if (v.underwriting_ref_id) {
      ref = db
        .prepare(`SELECT * FROM opportunity_underwriting_refs WHERE id = ? AND opportunity_id = ?`)
        .get(v.underwriting_ref_id, v.opportunity_id);
      if (!ref) entry.actions.push({ type: "warning", detail: "stored underwriting_ref_id resolves to no reference for this opportunity; left as-is" });
    } else if (v.underwriting_timestamp) {
      const candidates = db
        .prepare(`SELECT * FROM opportunity_underwriting_refs WHERE opportunity_id = ? AND analyzed_at = ?`)
        .all(v.opportunity_id, v.underwriting_timestamp);
      if (candidates.length === 1) {
        ref = candidates[0];
        linkAction = { type: "link_ref", refId: ref.id };
      } else {
        entry.actions.push({
          type: "unlinked",
          reason: candidates.length === 0 ? "no_reference_with_matching_timestamp" : "ambiguous_multiple_references_share_timestamp",
          candidates: candidates.length,
        });
      }
    } else {
      entry.actions.push({ type: "unlinked", reason: "no_underwriting_timestamp" });
    }
    const nullOuts = [];
    if (ref) {
      for (const [column, refField] of FIGURES) {
        if (v[column] === 0 && (ref[refField] === null || ref[refField] === undefined)) {
          nullOuts.push({ type: "null_out_sentinel", column });
        }
      }
    }
    const changes = [...(linkAction ? [linkAction] : []), ...nullOuts];
    if (changes.length) {
      const protectedStatus = v.version_status === "pending_approval" || v.version_status === "approved";
      entry.actions.push(...changes);
      entry.disposition = protectedStatus ? "deferred_immutable" : "apply";
    }
    manifest.push(entry);
  }
  return manifest;
}

export function applyRemediation(db, { includeImmutable = false } = {}) {
  const manifest = planRemediation(db);
  const needsImmutable = manifest.some((e) => e.disposition === "deferred_immutable");
  const triggerInventory = () =>
    db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name`).all();
  const before = triggerInventory();
  db.exec("BEGIN TRANSACTION");
  try {
    if (needsImmutable && includeImmutable) {
      db.exec(`DROP TRIGGER trg_prevent_pending_or_approved_offer_version_terms_update`);
    }
    for (const entry of manifest) {
      const applicable = entry.disposition === "apply" || (entry.disposition === "deferred_immutable" && includeImmutable);
      if (!applicable) continue;
      for (const action of entry.actions) {
        if (action.type === "link_ref") {
          db.prepare(`UPDATE seller_offer_versions SET underwriting_ref_id = ? WHERE id = ?`).run(action.refId, entry.versionId);
          entry.applied = true;
        } else if (action.type === "null_out_sentinel") {
          db.prepare(`UPDATE seller_offer_versions SET ${action.column} = NULL WHERE id = ?`).run(entry.versionId);
          entry.applied = true;
        }
      }
      if (entry.applied) entry.disposition = "applied";
    }
    if (needsImmutable && includeImmutable) {
      db.exec(TERMS_TRIGGER_SQL);
      const after = triggerInventory();
      const identical = JSON.stringify(before) === JSON.stringify(after);
      if (!identical) throw new Error("trigger inventory differs after remediation — rolling back");
      for (const entry of manifest) if (entry.applied) entry.triggerRestored = true;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return manifest;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [dbPath, ...flags] = process.argv.slice(2);
  if (!dbPath) {
    console.error("usage: node src/bin/pipeline-remediate-027.js <dbPath> [--apply] [--include-immutable]");
    process.exit(2);
  }
  const db = new DatabaseSync(dbPath);
  const cols = db.prepare(`PRAGMA table_info(seller_offer_versions)`).all().map((c) => c.name);
  if (!cols.includes("underwriting_ref_id")) {
    console.error("database has not been migrated to 027 (no underwriting_ref_id column) — refusing to run");
    process.exit(1);
  }
  if (flags.includes("--apply")) {
    const manifest = applyRemediation(db, { includeImmutable: flags.includes("--include-immutable") });
    console.log(JSON.stringify({ mode: "apply", manifest }, null, 2));
  } else {
    console.log(JSON.stringify({ mode: "dry-run", manifest: planRemediation(db) }, null, 2));
  }
  db.close();
}
