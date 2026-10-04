import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import train


class TrainingTest(unittest.TestCase):
    def test_fit_stages_and_test_scores_use_final_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            live = out / 'model' / 'sample'; live.mkdir(parents=True)
            (live / 'clf.npz').write_bytes(b'unchanged-live-model')
            metas = {1: {'channel': 'training'}, 2: {'channel': 'lshooooo'}, 3: {'channel': 'xoals137'}}
            embeddings = {v: (np.arange(6)*3, np.array([[-2,0],[-1,0],[-.5,0],[.5,0],[1,0],[2,0]], dtype=np.float32)) for v in metas}
            labels = {(v,i): ('result' if i>=3 else 'other', 'review:test') for v in metas for i in range(6)}
            candidate = out / 'candidate'
            args = SimpleNamespace(model='sample',output_dir=str(candidate),no_aug=True)
            with patch.object(train, 'OUT', out), patch.object(train, 'load_meta', return_value=metas), \
                 patch.object(train, 'load_emb', return_value=embeddings), patch.object(train, 'load_labels', return_value=labels):
                train.fit(args)
            self.assertEqual((live / 'clf.npz').read_bytes(), b'unchanged-live-model')
            z = np.load(candidate / 'model' / 'sample' / 'clf.npz')
            expected = 1 / (1 + np.exp(-(embeddings[3][1] @ z['coef'] + z['intercept'][0])))
            np.testing.assert_allclose(np.load(candidate / 'scores' / 'sample' / '3.npy'), expected, rtol=1e-6)


if __name__ == '__main__': unittest.main()
