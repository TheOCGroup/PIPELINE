/**
 * Governed CRM mutation service — the PIPELINE server side of the chatbot
 * governed executor's CRM surface (S2 §3 contract; built in R1 §4).
 *
 * Four operations — stage, notes, update, contacts — executed under a
 * caller-supplied mutationKey (the chatbot governedOperationKey). Every
 * operation runs in ONE transaction that (1) answers a replayed mutationKey
 * from the stored receipt without re-executing, (2) executes the mutation
 * through the existing service paths / rules, (3) writes the audit row and
 * the crm_mutation_receipts row atomically with the mutation.
 *
 * Tenant is the deployment tenant only (normalizeTenantId of config); a
 * foreign opportunity id is indistinguishable from a nonexistent one (404
 * opportunity_not_found), exactly like every other PIPELINE surface.
 *
 * Reuse, not re-implementation:
 *  - stage: same stageModel vocabulary (STAGES / CLOSED_STAGES), same
 *    terminal-reopen rule, same status-by-stage mapping, same
 *    seller_stage_events + operational_audit_events writes as the operator
 *    route in http/routes/opportunityRoutes.js (handleStageMove).
 *  - notes: same append-only operator_notes insert as
 *    SqliteOperatorRepository.createNote (no update/delete path exists).
 *  - contacts: literally calls persistSellerContact (sellerContactService),
 *    preceded by the contract's upsert match on normalized phone/email
 *    within this opportunity's participants.
 *  - update: explicit allowlist only (assigned_acquisition_manager_id,
 *    opportunity_status) — no arbitrary column writes.
 */

import { randomUUID } from "node:crypto";
import { STAGES, CLOSED_STAGES } from "../domain/stages/stageModel.js";
import {
  isOpportunityInTenant,
  normalizeTenantId,
} from "../repositories/sqlite/tenantScope.js";
import { persistSellerContact } from "./sellerContactService.js";

export class CrmMutationError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Same mapping as handleStageMove (opportunity_status has its own CHECK
// vocabulary, distinct from stages).
const STATUS_BY_STAGE = {
  under_contract: "under_contract",
  closed: "closed_purchased",
  disqualified: "closed_disqualified",
  lost: "closed_lost",
  archived: "archived",
};

const OPPORTUNITY_STATUSES = new Set([
  "active",
  "on_hold",
  "pending_approval",
  "under_contract",
  "closed_purchased",
  "closed_disqualified",
  "closed_lost",
  "archived",
]);

// Public (chatbot-side) field name -> column. Anything not listed is refused.
const UPDATE_ALLOWLIST = new Map([
  ["assignedAcquisitionManagerId", "assigned_acquisition_manager_id"],
  ["opportunityStatus", "opportunity_status"],
]);

const now = () => new Date().toISOString();

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits || null;
}

function readback(db, opportunityId) {
  const r = db
    .prepare(
      `SELECT id, pipeline_stage, opportunity_status,
              assigned_acquisition_manager_id, updated_at
       FROM seller_opportunities WHERE id = ?`
    )
    .get(opportunityId);
  return {
    id: r.id,
    stage: r.pipeline_stage,
    status: r.opportunity_status,
    assignedOperator: r.assigned_acquisition_manager_id,
    updatedAt: r.updated_at,
  };
}

export function createCrmMutationService(db, tenantId) {
  const scopeTenantId = normalizeTenantId(tenantId);

  function audit(eventType, { opportunityId, mutationKey, actor, approvalId, payload }) {
    db.prepare(
      `INSERT INTO operational_audit_events
         (id, event_timestamp, event_type, actor_id, payload_json, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      now(),
      eventType,
      actor,
      JSON.stringify({ ...payload, mutationKey, approvalId }),
      mutationKey
    );
  }

  /**
   * One transaction for the whole operation: receipt replay check, tenant
   * assertion, mutation, receipt write. A validation failure rolls back and
   * leaves NO receipt — deterministic failures are not deduped, exactly like
   * the chatbot side maps them to FAILED.
   */
  function transact(mutationKey, opportunityId, operation, execute) {
    db.exec("BEGIN TRANSACTION;");
    try {
      const prior = db
        .prepare(
          "SELECT result_json FROM crm_mutation_receipts WHERE mutation_key = ? AND tenant_id = ?"
        )
        .get(mutationKey, scopeTenantId);
      if (prior) {
        db.exec("COMMIT;");
        return { duplicate: true, ...JSON.parse(prior.result_json) };
      }
      if (!isOpportunityInTenant(db, scopeTenantId, opportunityId)) {
        throw new CrmMutationError(404, "opportunity_not_found");
      }
      const result = execute();
      db.prepare(
        `INSERT INTO crm_mutation_receipts
           (mutation_key, tenant_id, opportunity_id, operation, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        mutationKey,
        scopeTenantId,
        opportunityId,
        operation,
        JSON.stringify(result),
        now()
      );
      db.exec("COMMIT;");
      return { duplicate: false, ...result };
    } catch (err) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  function moveStage({ opportunityId, stage, reason, mutationKey, actor, approvalId }) {
    return transact(mutationKey, opportunityId, "stage", () => {
      if (!STAGES.includes(stage)) {
        throw new CrmMutationError(400, "invalid_stage");
      }
      const opp = db
        .prepare("SELECT id, pipeline_stage FROM seller_opportunities WHERE id = ?")
        .get(opportunityId);
      // Reopening a terminal record is a deliberate act — require a reason
      // (same rule as the operator route).
      if (CLOSED_STAGES.has(opp.pipeline_stage) && !CLOSED_STAGES.has(stage) && !reason) {
        throw new CrmMutationError(409, "reopen_requires_reason");
      }
      const moved = opp.pipeline_stage !== stage;
      if (moved) {
        db.prepare(
          `INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(randomUUID(), opportunityId, opp.pipeline_stage, stage, actor, reason || null);
        db.prepare(
          `UPDATE seller_opportunities
           SET pipeline_stage = ?, opportunity_status = ?, updated_by = ?, updated_at = ?
           WHERE id = ?`
        ).run(stage, STATUS_BY_STAGE[stage] || "active", actor, now(), opportunityId);
      }
      audit("OPPORTUNITY_STAGE_MOVED", {
        opportunityId,
        mutationKey,
        actor,
        approvalId,
        payload: { opportunityId, priorStage: opp.pipeline_stage, newStage: stage, reason: reason || null, moved },
      });
      return { ok: true, opportunityId, readback: readback(db, opportunityId) };
    });
  }

  function addNote({ opportunityId, body, mutationKey, actor, approvalId }) {
    return transact(mutationKey, opportunityId, "notes", () => {
      if (!body || typeof body !== "string") {
        throw new CrmMutationError(400, "missing_body");
      }
      const noteId = randomUUID();
      db.prepare(
        "INSERT INTO operator_notes (id, opportunity_id, body, created_by) VALUES (?, ?, ?, ?)"
      ).run(noteId, opportunityId, body, actor);
      audit("CRM_NOTE_ADDED", {
        opportunityId,
        mutationKey,
        actor,
        approvalId,
        payload: { opportunityId, noteId },
      });
      return { ok: true, opportunityId, noteId, readback: readback(db, opportunityId) };
    });
  }

  function updateOpportunity({ opportunityId, fields, mutationKey, actor, approvalId }) {
    return transact(mutationKey, opportunityId, "update", () => {
      const entries = Object.entries(fields || {});
      if (entries.length === 0) {
        throw new CrmMutationError(400, "missing_fields");
      }
      const sets = [];
      const values = [];
      const applied = {};
      for (const [key, value] of entries) {
        const column = UPDATE_ALLOWLIST.get(key);
        if (!column) {
          throw new CrmMutationError(400, "field_not_allowed");
        }
        if (key === "opportunityStatus" && !OPPORTUNITY_STATUSES.has(value)) {
          throw new CrmMutationError(400, "invalid_opportunity_status");
        }
        sets.push(`${column} = ?`);
        values.push(value ?? null);
        applied[key] = value ?? null;
      }
      db.prepare(
        `UPDATE seller_opportunities
         SET ${sets.join(", ")}, updated_by = ?, updated_at = ?
         WHERE id = ?`
      ).run(...values, actor, now(), opportunityId);
      audit("CRM_OPPORTUNITY_UPDATED", {
        opportunityId,
        mutationKey,
        actor,
        approvalId,
        payload: { opportunityId, fields: applied },
      });
      return { ok: true, opportunityId, readback: readback(db, opportunityId) };
    });
  }

  function upsertContact({ opportunityId, name, phone, email, role, mutationKey, actor, approvalId }) {
    return transact(mutationKey, opportunityId, "contacts", () => {
      const normPhone = normalizePhone(phone);
      const normEmail = String(email || "").trim().toLowerCase() || null;
      if (normPhone || normEmail) {
        const rows = db
          .prepare(
            `SELECT c.id AS contact_id, c.email AS email, c.phone AS phone
             FROM seller_opportunity_participants p
             JOIN pipeline_contacts c ON c.id = p.ocg_one_person_id
             WHERE p.opportunity_id = ?`
          )
          .all(opportunityId);
        const match = rows.find(
          (r) =>
            (normEmail && String(r.email || "").trim().toLowerCase() === normEmail) ||
            (normPhone && normalizePhone(r.phone) === normPhone)
        );
        if (match) {
          audit("CRM_CONTACT_UPSERTED", {
            opportunityId,
            mutationKey,
            actor,
            approvalId,
            payload: { opportunityId, contactId: match.contact_id, matched: true },
          });
          return {
            ok: true,
            opportunityId,
            contactId: match.contact_id,
            matched: true,
            readback: readback(db, opportunityId),
          };
        }
      }
      const contact = persistSellerContact(db, opportunityId, {
        name,
        phone,
        email,
        role: role || "primary_owner",
        actor,
      });
      if (!contact) {
        throw new CrmMutationError(400, "missing_contact_identity");
      }
      audit("SELLER_CONTACT_ADDED", {
        opportunityId,
        mutationKey,
        actor,
        approvalId,
        payload: { opportunityId, contactId: contact.id, role: contact.role },
      });
      return {
        ok: true,
        opportunityId,
        contactId: contact.id,
        matched: false,
        readback: readback(db, opportunityId),
      };
    });
  }

  return { moveStage, addNote, updateOpportunity, upsertContact };
}
