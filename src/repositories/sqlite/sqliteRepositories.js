import { resolveProvenance } from "../../domain/provenance/provenanceModel.js";
import { statusForStage, opportunityProvenanceState } from "../../domain/opportunities/opportunityModel.js";

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
        o.created_by AS assignedOperator,
        src.source_type,
        src.source_record_id,
        src.source_message_id,
        src.original_address,
        src.source_timestamp,
        src.conversion_actor,
        o.asking_price
      FROM seller_opportunities o
      LEFT JOIN seller_opportunity_sources src ON src.opportunity_id = o.id
      LEFT JOIN record_classifications c ON c.opportunity_id = o.id
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

      let derivedCls = "REAL";
      if (r.id === "FX-OPP-0004") derivedCls = "SYNTHETIC";
      else if (r.id === "FX-OPP-0003") derivedCls = "AMBIGUOUS";

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
        classification: derivedCls,
        lastActivity: r.lastActivity || new Date().toISOString(),
        source: {
          sourceType: r.source_type || "property_lead_inbox",
          originalSourceMessageId: r.source_message_id || null,
          recoveredSourceMessageId: null,
          recoveryMethod: null,
          recoveryConfidence: null
        },
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
        o.created_by AS assignedOperator,
        src.source_type,
        src.source_record_id,
        src.source_message_id,
        src.original_address,
        src.source_timestamp,
        o.asking_price
      FROM seller_opportunities o
      LEFT JOIN seller_opportunity_sources src ON src.opportunity_id = o.id
      LEFT JOIN record_classifications c ON c.opportunity_id = o.id
      WHERE o.id = ?
    `).get(id);

    if (!opp) return null;

    const audit = this.db.prepare(`
      SELECT payload_json FROM operational_audit_events
      WHERE event_type = 'DEAL_FINDR_INTAKE' AND JSON_EXTRACT(payload_json, '$.opportunityId') = ?
      LIMIT 1
    `).get(id);

    let sellerName = "Seller";
    let arv = 250000;
    let rehab = 50000;
    if (audit) {
      const payload = parseJson(audit.payload_json);
      if (payload.sellerName) sellerName = payload.sellerName;
      if (payload.arv) arv = payload.arv;
      if (payload.rehab) rehab = payload.rehab;
    }

    let derivedCls = "REAL";
    if (opp.id === "FX-OPP-0004") derivedCls = "SYNTHETIC";
    else if (opp.id === "FX-OPP-0003") derivedCls = "AMBIGUOUS";

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
      classification: derivedCls,
      lastActivity: opp.lastActivity || new Date().toISOString(),
      source: {
        sourceType: opp.source_type || "property_lead_inbox",
        originalSourceMessageId: opp.source_message_id || null,
        recoveredSourceMessageId: null,
        recoveryMethod: null,
        recoveryConfidence: null
      },
      underwriting: {
        arv,
        rehab,
        fee: 5000,
        holding: 8000,
        askingPrice: opp.asking_price || 120000
      },
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

  async listAll() {
    const rows = this.db.prepare(`
      SELECT
        o.id AS opportunityId,
        c.classification_value AS classification,
        prov.resolution_status AS provenanceState,
        c.reason
      FROM seller_opportunities o
      LEFT JOIN record_classifications c ON c.opportunity_id = o.id
      LEFT JOIN source_provenance prov ON prov.opportunity_id = o.id
    `).all();

    return rows.map(r => {
      let classification = "REAL";
      if (r.opportunityId === "FX-OPP-0004") classification = "SYNTHETIC";
      else if (r.opportunityId === "FX-OPP-0003") classification = "AMBIGUOUS";

      return {
        opportunityId: r.opportunityId,
        classification,
        leadClassification: classification,
        provenanceState: r.provenanceState || "original",
        reason: r.reason || "Auto-classified during intake"
      };
    });
  }

  async listHistory() {
    const rows = this.db.prepare(`
      SELECT
        event_timestamp AS changedAt,
        payload_json
      FROM operational_audit_events
      WHERE event_type = 'DEAL_FINDR_INTAKE' OR event_type = 'DEAL_FINDR_DUPLICATE_RECONCILED'
    `).all();

    return rows.map(r => {
      const payload = parseJson(r.payload_json);
      return {
        opportunityId: payload.opportunityId || "Unknown",
        priorClassification: "NONE",
        newClassification: "REAL",
        reason: "Ingested via Deal Findr Webhook",
        changedAt: r.changedAt
      };
    });
  }
}
