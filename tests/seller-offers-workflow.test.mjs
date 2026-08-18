import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Seller Offers and Outreach Workflow: draft creation, state transitions, mock/production provider behavior, and immutability", async (t) => {
  const db = makeTempDb();
  // 1. Production Mode Startup (outreachProvider: "none" / default)
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "empty", outreachProvider: "none" }));
  t.after(() => { app.close(); db.cleanup(); });

  const sqlite = await import("node:sqlite");
  const conn = new sqlite.DatabaseSync(db.dbPath);

  // Seed opportunities, underwriting refs, opportunity sources, and provenance records
  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_3d9274ef0cb9', 'OPP-197067', 'new_lead', 'active', 'deal-findr', 'prop-197067', 80000)
  `).run();

  conn.prepare(`
    INSERT INTO seller_opportunity_sources (
      id, opportunity_id, source_type, source_message_id, original_address, conversion_actor, source_timestamp, conversion_timestamp
    ) VALUES ('src_3d9274ef0cb9', 'opp_3d9274ef0cb9', 'deal_scout_handoff', 'MSG-ID-ROANOKE', '1807 Roanoke St', 'deal-findr', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')
  `).run();

  conn.prepare(`
    INSERT INTO source_provenance (
      id, opportunity_id, original_source_json, resolution_status
    ) VALUES ('prov_3d9274ef0cb9', 'opp_3d9274ef0cb9', '{"source":"deal-findr","apn":"APN-ROANOKE-999"}', 'original_resolved')
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref_3d9274ef0cb9', 'opp_3d9274ef0cb9', 'deal-scout', 'Victor', 'opp_3d9274ef0cb9', 'analysis-123', '1', 'completed', 159566.69, 26000.0, 93675.02, 0.90, 'Solid comps', '{"comps":[{"address":"1824 S Roanoke St","salePrice":162000}]}', '2026-08-18T00:00:00Z')
  `).run();

  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_e7902d13ddba', 'OPP-197068', 'new_lead', 'active', 'deal-findr', 'prop-197068', 99900)
  `).run();

  conn.prepare(`
    INSERT INTO seller_opportunity_sources (
      id, opportunity_id, source_type, source_message_id, original_address, conversion_actor, source_timestamp, conversion_timestamp
    ) VALUES ('src_e7902d13ddba', 'opp_e7902d13ddba', 'deal_scout_handoff', 'MSG-ID-HIRAM', '1844 S Hiram Ave', 'deal-findr', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')
  `).run();

  conn.prepare(`
    INSERT INTO source_provenance (
      id, opportunity_id, original_source_json, resolution_status
    ) VALUES ('prov_e7902d13ddba', 'opp_e7902d13ddba', '{"source":"deal-findr","apn":"APN-HIRAM-111"}', 'original_resolved')
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref_e7902d13ddba', 'opp_e7902d13ddba', 'deal-scout', 'Victor', 'opp_e7902d13ddba', 'analysis-456', '1', 'completed', 184093.80, 28000.0, 110070.35, 0.85, 'Deferred maint', '{"comps":[]}', '2026-08-18T00:00:00Z')
  `).run();

  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_bad', 'OPP-197069', 'new_lead', 'active', 'deal-findr', 'prop-197069', 120000)
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref_bad', 'opp_bad', 'deal-scout', 'Victor', 'opp_bad', 'analysis-789', '1', 'insufficient_evidence', 0, 0, 0, 0.0, 'No comps', '{}', '2026-08-18T00:00:00Z')
  `).run();

  // Opportunity with missing limitations
  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_bad_lim', 'OPP-197070', 'new_lead', 'active', 'deal-findr', 'prop-197070', 85000)
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref_bad_lim', 'opp_bad_lim', 'deal-scout', 'Victor', 'opp_bad_lim', 'analysis-999', '1', 'completed', 150000, 20000, 90000, 0.90, NULL, '{}', '2026-08-18T00:00:00Z')
  `).run();

  // 1. Propose draft offer preparation succeeding with explicitly passed terms
  const resPrep = await fetch(`${baseUrl}/api/v1/operator/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      opportunityId: "opp_3d9274ef0cb9",
      proposedPrice: 90000,
      strategyType: "cash_purchase",
      earnestMoney: 1000,
      inspectionDays: 10,
      closingDays: 30
    })
  });
  assert.equal(resPrep.status, 201);
  const bodyPrep = await resPrep.json();
  const offer = bodyPrep.data.offer;

  // Approve offer
  const resApprove = await fetch(`${baseUrl}/api/v1/operator/offers/${offer.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  assert.equal(resApprove.status, 200);

  // 2. Test that missing contact details blocks outreach (currently no participant seeded)
  const resOutreachBadContact = await fetch(`${baseUrl}/api/v1/operator/outreach/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      opportunityId: "opp_3d9274ef0cb9",
      offerVersionId: offer.activeVersionId,
      recipientPersonId: "p_shon",
      recipientValueSnapshot: "shon.campbell@apexcap.com",
      recipientChannel: "email",
      contentText: "This draft should fail because contact is missing"
    })
  });
  assert.equal(resOutreachBadContact.status, 500); // throws repository error

  // Seed canonical contact tables to allow resolution
  conn.prepare(`
    INSERT INTO pipeline_contacts (id, first_name, last_name, email, phone)
    VALUES ('p_shon', 'Shon', 'Campbell', 'shon.campbell@apexcap.com', '(316) 555-0199')
  `).run();

  conn.prepare(`
    INSERT INTO seller_opportunity_participants (id, opportunity_id, ocg_one_person_id, participant_role, is_primary, verification_status, created_by)
    VALUES ('part_3d9274ef0cb9', 'opp_3d9274ef0cb9', 'p_shon', 'primary_owner', 1, 'SOURCE_SUPPLIED', 'deal-findr')
  `).run();

  // 3. Create Draft outreach message (should succeed now)
  const resOutreachDraft = await fetch(`${baseUrl}/api/v1/operator/outreach/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      opportunityId: "opp_3d9274ef0cb9",
      offerVersionId: offer.activeVersionId,
      recipientPersonId: "p_shon",
      recipientValueSnapshot: "shon.campbell@apexcap.com",
      recipientChannel: "email",
      contentText: "Hello Shon, this is our offer of $90,000 for Roanoke St."
    })
  });
  assert.equal(resOutreachDraft.status, 201);
  const bodyOutreach = await resOutreachDraft.json();
  const comm = bodyOutreach.data.communication;
  assert.equal(comm.status, "drafted");
  assert.equal(comm.contentText, "Hello Shon, this is our offer of $90,000 for Roanoke St.");

  // Verify that draft does not mark offer presented
  const resCheckOffer1 = await fetch(`${baseUrl}/api/v1/opportunities/opp_3d9274ef0cb9`);
  const bodyCheck1 = await resCheckOffer1.json();
  assert.equal(bodyCheck1.data.offers[0].status, "approved");

  // 4. Test legal transition enforcement: cannot send without authorization
  const resSendNoAuth = await fetch(`${baseUrl}/api/v1/operator/outreach/${comm.id}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(resSendNoAuth.status, 500); // invalid transition drafted -> send_attempted is illegal

  // 5. Authorize the outreach message
  const resAuthorize = await fetch(`${baseUrl}/api/v1/operator/outreach/${comm.id}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(resAuthorize.status, 200);
  const bodyAuth = await resAuthorize.json();
  assert.equal(bodyAuth.data.communication.status, "authorized");

  // Verify authorization alone does not send
  const resCheckOffer2 = await fetch(`${baseUrl}/api/v1/opportunities/opp_3d9274ef0cb9`);
  const bodyCheck2 = await resCheckOffer2.json();
  assert.equal(bodyCheck2.data.offers[0].status, "approved");

  // 6. Attempt send in production (outreachProvider = 'none')
  const resSendNone = await fetch(`${baseUrl}/api/v1/operator/outreach/${comm.id}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(resSendNone.status, 200);
  const bodySendNone = await resSendNone.json();
  const commFailed = bodySendNone.data.communication;
  assert.equal(commFailed.status, "failed");
  assert.ok(commFailed.events.some(e => e.eventType === "failed" && e.outcome === "CHANNEL_NOT_CONFIGURED"));

  // Verify failed send leaves offer approved/unpresented
  const resCheckOffer3 = await fetch(`${baseUrl}/api/v1/opportunities/opp_3d9274ef0cb9`);
  const bodyCheck3 = await resCheckOffer3.json();
  assert.equal(bodyCheck3.data.offers[0].status, "approved");
  assert.notEqual(bodyCheck3.data.stage, "offer_presented");

  // 7. Verify database immutability triggers (UPDATE and DELETE block)
  assert.throws(() => {
    conn.prepare("UPDATE seller_communications SET content_text = 'Changed' WHERE id = ?").run(comm.id);
  }, /Updating seller_communications is prohibited/);

  assert.throws(() => {
    conn.prepare("DELETE FROM seller_communications WHERE id = ?").run(comm.id);
  }, /Deleting seller_communications is prohibited/);

  const eventId = commFailed.events[0].id;
  assert.throws(() => {
    conn.prepare("UPDATE seller_communication_events SET event_type = 'sent' WHERE id = ?").run(eventId);
  }, /Updating seller_communication_events is prohibited/);

  assert.throws(() => {
    conn.prepare("DELETE FROM seller_communication_events WHERE id = ?").run(eventId);
  }, /Deleting seller_communication_events is prohibited/);

  conn.close();
  app.close();

  // 8. Boot app with outreachProvider: "mock" (Test-only adapter mode)
  const dbMock = makeTempDb();
  const appMock = await startApp(createApp, testConfig(dbMock.dbPath, { dataSource: "empty", outreachProvider: "mock" }));
  t.after(() => { appMock.app.close(); dbMock.cleanup(); });

  const connMock = new sqlite.DatabaseSync(dbMock.dbPath);

  // Seed needed records for Roanoke in mock database
  connMock.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_3d9274ef0cb9', 'OPP-197067', 'new_lead', 'active', 'deal-findr', 'prop-197067', 80000)
  `).run();

  connMock.prepare(`
    INSERT INTO seller_opportunity_sources (
      id, opportunity_id, source_type, source_message_id, original_address, conversion_actor, source_timestamp, conversion_timestamp
    ) VALUES ('src_3d9274ef0cb9', 'opp_3d9274ef0cb9', 'deal_scout_handoff', 'MSG-ID-ROANOKE', '1807 Roanoke St', 'deal-findr', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')
  `).run();

  connMock.prepare(`
    INSERT INTO source_provenance (
      id, opportunity_id, original_source_json, resolution_status
    ) VALUES ('prov_3d9274ef0cb9', 'opp_3d9274ef0cb9', '{"source":"deal-findr","apn":"APN-ROANOKE-999"}', 'original_resolved')
  `).run();

  connMock.prepare(`
    INSERT INTO pipeline_contacts (id, first_name, last_name, email, phone)
    VALUES ('p_shon', 'Shon', 'Campbell', 'shon.campbell@apexcap.com', '(316) 555-0199')
  `).run();

  connMock.prepare(`
    INSERT INTO seller_opportunity_participants (id, opportunity_id, ocg_one_person_id, participant_role, is_primary, verification_status, created_by)
    VALUES ('part_3d9274ef0cb9', 'opp_3d9274ef0cb9', 'p_shon', 'primary_owner', 1, 'SOURCE_SUPPLIED', 'deal-findr')
  `).run();

  connMock.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref_3d9274ef0cb9', 'opp_3d9274ef0cb9', 'deal-scout', 'Victor', 'opp_3d9274ef0cb9', 'analysis-123', '1', 'completed', 159566.69, 26000.0, 93675.02, 0.90, 'Solid comps', '{"comps":[{"address":"1824 S Roanoke St","salePrice":162000}]}', '2026-08-18T00:00:00Z')
  `).run();

  // Create and approve offer in mock
  const resPrepMock = await fetch(`${appMock.baseUrl}/api/v1/operator/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      opportunityId: "opp_3d9274ef0cb9",
      proposedPrice: 90000,
      strategyType: "cash_purchase",
      earnestMoney: 1000,
      inspectionDays: 10,
      closingDays: 30
    })
  });
  const bodyPrepMock = await resPrepMock.json();
  const offerMock = bodyPrepMock.data.offer;

  await fetch(`${appMock.baseUrl}/api/v1/operator/offers/${offerMock.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });

  // Create outreach draft in mock
  const resDraftMock = await fetch(`${appMock.baseUrl}/api/v1/operator/outreach/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      opportunityId: "opp_3d9274ef0cb9",
      offerVersionId: offerMock.activeVersionId,
      recipientPersonId: "p_shon",
      recipientValueSnapshot: "shon.campbell@apexcap.com",
      recipientChannel: "email",
      contentText: "Mock outbound message"
    })
  });
  const bodyDraftMock = await resDraftMock.json();
  const commMock = bodyDraftMock.data.communication;

  // Authorize draft in mock
  await fetch(`${appMock.baseUrl}/api/v1/operator/outreach/${commMock.id}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });

  // Send draft in mock (outreachProvider = 'mock')
  const resSendMock = await fetch(`${appMock.baseUrl}/api/v1/operator/outreach/${commMock.id}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(resSendMock.status, 200);
  const bodySendMock = await resSendMock.json();
  const commMockSent = bodySendMock.data.communication;
  // Derived status should be delivered (which is the latest event)
  assert.equal(commMockSent.status, "delivered");
  
  // Assert sent and delivered events remain distinct
  const eventTypes = commMockSent.events.map(e => e.eventType);
  assert.ok(eventTypes.includes("sent"));
  assert.ok(eventTypes.includes("delivered"));

  // Verify mock provider success transactionally links offer version and marks it presented
  const resCheckMockOffer = await fetch(`${appMock.baseUrl}/api/v1/opportunities/opp_3d9274ef0cb9`);
  const bodyCheckMock = await resCheckMockOffer.json();
  assert.equal(bodyCheckMock.data.offers[0].status, "presented");
  assert.equal(bodyCheckMock.data.stage, "offer_presented");

  // 9. Test inbound reply creates separate communication artifact and received event
  const resReply = await fetch(`${appMock.baseUrl}/api/v1/operator/outreach/inbound`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      opportunityId: "opp_3d9274ef0cb9",
      recipientPersonId: "p_shon",
      recipientValueSnapshot: "shon.campbell@apexcap.com",
      recipientChannel: "email",
      contentText: "Yes, I accept your offer.",
      inReplyToCommunicationId: commMock.id
    })
  });
  assert.equal(resReply.status, 201);
  const bodyReply = await resReply.json();
  const inboundComm = bodyReply.data.communication;
  assert.equal(inboundComm.direction, "inbound");
  assert.equal(inboundComm.status, "received");
  assert.equal(inboundComm.inReplyToCommunicationId, commMock.id);

  // Outbound communication remains untouched in status/events
  const resQueryOutbound = await fetch(`${appMock.baseUrl}/api/v1/opportunities/opp_3d9274ef0cb9`);
  const bodyQueryOutbound = await resQueryOutbound.json();
  const outboundComm = bodyQueryOutbound.data.communications.find(c => c.id === commMock.id);
  assert.equal(outboundComm.status, "delivered");

  // 10. Verify Piper outreachStatus chatbot matching and correctness
  const resPiper = await fetch(`${appMock.baseUrl}/api/v1/piper/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "Did we contact the seller?",
      activeOpportunityId: "opp_3d9274ef0cb9"
    })
  });
  assert.equal(resPiper.status, 200);
  const bodyPiper = await resPiper.json();
  assert.match(bodyPiper.data.answer, /DID WE CONTACT THE SELLER: YES/i);
  assert.match(bodyPiper.data.answer, /WHAT WE SENT: Sent via email: "Mock outbound message"/i);
  assert.match(bodyPiper.data.answer, /DID THEY RESPOND: The seller replied via email: "Yes, I accept your offer."/i);

  connMock.close();
});
