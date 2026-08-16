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
  constructor(db) {
    this.db = db;
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
