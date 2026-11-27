-- Governed CRM mutation receipts (S2 SS3 contract, R1 SS4).
-- One row per executed governed mutation, keyed by the chatbot governed
-- executor's operation key (mutationKey). The receipt is written in the SAME
-- transaction as the mutation itself, so a committed mutation always has a
-- receipt and a replayed mutationKey can be answered from the stored result
-- without re-executing. Additive only: no existing table is touched.
--
-- Deviation from the contract's literal DDL, recorded in R1 SS4: the
-- contract specifies mutation_key as the sole PRIMARY KEY but also
-- specifies dedupe as "if mutation_key exists FOR THIS TENANT". A sole-key
-- primary key makes the second tenant's insert of the same key fail with a
-- UNIQUE constraint error (proven by tests/r1-crm-mutations.test.mjs).
-- The dedupe semantics win: uniqueness is per (mutation_key, tenant_id).
CREATE TABLE IF NOT EXISTS crm_mutation_receipts (
  mutation_key TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mutation_key, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_mutation_receipts_tenant
  ON crm_mutation_receipts(tenant_id, opportunity_id);
