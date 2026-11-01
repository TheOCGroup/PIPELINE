/**
 * Candidate ranking (Issue #8 seller-to-deal journey).
 *
 * Ranks the tenant's open opportunities against one buyer-criteria record
 * (migration 029) using RECORDED figures only:
 *
 *   - market: the recorded property address (earliest source row) must
 *     contain one of the criteria's market strings, case-insensitively.
 *   - price band: the recorded asking price must sit inside
 *     [minPrice, maxPrice] for the bounds the buyer actually stated.
 *   - economics: headroom = newest underwriting reference's recorded MAO
 *     minus the recorded asking price — the same rule the Piper intent
 *     router's "strongest" ranking uses (intentRouter.js `strongest`).
 *   - criteria.minConfidence: the newest reference's recorded confidence
 *     must meet the buyer's stated minimum.
 *   - property types: candidates carry no recorded property type in this
 *     system, so a criteria record that names property types makes every
 *     candidate unrankable on that criterion. The type is never guessed.
 *
 * Null-honesty is the contract: a candidate missing a figure a criterion
 * needs is NEVER scored with an invented substitute. It lands in
 * `unrankable` with the exact reasons ("asking price not recorded",
 * "MAO not recorded", …); a candidate that fails a stated bound lands in
 * `excluded` with the bound it failed. Only candidates with every needed
 * figure recorded appear in `ranked`, ordered by headroom.
 *
 * Tenant scope: the criteria row and every candidate are filtered by the
 * configured tenant; a foreign criteria id behaves exactly like a
 * nonexistent one (this service returns null and the route answers 404).
 *
 * Archived criteria (QUINCEY F6): an archived criteria is retired intent —
 * it remains readable as history through the criteria CRUD, but it must
 * never produce a ranking. rank() refuses with Error("criteria_archived")
 * (the route answers 409) rather than silently ranking against criteria
 * the buyer has withdrawn.
 */

import { isClosedStage } from "../domain/stages/stageModel.js";
import { normalizeTenantId } from "../repositories/sqlite/tenantScope.js";

export class CandidateRankingService {
  constructor(db, tenantId) {
    this.db = db;
    this.tenantId = normalizeTenantId(tenantId);
  }

  /** Rank candidates for one criteria id; null when the criteria is not the tenant's. */
  rank(criteriaId) {
    const criteriaRow = this.db
      .prepare("SELECT * FROM buyer_criteria WHERE id = ? AND tenant_id = ?")
      .get(criteriaId, this.tenantId);
    if (!criteriaRow) return null;
    if (criteriaRow.status === "archived") throw new Error("criteria_archived");

    const criteria = {
      id: criteriaRow.id,
      label: criteriaRow.label,
      markets: parseArray(criteriaRow.markets_json),
      propertyTypes: parseArray(criteriaRow.property_types_json),
      minPrice: criteriaRow.min_price ?? null,
      maxPrice: criteriaRow.max_price ?? null,
      minMaoHeadroom: criteriaRow.min_mao_headroom ?? null,
      minConfidence: parseObject(criteriaRow.criteria_json).minConfidence ?? null,
      status: criteriaRow.status,
    };

    const candidates = this.db.prepare(`
      SELECT o.id, o.opportunity_code, o.pipeline_stage, o.asking_price, o.created_at,
             src.original_address AS address
      FROM seller_opportunities o
      LEFT JOIN seller_opportunity_sources src ON src.id = (
        SELECT s.id FROM seller_opportunity_sources s
        WHERE s.opportunity_id = o.id
        ORDER BY s.conversion_timestamp ASC, s.rowid ASC
        LIMIT 1
      )
      WHERE o.tenant_id = ?
      ORDER BY o.created_at ASC, o.rowid ASC
    `).all(this.tenantId);

    const ranked = [];
    const excluded = [];
    const unrankable = [];

    for (const c of candidates) {
      if (isClosedStage(c.pipeline_stage)) continue; // closed records are not candidates
      const base = {
        opportunityId: c.id,
        code: c.opportunity_code,
        address: c.address ?? null,
        stage: c.pipeline_stage,
        askingPrice: c.asking_price ?? null,
      };

      const unrankableReasons = [];
      const excludedReasons = [];

      // Market — evaluated on the recorded address only.
      if (criteria.markets.length) {
        if (!base.address) {
          unrankableReasons.push("property address not recorded — market cannot be evaluated");
        } else {
          const haystack = base.address.toLowerCase();
          if (!criteria.markets.some((m) => haystack.includes(String(m).toLowerCase()))) {
            excludedReasons.push(`market: recorded address is outside the buyer's markets (${criteria.markets.join(", ")})`);
          }
        }
      }

      // Property type — never recorded for candidates in this system.
      if (criteria.propertyTypes.length) {
        unrankableReasons.push("property type not recorded — buyer property types cannot be evaluated");
      }

      // Price band — needs the recorded asking price.
      if (criteria.minPrice !== null || criteria.maxPrice !== null) {
        if (base.askingPrice === null) {
          unrankableReasons.push("asking price not recorded — price band cannot be evaluated");
        } else {
          if (criteria.minPrice !== null && base.askingPrice < criteria.minPrice) {
            excludedReasons.push(`price band: asking price ${base.askingPrice} is below the buyer's minimum ${criteria.minPrice}`);
          }
          if (criteria.maxPrice !== null && base.askingPrice > criteria.maxPrice) {
            excludedReasons.push(`price band: asking price ${base.askingPrice} exceeds the buyer's maximum ${criteria.maxPrice}`);
          }
        }
      }

      // Economics + confidence — newest underwriting reference, recorded
      // figures only (Delta B selection order).
      const ref = this.db.prepare(`
        SELECT id, analysis_status, mao, confidence, analyzed_at
        FROM opportunity_underwriting_refs
        WHERE opportunity_id = ?
        ORDER BY analyzed_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `).get(c.id);
      const mao = ref ? (ref.mao ?? null) : null;
      const confidence = ref ? (ref.confidence ?? null) : null;
      let headroom = null;
      if (!ref) {
        unrankableReasons.push("no underwriting reference recorded — MAO headroom cannot be evaluated");
      } else if (mao === null) {
        unrankableReasons.push(`MAO not recorded (newest underwriting reference is ${ref.analysis_status || "recorded"} with no MAO figure)`);
      } else if (base.askingPrice === null) {
        unrankableReasons.push("asking price not recorded — MAO headroom cannot be evaluated");
      } else {
        headroom = mao - base.askingPrice;
        if (criteria.minMaoHeadroom !== null && headroom < criteria.minMaoHeadroom) {
          excludedReasons.push(`headroom: recorded MAO headroom ${headroom} is below the buyer's minimum ${criteria.minMaoHeadroom}`);
        }
      }
      if (criteria.minConfidence !== null) {
        if (confidence === null) {
          unrankableReasons.push("underwriting confidence not recorded — buyer minimum confidence cannot be evaluated");
        } else if (confidence < criteria.minConfidence) {
          excludedReasons.push(`confidence: recorded confidence ${confidence} is below the buyer's minimum ${criteria.minConfidence}`);
        }
      }

      const entry = {
        ...base,
        mao,
        confidence,
        underwritingRefId: ref ? ref.id : null,
        underwritingAnalyzedAt: ref ? ref.analyzed_at : null,
      };
      if (unrankableReasons.length) {
        unrankable.push({ ...entry, headroom: null, reasons: unrankableReasons });
      } else if (excludedReasons.length) {
        excluded.push({ ...entry, headroom, reasons: excludedReasons });
      } else {
        ranked.push({ ...entry, headroom });
      }
    }

    // Deterministic order: widest recorded headroom first; ties break on
    // lower asking price, then candidate creation order (the query order).
    ranked.sort((a, b) =>
      (b.headroom - a.headroom) ||
      ((a.askingPrice ?? Infinity) - (b.askingPrice ?? Infinity)));

    return {
      criteria,
      ranked,
      excluded,
      unrankable,
      counts: {
        considered: ranked.length + excluded.length + unrankable.length,
        ranked: ranked.length,
        excluded: excluded.length,
        unrankable: unrankable.length,
      },
      basis: "recorded figures only — asking price and the newest underwriting reference's MAO/confidence; candidates missing a needed figure are unrankable on that criterion, never estimated",
    };
  }
}

function parseArray(value) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value) {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
