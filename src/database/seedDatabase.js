import { randomUUID } from "node:crypto";

export function seedDatabaseIfEmpty(db) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM seller_opportunities").get().count;
  if (count > 0) {
    return; // Already has data
  }

  console.log("Seeding standalone PIPELINE SQLite database with initial fixtures...");

  // Start a transaction
  db.exec("BEGIN TRANSACTION;");
  try {
    const opps = [
      {
        id: "FX-OPP-0001",
        code: "DEMO-OPP-0001",
        sellerName: "Ada Fixtureton",
        address: "100 Placeholder Lane, Sampleton",
        askingPrice: 120000,
        arv: 250000,
        rehab: 50000,
        stage: "negotiating",
        classification: "REAL",
        provenance: "original_resolved",
        sourceMsgId: "DEMO-MSG-0001"
      },
      {
        id: "FX-OPP-0002",
        code: "DEMO-OPP-0002",
        sellerName: "Ben Sampleman",
        address: "200 Example Court, Sampleton",
        askingPrice: 110000,
        arv: 240000,
        rehab: 45000,
        stage: "contacted",
        classification: "REAL",
        provenance: "recovered_resolved",
        sourceMsgId: "DEMO-MSG-0002"
      },
      {
        id: "FX-OPP-0003",
        code: "DEMO-OPP-0003",
        sellerName: "Cora Demarco",
        address: "300 Demo Ridge, Sampleton",
        askingPrice: 140000,
        arv: 280000,
        rehab: 60000,
        stage: "qualified",
        classification: "AMBIGUOUS",
        provenance: "unresolved",
        sourceMsgId: null
      },
      {
        id: "FX-OPP-0004",
        code: "DEMO-OPP-0004",
        sellerName: "Test Synthetic Dolan",
        address: "400 Synthetic Way, Sampleton",
        askingPrice: 90000,
        arv: 180000,
        rehab: 30000,
        stage: "lost",
        classification: "SYNTHETIC",
        provenance: "original_resolved",
        sourceMsgId: "DEMO-MSG-0004"
      }
    ];

    for (const o of opps) {
      // 1. Insert seller_opportunities
      db.prepare(`
        INSERT INTO seller_opportunities (
          id, tenant_id, opportunity_code, ocg_one_property_id, pipeline_stage,
          qualification_status, contact_status, opportunity_status, data_quality_status,
          asking_price, property_condition_summary, created_by, updated_by
        ) VALUES (?, 'ocg-one', ?, ?, ?, 'needs_review', 'uncontacted', 'active', 'raw_ingestion', ?, ?, 'system-seed', 'system-seed')
      `).run(o.id, o.code, "seed-prop-" + o.id, o.stage, o.askingPrice, "Initial seeded fixture opportunity");

      // 2. Insert seller_opportunity_sources
      db.prepare(`
        INSERT INTO seller_opportunity_sources (
          id, opportunity_id, source_type, source_record_id, source_message_id,
          original_address, source_timestamp, conversion_actor
        ) VALUES (?, ?, 'property_lead_inbox', ?, ?, ?, ?, 'system-seed')
      `).run(randomUUID(), o.id, "seed-prop-" + o.id, o.sourceMsgId, o.address, new Date().toISOString());

      // 3. Insert source_provenance
      db.prepare(`
        INSERT INTO source_provenance (
          id, opportunity_id, original_source_json, resolution_status
        ) VALUES (?, ?, ?, ?)
      `).run(randomUUID(), o.id, JSON.stringify({ source: "lead_inbox", seller: o.sellerName }), o.provenance);

      // 4. Insert record_classifications
      db.prepare(`
        INSERT INTO record_classifications (
          opportunity_id, classification_value, classification_rules_version, determined_by, reason
        ) VALUES (?, 'investment_rehab', '1.0.0', 'system-seed', 'Auto-classified during seeding')
      `).run(o.id);

      // 5. Log audit event
      db.prepare(`
        INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, payload_json, correlation_id)
        VALUES (?, ?, 'DEAL_FINDR_INTAKE', 'system-seed', ?, ?)
      `).run(
        randomUUID(),
        new Date().toISOString(),
        JSON.stringify({ opportunityId: o.id, sellerName: o.sellerName, address: o.address, askingPrice: o.askingPrice, arv: o.arv, rehab: o.rehab }),
        randomUUID()
      );
    }

    db.exec("COMMIT;");
    console.log("Database seeded successfully with 4 fixtures.");
  } catch (err) {
    db.exec("ROLLBACK;");
    console.error("Database seeding failed:", err);
  }
}
