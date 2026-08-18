/**
 * Operator state — the one place PIPELINE accepts operator input.
 *
 * Everything here was previously browser localStorage: invisible to teammates,
 * lost when site data was cleared, and absent from every API response. It is
 * now stored server-side so it survives, and so Piper can reason over it.
 *
 * Stage is deliberately NOT writable here. Stage remains owned by the systems
 * of record; the old client-side stage override silently outranked the server's
 * value in list and funnel counts, which is exactly the confusion this replaces.
 */

import { randomUUID } from "node:crypto";

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export class SqliteOperatorRepository {
  constructor(db, config = {}) {
    this.db = db;
    this.config = config;
  }

  // --- next actions --------------------------------------------------------

  listNextActions(opportunityId = null) {
    const sql = opportunityId
      ? `SELECT * FROM operator_next_actions WHERE opportunity_id = ? ORDER BY
           CASE status WHEN 'open' THEN 0 ELSE 1 END,
           COALESCE(due_date, '9999'), created_at`
      : `SELECT * FROM operator_next_actions ORDER BY
           CASE status WHEN 'open' THEN 0 ELSE 1 END,
           COALESCE(due_date, '9999'), created_at`;
    const rows = opportunityId
      ? this.db.prepare(sql).all(opportunityId)
      : this.db.prepare(sql).all();
    return rows.map(toNextAction);
  }

  createNextAction({ opportunityId, title, details = null, dueDate = null, actor }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO operator_next_actions (id, opportunity_id, title, details, due_date, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(id, opportunityId, title, details, dueDate, actor);
    return toNextAction(this.db.prepare("SELECT * FROM operator_next_actions WHERE id = ?").get(id));
  }

  completeNextAction({ id, actor, status = "done" }) {
    const existing = this.db.prepare("SELECT * FROM operator_next_actions WHERE id = ?").get(id);
    if (!existing) return null;
    this.db.prepare(`
      UPDATE operator_next_actions
      SET status = ?, completed_at = ?, completed_by = ?
      WHERE id = ?
    `).run(status, status === "open" ? null : now(), status === "open" ? null : actor, id);
    return toNextAction(this.db.prepare("SELECT * FROM operator_next_actions WHERE id = ?").get(id));
  }

  // --- notes ---------------------------------------------------------------

  listNotes(opportunityId) {
    return this.db
      .prepare("SELECT * FROM operator_notes WHERE opportunity_id = ? ORDER BY created_at DESC")
      .all(opportunityId)
      .map((r) => ({ id: r.id, opportunityId: r.opportunity_id, body: r.body, createdBy: r.created_by, createdAt: r.created_at }));
  }

  createNote({ opportunityId, body, actor }) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO operator_notes (id, opportunity_id, body, created_by) VALUES (?, ?, ?, ?)")
      .run(id, opportunityId, body, actor);
    const r = this.db.prepare("SELECT * FROM operator_notes WHERE id = ?").get(id);
    return { id: r.id, opportunityId: r.opportunity_id, body: r.body, createdBy: r.created_by, createdAt: r.created_at };
  }

  // --- checklist -----------------------------------------------------------

  listChecklist(opportunityId) {
    return this.db
      .prepare("SELECT * FROM operator_checklist_items WHERE opportunity_id = ? ORDER BY item_key")
      .all(opportunityId)
      .map((r) => ({
        id: r.id,
        opportunityId: r.opportunity_id,
        key: r.item_key,
        label: r.label,
        checked: r.is_checked === 1,
        updatedBy: r.updated_by,
        updatedAt: r.updated_at,
      }));
  }

  setChecklistItem({ opportunityId, key, label, checked, actor }) {
    this.db.prepare(`
      INSERT INTO operator_checklist_items (id, opportunity_id, item_key, label, is_checked, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (opportunity_id, item_key) DO UPDATE SET
        is_checked = excluded.is_checked,
        label      = excluded.label,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(randomUUID(), opportunityId, key, label, checked ? 1 : 0, actor, now());
    return this.listChecklist(opportunityId).find((i) => i.key === key) || null;
  }

  // --- interactions (call / activity log) ----------------------------------
  // Uses seller_interactions from migration 003 rather than a parallel table.

  listInteractions(opportunityId) {
    return this.db
      .prepare("SELECT * FROM seller_interactions WHERE opportunity_id = ? ORDER BY occurred_at DESC")
      .all(opportunityId)
      .map((r) => ({
        id: r.id,
        opportunityId: r.opportunity_id,
        channel: r.channel,
        direction: r.direction,
        occurredAt: r.occurred_at,
        outcome: r.outcome,
        summary: r.summary,
        createdBy: r.created_by,
      }));
  }

  createInteraction({ opportunityId, channel, direction, summary, outcome = null, occurredAt = null, actor }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO seller_interactions
        (id, opportunity_id, channel, direction, occurred_at, outcome, summary, visibility_classification, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'internal', ?)
    `).run(id, opportunityId, channel, direction, occurredAt || now(), outcome, summary, actor);
    return this.listInteractions(opportunityId).find((i) => i.id === id) || null;
  }

  // --- offers -------------------------------------------------------------

  listOffers(opportunityId) {
    const offers = this.db.prepare("SELECT * FROM seller_offers WHERE opportunity_id = ? ORDER BY created_at DESC").all(opportunityId);
    return offers.map(o => {
      const versions = this.db.prepare("SELECT * FROM seller_offer_versions WHERE offer_id = ? ORDER BY version_number DESC").all(o.id);
      return {
        id: o.id,
        opportunityId: o.opportunity_id,
        currentVersion: o.current_version,
        status: o.status,
        activeVersionId: o.active_version_id,
        createdBy: o.created_by,
        createdAt: o.created_at,
        updatedAt: o.updated_at,
        versions: versions.map(v => ({
          id: v.id,
          offerId: v.offer_id,
          versionNumber: v.version_number,
          versionStatus: v.version_status,
          strategyType: v.strategy_type,
          purchasePrice: v.purchase_price,
          earnestMoney: v.earnest_money,
          inspectionDays: v.inspection_days,
          closingDays: v.closing_days,
          expirationAt: v.expiration_at,
          contingenciesJson: v.contingencies_json,
          sellerFacingTerms: v.seller_facing_terms,
          internalNotes: v.internal_notes,
          underwritingSourceType: v.underwriting_source_type,
          underwritingSourceId: v.underwriting_source_id,
          underwritingVersionId: v.underwriting_version_id,
          underwritingArvSnapshot: v.underwriting_arv_snapshot,
          underwritingRehabSnapshot: v.underwriting_rehab_snapshot,
          underwritingMaoSnapshot: v.underwriting_mao_snapshot,
          underwritingConfidence: v.underwriting_confidence,
          underwritingLimitations: v.underwriting_limitations,
          underwritingTimestamp: v.underwriting_timestamp,
          ocgOneApprovalId: v.ocg_one_approval_id,
          createdBy: v.created_by,
          createdAt: v.created_at,
          supersededBy: v.superseded_by
        }))
      };
    });
  }

  prepareOffer({ opportunityId, proposedPrice, strategyType, earnestMoney, inspectionDays, closingDays, contingencies, internalNotes, actor }) {
    if (proposedPrice === undefined || proposedPrice === null) throw new Error("proposedPrice is required");
    if (!strategyType) throw new Error("strategyType is required");
    if (earnestMoney === undefined || earnestMoney === null) throw new Error("earnestMoney is required");
    if (inspectionDays === undefined || inspectionDays === null) throw new Error("inspectionDays is required");
    if (closingDays === undefined || closingDays === null) throw new Error("closingDays is required");

    const opp = this.db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(opportunityId);
    if (!opp) throw new Error("opportunity_not_found");

    const uw = this.db.prepare("SELECT * FROM opportunity_underwriting_refs WHERE opportunity_id = ?").get(opportunityId);
    if (!uw) throw new Error("underwriting_not_found");

    const strategy = strategyType;
    const price = proposedPrice;
    const em = earnestMoney;
    const insp = inspectionDays;
    const cls = closingDays;
    const cont = contingencies || JSON.stringify(["Subject to satisfactory inspection of major systems"]);
    const notes = internalNotes || "Initial draft prepared by operator via Victor underwriting recommendation.";

    let offer = this.db.prepare("SELECT * FROM seller_offers WHERE opportunity_id = ?").get(opportunityId);
    let offerId;
    let nextVersionNumber = 1;

    if (offer) {
      offerId = offer.id;
      const maxVer = this.db.prepare("SELECT MAX(version_number) max_v FROM seller_offer_versions WHERE offer_id = ?").get(offerId);
      nextVersionNumber = (maxVer ? maxVer.max_v : 0) + 1;
    } else {
      offerId = "off_" + opportunityId.substring(4);
      this.db.prepare(`
        INSERT INTO seller_offers (id, opportunity_id, current_version, status, active_version_id, created_by)
        VALUES (?, ?, 1, 'draft', null, ?)
      `).run(offerId, opportunityId, actor);
    }

    const versionId = "ver_" + offerId.substring(4) + "_" + nextVersionNumber;

    this.db.prepare(`
      INSERT INTO seller_offer_versions (
        id, offer_id, version_number, version_status, strategy_type, purchase_price,
        earnest_money, inspection_days, closing_days, contingencies_json, internal_notes,
        underwriting_source_type, underwriting_source_id, underwriting_version_id,
        underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot,
        underwriting_confidence, underwriting_limitations, underwriting_timestamp, created_by
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionId, offerId, nextVersionNumber, strategy, price, em, insp, cls,
      typeof cont === "string" ? cont : JSON.stringify(cont), notes,
      uw.source_system === "deal-scout" ? "victor_analysis" : "deal_scout_project",
      uw.source_underwriting_id || "unknown", uw.source_version_id || "1",
      uw.arv || 0, uw.rehab || 0, uw.mao || 0, uw.confidence || 0, uw.limitations || "",
      uw.analyzed_at || now(), actor
    );

    this.db.prepare(`
      UPDATE seller_offers
      SET active_version_id = ?, current_version = ?
      WHERE id = ?
    `).run(versionId, nextVersionNumber, offerId);

    return this.listOffers(opportunityId).find(o => o.id === offerId);
  }

  decideOffer({ offerId, action, proposedPrice, strategyType, earnestMoney, inspectionDays, closingDays, contingencies, internalNotes, actor }) {
    const offer = this.db.prepare("SELECT * FROM seller_offers WHERE id = ?").get(offerId);
    if (!offer) throw new Error("offer_not_found");

    const currentVer = this.db.prepare("SELECT * FROM seller_offer_versions WHERE id = ?").get(offer.active_version_id);
    if (!currentVer) throw new Error("active_version_not_found");

    if (action === "approve") {
      this.db.prepare("UPDATE seller_offers SET status = 'approved', updated_at = ? WHERE id = ?").run(now(), offerId);
      this.db.prepare("UPDATE seller_offer_versions SET version_status = 'approved' WHERE id = ?").run(offer.active_version_id);
    } else if (action === "decline") {
      this.db.prepare("UPDATE seller_offers SET status = 'rejected', updated_at = ? WHERE id = ?").run(now(), offerId);
      this.db.prepare("UPDATE seller_offer_versions SET version_status = 'rejected' WHERE id = ?").run(offer.active_version_id);
    } else if (action === "hold") {
      this.db.prepare("UPDATE seller_offers SET status = 'draft', updated_at = ? WHERE id = ?").run(now(), offerId);
      this.db.prepare("UPDATE seller_offer_versions SET version_status = 'draft' WHERE id = ?").run(offer.active_version_id);
    } else if (action === "modify") {
      const nextVerNum = offer.current_version + 1;
      const nextVerId = "ver_" + offerId.substring(4) + "_" + nextVerNum;

      const uw = this.db.prepare("SELECT * FROM opportunity_underwriting_refs WHERE opportunity_id = ?").get(offer.opportunity_id);
      if (!uw) throw new Error("underwriting_not_found");

      const strategy = strategyType !== undefined ? strategyType : currentVer.strategy_type;
      const price = proposedPrice !== undefined ? proposedPrice : currentVer.purchase_price;
      const em = earnestMoney !== undefined ? earnestMoney : currentVer.earnest_money;
      const insp = inspectionDays !== undefined ? inspectionDays : currentVer.inspection_days;
      const cls = closingDays !== undefined ? closingDays : currentVer.closing_days;
      const cont = contingencies !== undefined ? (typeof contingencies === "string" ? contingencies : JSON.stringify(contingencies)) : currentVer.contingencies_json;
      const notes = internalNotes !== undefined ? internalNotes : currentVer.internal_notes;

      this.db.prepare(`
        INSERT INTO seller_offer_versions (
          id, offer_id, version_number, version_status, strategy_type, purchase_price,
          earnest_money, inspection_days, closing_days, contingencies_json, internal_notes,
          underwriting_source_type, underwriting_source_id, underwriting_version_id,
          underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot,
          underwriting_confidence, underwriting_limitations, underwriting_timestamp, created_by
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nextVerId, offerId, nextVerNum, strategy, price, em, insp, cls, cont, notes,
        uw.source_system === "deal-scout" ? "victor_analysis" : "deal_scout_project",
        uw.source_underwriting_id || "unknown", uw.source_version_id || "1",
        uw.arv || 0, uw.rehab || 0, uw.mao || 0, uw.confidence || 0, uw.limitations || "",
        uw.analyzed_at || now(), actor
      );

      this.db.prepare("UPDATE seller_offer_versions SET superseded_by = ? WHERE id = ?").run(nextVerId, currentVer.id);

      this.db.prepare(`
        UPDATE seller_offers
        SET active_version_id = ?, current_version = ?, status = 'draft'
        WHERE id = ?
      `).run(nextVerId, nextVerNum, offerId);
    }

    return this.listOffers(offer.opportunity_id).find(o => o.id === offerId);
  }

  // --- seller communications & outreach ------------------------------------

  _getDerivedStatus(commId) {
    const event = this.db.prepare(`
      SELECT event_type FROM seller_communication_events 
      WHERE communication_id = ? 
      ORDER BY occurred_at DESC, rowid DESC LIMIT 1
    `).get(commId);
    return event ? event.event_type : null;
  }

  _validateTransition(currentStatus, nextEvent) {
    if (!currentStatus) {
      return ["drafted", "received"].includes(nextEvent);
    }
    if (currentStatus === "drafted") {
      return ["authorized", "canceled"].includes(nextEvent);
    }
    if (currentStatus === "authorized") {
      return ["send_attempted", "canceled"].includes(nextEvent);
    }
    if (currentStatus === "send_attempted") {
      return ["sent", "failed"].includes(nextEvent);
    }
    if (currentStatus === "sent") {
      return ["delivered", "failed"].includes(nextEvent);
    }
    if (currentStatus === "failed") {
      return ["send_attempted", "canceled"].includes(nextEvent);
    }
    return false;
  }

  _addCommunicationEvent(commId, eventType, actorId, providerRef = null, outcome = null, metadataJson = null) {
    const currentStatus = this._getDerivedStatus(commId);
    if (!this._validateTransition(currentStatus, eventType)) {
      throw new Error(`invalid_state_transition: Cannot transition from ${currentStatus || "none"} to ${eventType}`);
    }

    const id = randomUUID();
    const ts = now();
    this.db.prepare(`
      INSERT INTO seller_communication_events (id, communication_id, event_type, actor_id, provider_ref, outcome, metadata_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, commId, eventType, actorId, providerRef, outcome, metadataJson, ts);

    return {
      id,
      communicationId: commId,
      eventType,
      actorId,
      providerRef,
      outcome,
      metadata: metadataJson ? JSON.parse(metadataJson) : null,
      occurredAt: ts
    };
  }

  resolveContact(opportunityId) {
    const participant = this.db.prepare(`
      SELECT * FROM seller_opportunity_participants 
      WHERE opportunity_id = ? AND is_primary = 1
    `).get(opportunityId);
    
    if (!participant) {
      return { status: "MISSING", value: null, channel: null };
    }
    
    const contact = this.db.prepare(`
      SELECT * FROM pipeline_contacts WHERE id = ?
    `).get(participant.ocg_one_person_id);
    
    if (!contact) {
      return { status: "MISSING", value: null, channel: null };
    }
    
    const value = contact.email || contact.phone;
    const channel = contact.email ? "email" : (contact.phone ? "sms" : null);
    
    if (!value || !channel) {
      return { status: "MISSING", value: null, channel: null };
    }
    
    return {
      status: String(participant.verification_status || "SOURCE_SUPPLIED").toUpperCase(),
      personId: contact.id,
      displayName: `${contact.first_name} ${contact.last_name}`,
      value,
      channel,
      sourceType: participant.source_id ? "deal_scout_handoff" : "manual_entry",
      sourceId: participant.source_id || null
    };
  }

  createOutreachDraft({ opportunityId, offerVersionId = null, recipientPersonId, recipientValueSnapshot, recipientChannel, subject = null, contentText, templateVersion = null, actor }) {
    // 1. Resolve contact details and perform strict verification check
    const contact = this.resolveContact(opportunityId);
    if (contact.status === "MISSING" || !contact.value) {
      throw new Error("recipient_contact_required");
    }

    // Ensure snapshots match exactly
    if (contact.personId !== recipientPersonId || contact.value !== recipientValueSnapshot || contact.channel !== recipientChannel) {
      throw new Error("contact_value_mismatch");
    }

    // 2. If it is linked to an offer, check that the offer version is approved
    if (offerVersionId) {
      const ver = this.db.prepare(`
        SELECT * FROM seller_offer_versions WHERE id = ? AND version_status = 'approved'
      `).get(offerVersionId);
      if (!ver) {
        throw new Error("approved_offer_required");
      }
    }

    if (!contentText || !contentText.trim()) {
      throw new Error("missing_contentText");
    }

    const commId = randomUUID();
    const ts = now();

    // Start transaction for draft + event creation
    this.db.prepare("BEGIN TRANSACTION").run();
    try {
      this.db.prepare(`
        INSERT INTO seller_communications (
          id, opportunity_id, offer_version_id, recipient_person_id, recipient_value_snapshot, 
          recipient_channel, recipient_verification_status, recipient_source_type, recipient_source_id, 
          direction, subject, content_text, template_version, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?)
      `).run(
        commId, opportunityId, offerVersionId, contact.personId, contact.value,
        contact.channel, contact.status, contact.sourceType, contact.sourceId,
        subject, contentText, templateVersion, actor, ts
      );

      this.db.prepare(`
        INSERT INTO seller_communication_events (id, communication_id, event_type, actor_id, occurred_at)
        VALUES (?, ?, 'drafted', ?, ?)
      `).run(randomUUID(), commId, actor, ts);

      this.db.prepare("COMMIT").run();
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }

    return this.getCommunication(commId);
  }

  authorizeOutreach(commId, actor) {
    this._addCommunicationEvent(commId, "authorized", actor);
    return this.getCommunication(commId);
  }

  attemptSendOutreach(commId, actor) {
    const comm = this.db.prepare("SELECT * FROM seller_communications WHERE id = ?").get(commId);
    if (!comm) throw new Error("communication_not_found");

    this._addCommunicationEvent(comm.id, "send_attempted", actor);

    // Resolve provider purely server-side
    const provider = this.config.outreachProvider || "none";

    if (provider === "mock") {
      this.db.prepare("BEGIN TRANSACTION").run();
      try {
        this._addCommunicationEvent(comm.id, "sent", actor, "MOCK-REF-123");
        this._addCommunicationEvent(comm.id, "delivered", actor, "MOCK-REF-123");

        // Transactionally present offer if linked
        if (comm.offer_version_id) {
          // Update offer status
          this.db.prepare(`
            UPDATE seller_offers 
            SET status = 'presented', updated_at = ?
            WHERE id = (SELECT offer_id FROM seller_offer_versions WHERE id = ?)
          `).run(now(), comm.offer_version_id);

          // Update opportunity stage and presentation timestamp
          this.db.prepare(`
            UPDATE seller_opportunities
            SET pipeline_stage = 'offer_presented', offer_presented_at = ?, last_contacted_at = ?, contact_status = 'in_contact', updated_at = ?
            WHERE id = ?
          `).run(now(), now(), now(), comm.opportunity_id);

          // Add a timeline stage event
          this.db.prepare(`
            INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason, created_at)
            VALUES (?, ?, 'offer_preparation', 'offer_presented', ?, 'Offer presented to seller via outreach', ?)
          `).run(randomUUID(), comm.opportunity_id, actor, now());
        }

        this.db.prepare("COMMIT").run();
      } catch (err) {
        this.db.prepare("ROLLBACK").run();
        throw err;
      }
    } else {
      // Outbound attempt failed because provider is not configured
      this._addCommunicationEvent(comm.id, "failed", actor, null, "CHANNEL_NOT_CONFIGURED");
    }

    return this.getCommunication(comm.id);
  }

  receiveInboundCommunication({ opportunityId, recipientPersonId, recipientValueSnapshot, recipientChannel, subject = null, contentText, inReplyToCommunicationId = null, actor }) {
    if (!contentText || !contentText.trim()) {
      throw new Error("missing_contentText");
    }

    const commId = randomUUID();
    const ts = now();

    this.db.prepare("BEGIN TRANSACTION").run();
    try {
      this.db.prepare(`
        INSERT INTO seller_communications (
          id, opportunity_id, offer_version_id, recipient_person_id, recipient_value_snapshot, 
          recipient_channel, recipient_verification_status, direction, subject, content_text, 
          in_reply_to_communication_id, created_by, created_at
        ) VALUES (?, ?, NULL, ?, ?, ?, 'VERIFIED', 'inbound', ?, ?, ?, ?, ?)
      `).run(
        commId, opportunityId, recipientPersonId, recipientValueSnapshot,
        recipientChannel, subject, contentText, inReplyToCommunicationId, actor, ts
      );

      this.db.prepare(`
        INSERT INTO seller_communication_events (id, communication_id, event_type, actor_id, occurred_at)
        VALUES (?, ?, 'received', ?, ?)
      `).run(randomUUID(), commId, actor, ts);

      // If this is a reply to an outbound communication, update opportunity contact status and last contacted
      this.db.prepare(`
        UPDATE seller_opportunities
        SET last_contacted_at = ?, contact_status = 'in_contact', updated_at = ?
        WHERE id = ?
      `).run(ts, opportunityId);

      this.db.prepare("COMMIT").run();
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }

    return this.getCommunication(commId);
  }

  getCommunication(id) {
    const c = this.db.prepare("SELECT * FROM seller_communications WHERE id = ?").get(id);
    if (!c) return null;

    const events = this.db.prepare(`
      SELECT * FROM seller_communication_events WHERE communication_id = ? ORDER BY occurred_at ASC, rowid ASC
    `).all(id);

    const derivedStatus = events.length > 0 ? events[events.length - 1].event_type : "drafted";

    return {
      id: c.id,
      opportunityId: c.opportunity_id,
      offerVersionId: c.offer_version_id,
      recipientPersonId: c.recipient_person_id,
      recipientValueSnapshot: c.recipient_value_snapshot,
      recipientChannel: c.recipient_channel,
      recipientVerificationStatus: c.recipient_verification_status,
      recipientSourceType: c.recipient_source_type,
      recipientSourceId: c.recipient_source_id,
      direction: c.direction,
      subject: c.subject,
      contentText: c.content_text,
      templateVersion: c.template_version,
      inReplyToCommunicationId: c.in_reply_to_communication_id,
      createdBy: c.created_by,
      createdAt: c.created_at,
      status: derivedStatus,
      events: events.map(e => ({
        id: e.id,
        eventType: e.event_type,
        actorId: e.actor_id,
        providerRef: e.provider_ref,
        outcome: e.outcome,
        metadata: e.metadata_json ? JSON.parse(e.metadata_json) : null,
        occurredAt: e.occurred_at
      }))
    };
  }

  listCommunications(opportunityId) {
    const rows = this.db.prepare(`
      SELECT id FROM seller_communications WHERE opportunity_id = ? ORDER BY created_at DESC
    `).all(opportunityId);

    return rows.map(r => this.getCommunication(r.id));
  }
}

function toNextAction(r) {
  if (!r) return null;
  return {
    id: r.id,
    opportunityId: r.opportunity_id,
    title: r.title,
    details: r.details,
    dueDate: r.due_date,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}
