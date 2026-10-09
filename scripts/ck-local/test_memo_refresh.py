import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('refresh', Path(__file__).with_name('memo-refresh.py'))
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class TimelineTests(unittest.TestCase):
    def test_trailing_sheet_cell_does_not_overlap_the_next_video_part(self):
        meta = {'parts': [
            {'offset': 0, 'length': 5.5, 'cells': 3, 'reliable': True, 'sheets': ['a']},
            {'offset': 5.5, 'length': 6, 'cells': 2, 'reliable': True, 'sheets': ['b']},
        ]}
        refs = refresh.references(meta)
        self.assertEqual(len(refs), 5)  # Preserve cached feature alignment.
        selected = [(i, r['at']) for i, r in enumerate(refs) if r['at'] < r['end']]
        self.assertEqual(selected, [(0, 0), (1, 3), (3, 5.5), (4, 8.5)])


if __name__ == '__main__': unittest.main()
