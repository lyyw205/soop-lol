import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from memo import MemoCollector


class MemoTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.model=self.root/'head.json'
        self.model.write_text(json.dumps({'schema':1,'kind':'memo','encoder':'siglip',
            'coef':[1]+[0]*767,'intercept':0,'threshold':.8,'expansion_threshold':.5,'group_gap_seconds':15}))

    def tearDown(self):self.temp.cleanup()

    def features(self,values):
        x=np.zeros((len(values),768),dtype=np.float32);x[:,0]=values;return x

    def test_streaming_matches_one_batch_and_does_not_publish_weak_only_groups(self):
        at=[0,3,6,30,33,70];features=self.features([0,3,.5,.2,.3,4]);pixels=np.zeros((6,108,192,3),dtype=np.uint8)
        a=MemoCollector('123',self.model);a.add(features,at,pixels)
        b=MemoCollector('123',self.model);b.add(features[:2],at[:2],pixels[:2]);b.add(features[2:],at[2:],pixels[2:])
        one=a.finish(self.root/'one','source');two=b.finish(self.root/'two','source')
        self.assertEqual(one['groups'],two['groups']);self.assertEqual(len(one['groups']),2)
        self.assertEqual([f['at'] for f in one['groups'][0]['frames']],[0,3,6])
        self.assertEqual(one['groups'][1]['from'],70)
        self.assertFalse(any('read' in g or 'match_id' in g for g in one['groups']))

    def test_failed_publication_preserves_previous_manifest(self):
        c=MemoCollector('123',self.model);dest=self.root/'output';dest.mkdir();(dest/'memo.json').write_text('old')
        self.model.write_text('{}')
        with self.assertRaisesRegex(ValueError,'changed'):c.finish(dest,'source')
        self.assertEqual((dest/'memo.json').read_text(),'old')

    def test_repeated_or_out_of_order_timestamps_are_rejected(self):
        c=MemoCollector('123',self.model)
        with self.assertRaisesRegex(ValueError,'increasing'):
            c.add(self.features([2,2]),[3,3],np.zeros((2,108,192,3),dtype=np.uint8))

    def test_empty_success_is_distinct_from_no_manifest(self):
        c=MemoCollector('123',self.model);c.add(self.features([-5]),[1],np.zeros((1,108,192,3),dtype=np.uint8))
        out=c.finish(self.root/'output','source')
        self.assertEqual(out['groups'],[]);self.assertEqual(out['cells'],1)
        self.assertTrue((self.root/'output/memo.json').exists())


if __name__=='__main__':unittest.main()
