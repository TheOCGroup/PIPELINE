#!/usr/bin/env python3
"""Read-only OCG ONE -> PIPELINE Phase 3G migration readiness report.

Never copies rows, writes data, prints addresses, or exposes contact records.
Both databases are opened SQLite mode=ro. Exit 2 means cutover is blocked.
"""
import argparse
import json
import sqlite3
from pathlib import Path


def connect_read_only(path):
    p = Path(path).resolve(strict=True)
    return sqlite3.connect(p.as_uri() + '?mode=ro', uri=True)


def table_exists(db, name):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def count(db, name):
    return db.execute('SELECT count(*) FROM "' + name + '"').fetchone()[0] if table_exists(db, name) else None


def grouped(db, table, column):
    if not table_exists(db, table):
        return {}
    return {str(key) if key is not None else '(null)': n for key, n in db.execute(
        'SELECT "' + column + '",count(*) FROM "' + table + '" GROUP BY "' + column + '" ORDER BY count(*) DESC')}


def report(source, target):
    source_counts = {name: count(source, name) for name in (
        'seller_opportunities', 'seller_opportunity_sources', 'seller_stage_events',
        'seller_offers', 'seller_offer_versions', 'property_leads', 'people', 'canonical_tasks')}
    target_counts = {name: count(target, name) for name in (
        'seller_opportunities', 'seller_opportunity_sources', 'seller_stage_events',
        'seller_offers', 'seller_offer_versions')}
    reasons = []
    if source_counts['seller_opportunities'] is None or target_counts['seller_opportunities'] is None:
        reasons.append('source_or_target_schema_missing')
    else:
        linked = source.execute('SELECT count(DISTINCT opportunity_id) FROM seller_opportunity_sources').fetchone()[0] if table_exists(source, 'seller_opportunity_sources') else 0
        if linked < source_counts['seller_opportunities']:
            reasons.append('opportunities_missing_explicit_source_links')
        if target_counts['seller_opportunities']:
            reasons.append('target_not_empty_requires_record_level_reconciliation')
    if source_counts['seller_opportunities'] and not source_counts['seller_stage_events']:
        reasons.append('source_stage_history_missing')
    if source_counts['seller_opportunities'] and not source_counts['seller_opportunity_sources']:
        reasons.append('source_provenance_missing')
    if source_counts['seller_opportunities']:
        reasons.append('authoritative_record_lineage_and_cutover_approval_required')
    return {'ready_for_cutover': not reasons,
            'source_integrity': source.execute('PRAGMA quick_check').fetchone()[0],
            'target_integrity': target.execute('PRAGMA quick_check').fetchone()[0],
            'source_counts': source_counts, 'target_counts': target_counts,
            'source_stages': grouped(source, 'seller_opportunities', 'pipeline_stage'),
            'source_creator_counts': grouped(source, 'seller_opportunities', 'created_by'),
            'source_tenant_counts': grouped(source, 'seller_opportunities', 'tenant_id'),
            'blockers': reasons}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='OCG ONE SQLite file')
    parser.add_argument('--target', required=True, help='standalone PIPELINE SQLite file')
    args = parser.parse_args()
    with connect_read_only(args.source) as source, connect_read_only(args.target) as target:
        result = report(source, target)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result['ready_for_cutover'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
