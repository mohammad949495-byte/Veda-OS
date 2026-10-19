import unittest
import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))
from reconstructed_engine import *

class TestReconstructedEngine(unittest.TestCase):
    def test_pipeline_execution(self):
        engine = Network_protocol_daemon_exeReconstructedEngine()
        res = engine.execute_pipeline(b"TEST_PAYLOAD")
        self.assertEqual(res["status"], "DETERMINISTIC_SUCCESS")
        self.assertGreater(res["processed_bytes"], 0)

if __name__ == "__main__":
    unittest.main()
