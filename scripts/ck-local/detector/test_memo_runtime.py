import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import numpy as np
import torch
from memo import MemoCollector
from memo_runtime import MemoSession, selected


class RuntimeTests(unittest.TestCase):
    def test_scoring_before_pooling_matches_training_features(self):
        torch.set_num_threads(2)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'model.json'
            rng = np.random.default_rng(4)
            w = rng.normal(size=768).astype(np.float32)
            path.write_text(json.dumps({'schema': 2, 'kind': 'memo', 'encoder': 'siglip',
                'spatial': 'final_norm_l2_14x14', 'sizes': [2,3,4,6], 'stride': 2,
                'coef': w.tolist(), 'intercept': .5, 'threshold': 5, 'expansion_threshold': 3}))
            c = MemoCollector('123', path)
            tokens = torch.tensor(rng.normal(size=(3,196,768)).astype(np.float32))
            x = torch.nn.functional.normalize(tokens, dim=-1).reshape(-1,14,14,768).permute(0,3,1,2)
            regions = torch.cat([torch.nn.functional.avg_pool2d(x[:,:,3:11],k,stride=2).flatten(2).transpose(1,2) for k in [2,3,4,6]],dim=1)
            expected = torch.sigmoid((regions @ torch.tensor(w) + .5).max(1).values).numpy()
            np.testing.assert_allclose(c.spatial_scores(tokens), expected, atol=2e-6)

    def test_sampling_and_emergency_off(self):
        with patch.dict('os.environ', {'CK_MEMO_ENABLED': '1'}):
            self.assertTrue(selected('208295391', 'auto', {'enabled': True, 'percent': 25}))
            self.assertFalse(selected('206719759', 'auto', {'enabled': True, 'percent': 25}))
            self.assertFalse(selected('208295391', 'off', {'enabled': True, 'percent': 100}))
        with patch.dict('os.environ', {'CK_MEMO_ENABLED': '0'}):
            self.assertFalse(selected('208295391', 'on', {}))

    def test_missing_head_and_capture_failure_are_isolated(self):
        with tempfile.TemporaryDirectory() as d:
            meta = Path(d)/'sheets.json'; meta.write_text('{"vod":123,"parts":[]}')
            with patch('memo_runtime.MemoCollector', side_effect=ValueError('bad model')):
                session = MemoSession(meta, object(), 'on')
            session.observe([0], np.zeros((1,108,192,3)), 3)
            session.finish()
            self.assertEqual(json.loads((Path(d)/'memo-run.json').read_text())['status'], 'failed')
            self.assertFalse((Path(d)/'memo.json').exists())
            norm = torch.nn.Identity()
            head = SimpleNamespace(schema=2, spatial_scores=lambda _: (_ for _ in ()).throw(RuntimeError('observer failure')))
            with patch('memo_runtime.MemoCollector', return_value=head):
                observer = MemoSession(meta, SimpleNamespace(memo_norm=norm), 'on')
            tokens = torch.randn(2,196,768)
            self.assertTrue(torch.equal(norm(tokens), tokens))
            self.assertEqual(len(norm._forward_hooks), 0)
            observer.finish()
            self.assertEqual(json.loads((Path(d)/'memo-run.json').read_text())['status'], 'failed')


if __name__ == '__main__': unittest.main()
