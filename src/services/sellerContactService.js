/**
 * Seller contact persistence — shared by intake and the operator API.
 *
 * A seller lead is a pipeline_contacts row (name/phone/email) linked to the
 * opportunity through seller_opportunity_participants (role primary_owner).
 * Verification is honest: contacts supplied by an intake payload or the
 * founder are recorded as 'source_supplied', never as independently
 * verified.
 */

import { randomUUID } from "node:crypto";

const VALID_ROLES = new Set([
  "primary_owner",
  "co_owner",
  "spouse",
  "trustee",
  "heir",
  "power_of_attorney",
  "wholesaler_agent",
  "attorney_advisor",
  "decision_maker",
  "other",
]);

function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Unknown", lastName: "Seller" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "(unknown)" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Persist a seller contact for an opportunity.
 * Must be called inside the caller's transaction when atomicity matters.
 * Returns the contact row, or null when nothing identifying was provided.
 */
export function persistSellerContact(
  db,
  opportunityId,
  { name, phone, email, role = "primary_owner", actor = "system", verificationStatus = "source_supplied" } = {}
) {
  const cleanName = String(name || "").trim() || null;
  const cleanPhone = String(phone || "").trim() || null;
  const cleanEmail = String(email || "").trim() || null;
  if (!cleanName && !cleanPhone && !cleanEmail) return null;

  const participantRole = VALID_ROLES.has(role) ? role : "other";
  const { firstName, lastName } = splitName(cleanName);
  const contactId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO pipeline_contacts
       (id, first_name, last_name, email, phone, primary_role, notes_summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'seller', ?, ?, ?)`
  ).run(
    contactId,
    firstName,
    lastName,
    cleanEmail,
    cleanPhone,
    `Seller contact for opportunity ${opportunityId}`,
    now,
    now
  );

  const existingPrimary = db
    .prepare(
      `SELECT id FROM seller_opportunity_participants
       WHERE opportunity_id = ? AND is_primary = 1 LIMIT 1`
    )
    .get(opportunityId);
  const isPrimary = participantRole === "primary_owner" && !existingPrimary ? 1 : 0;

  db.prepare(
    `INSERT INTO seller_opportunity_participants
       (id, opportunity_id, ocg_one_person_id, participant_role, is_primary,
        decision_authority_status, verification_status, created_by)
     VALUES (?, ?, ?, ?, ?, 'unverified', ?, ?)`
  ).run(
    randomUUID(),
    opportunityId,
    contactId,
    participantRole,
    isPrimary,
    verificationStatus,
    actor
  );

  return {
    id: contactId,
    opportunityId,
    name: `${firstName} ${lastName}`.trim(),
    firstName,
    lastName,
    phone: cleanPhone,
    email: cleanEmail,
    role: participantRole,
    isPrimary: isPrimary === 1,
    verificationStatus,
  };
}
