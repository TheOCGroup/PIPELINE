"""Unit tests for read-only Phase 3G migration readiness inventory."""
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'phase3g_readiness.py'
spec = importlib.util.spec_from_file_location('phase3g_readiness', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source_path = Path(self.temp.name) / 'source.db'
        self.target_path = Path(self.temp.name) / 'target.db'
        db = sqlite3.connect(self.source_path)
        try:
            db.executescript('''CREATE TABLE seller_opportunities (id TEXT, pipeline_stage TEXT, created_by TEXT, tenant_id TEXT);
            CREATE TABLE seller_opportunity_sources (opportunity_id TEXT);
            CREATE TABLE seller_stage_events (id TEXT);
            CREATE TABLE seller_offers (id TEXT);
            CREATE TABLE seller_offer_versions (id TEXT);''')
        finally:
            db.close()
        db = sqlite3.connect(self.target_path)
        try:
            db.execute('CREATE TABLE seller_opportunities (id TEXT)')
            db.commit()
        finally:
            db.close()

    def run_report(self):
        src = module.connect_read_only(self.source_path)
        dst = module.connect_read_only(self.target_path)
        try:
            return module.report(src, dst)
        finally:
            src.close()
            dst.close()

    def test_empty_inventory_does_not_write(self):
        before = self.source_path.stat().st_size, self.target_path.stat().st_size
        result = self.run_report()
        self.assertTrue(result['ready_for_cutover'])
        self.assertEqual(result['source_integrity'], 'ok')
        self.assertEqual(before, (self.source_path.stat().st_size, self.target_path.stat().st_size))

    def test_unlinked_opportunity_blocks_cutover(self):
        db = sqlite3.connect(self.source_path)
        try:
            db.execute("INSERT INTO seller_opportunities VALUES ('one','new_lead','test','ocg-one')")
            db.execute("INSERT INTO seller_stage_events VALUES ('event')")
            db.commit()
        finally:
            db.close()
        result = self.run_report()
        self.assertFalse(result['ready_for_cutover'])
        self.assertIn('opportunities_missing_explicit_source_links', result['blockers'])
        self.assertEqual(result['source_counts']['seller_opportunities'], 1)
        self.assertEqual(result['source_creator_counts'], {'test': 1})

    def test_populated_target_requires_reconciliation(self):
        db = sqlite3.connect(self.target_path)
        try:
            db.execute("INSERT INTO seller_opportunities VALUES ('already-here')")
            db.commit()
        finally:
            db.close()
        result = self.run_report()
        self.assertFalse(result['ready_for_cutover'])
        self.assertIn('target_not_empty_requires_record_level_reconciliation', result['blockers'])


if __name__ == '__main__':
    unittest.main()

