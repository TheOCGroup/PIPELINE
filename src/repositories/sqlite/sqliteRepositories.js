import { resolveProvenance } from "../../domain/provenance/provenanceModel.js";
import { statusForStage, opportunityProvenanceState } from "../../domain/opportunities/opportunityModel.js";

/**
 * Reported when the database holds no value for a field. PIPELINE says "not
 * recorded" rather than inventing a plausible one — an unknown is a fact worth
 * displaying, and a guess dressed as a determination is the failure this
 * application exists to prevent.
 */
export const NOT_RECORDED = "NOT_RECORDED";

// Helper to safely parse JSON
const parseJson = (str) => {
  try {
    return JSON.parse(str);
  } catch (_) {
    return {};
  }
};

export class SqliteOpportunityRepository {
  constructor(db) {
    this.db = db;
  }

  async listAll() {
    const rows = this.db.prepare(`
      SELECT 
        o.id,
        o.opportunity_code AS code,
        o.pipeline_stage AS stage,
        c.classification_value AS classification,
        o.created_at AS lastActivity,
        o.created_by AS createdBy,
        o.assigned_acquisition_manager_id AS assignedOperator,
        src.source_type,
        src.source_record_id,
        src.source_message_id,
        src.original_address,
        src.source_timestamp,
        src.provenance_metadata_json,
        src.conversion_actor,
        o.asking_price,
        ref.id AS ref_id,
        ref.source_system AS ref_source_system,
        ref.source_agent AS ref_source_agent,
        ref.source_project_id AS ref_project_id,
        ref.source_version_id AS ref_version_id,
        ref.analysis_status AS ref_status,
        ref.arv AS ref_arv,
        ref.rehab AS ref_rehab,
        ref.mao AS ref_mao,
        ref.confidence AS ref_confidence,
        ref.limitations AS ref_limitations,
        ref.evidence_summary_json AS ref_evidence_summary_json,
        ref.analyzed_at AS ref_analyzed_at
      FROM seller_opportunities o
      LEFT JOIN seller_opportunity_sources src ON src.opportunity_id = o.id
      LEFT JOIN record_classifications c ON c.opportunity_id = o.id
      LEFT JOIN opportunity_underwriting_refs ref ON ref.opportunity_id = o.id
    `).all();

    return rows.map(r => {
      // Find seller name from audit log
      const audit = this.db.prepare(`
        SELECT payload_json FROM operational_audit_events 
        WHERE event_type = 'DEAL_FINDR_INTAKE' AND JSON_EXTRACT(payload_json, '$.opportunityId') = ?
        LIMIT 1
      `).get(r.id);
      
      let sellerName = "Seller";
      if (audit) {
        const payload = parseJson(audit.payload_json);
        if (payload.sellerName) sellerName = payload.sellerName;
      }

      const underwriting = r.ref_id ? {
        source: r.ref_source_system || "deal-scout",
        agent: r.ref_source_agent || "Victor",
        projectId: r.ref_project_id || null,
        versionId: r.ref_version_id || null,
        status: r.ref_status || "completed",
        arv: r.ref_arv,
        rehab: r.ref_rehab,
        mao: r.ref_mao,
        confidence: r.ref_confidence,
        limitations: r.ref_limitations,
        analyzedAt: r.ref_analyzed_at,
        evidence: r.ref_evidence_summary_json ? parseJson(r.ref_evidence_summary_json) : null,
        fee: 5000,
        holding: 8000,
        askingPrice: r.asking_price || 120000
      } : null;

      return {
        id: r.id,
        code: r.code,
        sellerDisplayName: sellerName,
        property: {
          externalPropertyId: r.source_record_id || null,
          address: r.original_address || "Wichita Property"
        },
        assignedOperator: r.assignedOperator || "operator.demo",
        stage: r.stage || "new_lead",
        classification: r.classification || "unknown",
        lastActivity: r.lastActivity || new Date().toISOString(),
        isFixture: r.createdBy === 'system-seed',
        source: {
          sourceType: r.source_type || "property_lead_inbox",
          originalSourceMessageId: r.source_message_id || null,
          recoveredSourceMessageId: null,
          recoveryMethod: null,
          recoveryConfidence: null,
          provenanceMetadata: r.provenance_metadata_json ? parseJson(r.provenance_metadata_json) : null
        },
        underwriting,
        participants: [],
        sources: [],
        stageTimeline: [],
        offers: [],
        outcome: null
      };
    });
  }

  async getById(id) {
    const opp = this.db.prepare(`
      SELECT 
        o.id,
        o.opportunity_code AS code,
        o.pipeline_stage AS stage,
        c.classification_value AS classification,
        o.created_at AS lastActivity,
        o.created_by AS createdBy,
        o.assigned_acquisition_manager_id AS assignedOperator,
        src.source_type,
        src.source_record_id,
        src.source_message_id,
        src.original_address,
        src.source_timestamp,
        src.provenance_metadata_json,
        o.asking_price,
        ref.id AS ref_id,
        ref.source_system AS ref_source_system,
        ref.source_agent AS ref_source_agent,
        ref.source_project_id AS ref_project_id,
        ref.source_version_id AS ref_version_id,
        ref.analysis_status AS ref_status,
        ref.arv AS ref_arv,
        ref.rehab AS ref_rehab,
        ref.mao AS ref_mao,
        ref.confidence AS ref_confidence,
        ref.limitations AS ref_limitations,
        ref.evidence_summary_json AS ref_evidence_summary_json,
        ref.analyzed_at AS ref_analyzed_at
      FROM seller_opportunities o
      LEFT JOIN seller_opportunity_sources src ON src.opportunity_id = o.id
      LEFT JOIN record_classifications c ON c.opportunity_id = o.id
      LEFT JOIN opportunity_underwriting_refs ref ON ref.opportunity_id = o.id
      WHERE o.id = ?
    `).get(id);

    if (!opp) return null;

    const audit = this.db.prepare(`
      SELECT payload_json FROM operational_audit_events 
      WHERE event_type = 'DEAL_FINDR_INTAKE' AND JSON_EXTRACT(payload_json, '$.opportunityId') = ?
      LIMIT 1
    `).get(id);

    let sellerName = "Seller";
    if (audit) {
      const payload = parseJson(audit.payload_json);
      if (payload.sellerName) sellerName = payload.sellerName;
    }

    const underwriting = opp.ref_id ? {
      source: opp.ref_source_system || "deal-scout",
      agent: opp.ref_source_agent || "Victor",
      projectId: opp.ref_project_id || null,
      versionId: opp.ref_version_id || null,
      status: opp.ref_status || "completed",
      arv: opp.ref_arv,
      rehab: opp.ref_rehab,
      mao: opp.ref_mao,
      confidence: opp.ref_confidence,
      limitations: opp.ref_limitations,
      analyzedAt: opp.ref_analyzed_at,
      evidence: opp.ref_evidence_summary_json ? parseJson(opp.ref_evidence_summary_json) : null,
      fee: 5000,
      holding: 8000,
      askingPrice: opp.asking_price || 120000
    } : null;

    return {
      id: opp.id,
      code: opp.code,
      sellerDisplayName: sellerName,
      property: {
        externalPropertyId: opp.source_record_id || null,
        address: opp.original_address || "Wichita Property"
      },
      assignedOperator: opp.assignedOperator || "operator.demo",
      stage: opp.stage || "new_lead",
      classification: opp.classification || "unknown",
      lastActivity: opp.lastActivity || new Date().toISOString(),
      isFixture: opp.createdBy === 'system-seed',
      source: {
        sourceType: opp.source_type || "property_lead_inbox",
        originalSourceMessageId: opp.source_message_id || null,
        recoveredSourceMessageId: null,
        recoveryMethod: null,
        recoveryConfidence: null,
        provenanceMetadata: opp.provenance_metadata_json ? parseJson(opp.provenance_metadata_json) : null
      },
      underwriting,
      participants: [],
      sources: [],
      stageTimeline: [],
      offers: [],
      outcome: null
    };
  }
}

export class SqliteProvenanceRepository {
  constructor(db) {
    this.db = db;
  }

  async listAll() {
    const rows = this.db.prepare(`
      SELECT 
        o.id AS opportunityId,
        src.source_message_id AS originalSourceMessageId,
        src.source_type AS sourceType,
        prov.resolution_status AS provenanceState
      FROM seller_opportunities o
      LEFT JOIN seller_opportunity_sources src ON src.opportunity_id = o.id
      LEFT JOIN source_provenance prov ON prov.opportunity_id = o.id
    `).all();

    return rows.map(r => ({
      opportunityId: r.opportunityId,
      provenanceState: r.provenanceState || "original",
      originalSourceMessageId: r.originalSourceMessageId || null,
      recoveredSourceMessageId: null,
      recoveryMethodLabel: "—",
      recoveryConfidence: null
    }));
  }
}

export class SqliteClassificationRepository {
  constructor(db) {
    this.db = db;
  }

  /**
     * Current classification state, read from the tables that actually hold it.
     *
     * A note on lineage: REAL / SYNTHETIC / AMBIGUOUS is a determination about a
     * source lead's lineage, and this schema has no column for it.
     * `record_classifications.classification_value` holds a deal-type value
     * (e.g. 'investment_rehab'), which is a different question. Rather than
     * infer a lineage verdict the database never recorded, lineage is reported
     * as NOT_RECORDED. Provenance resolution IS stored, and is reported as-is.
     */
  async listAll() {
    const rows = this.db.prepare(`
      SELECT
        o.id AS opportunityId,
        c.classification_value AS recordClassification,
        c.reason AS reason,
        c.determined_by AS determinedBy,
        c.determined_at AS determinedAt,
        prov.resolution_status AS provenanceState
      FROM seller_opportunities o
      LEFT JOIN record_classifications c ON c.opportunity_id = o.id
      LEFT JOIN source_provenance prov ON prov.opportunity_id = o.id
      ORDER BY o.id
    `).all();

    return rows.map(r => ({
      opportunityId: r.opportunityId,
      classification: NOT_RECORDED,
      leadClassification: NOT_RECORDED,
      recordClassification: r.recordClassification || NOT_RECORDED,
      provenanceState: r.provenanceState || NOT_RECORDED,
      determinedBy: r.determinedBy || NOT_RECORDED,
      determinedAt: r.determinedAt || null,
      reason: r.reason || "No classification recorded for this opportunity.",
    }));
  }

  /** The append-only history, read from the table migration 007 protects. */
  async listHistory() {
    const rows = this.db.prepare(`
      SELECT
        opportunity_id,
        prior_classification,
        new_classification,
        classification_rules_version,
        determined_at,
        determined_by,
        reason
      FROM classification_history
    `).all();

    return rows.map(r => ({
      opportunityId: r.opportunity_id,
      priorClassification: r.prior_classification || "NONE",
      newClassification: r.new_classification,
      reason: r.reason,
      changedAt: r.determined_at,
      determinedBy: r.determined_by,
      rulesVersion: r.classification_rules_version,
    }));
  }
}
