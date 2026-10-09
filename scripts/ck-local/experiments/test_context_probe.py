"""Regression checks for the isolated reference-screen pilot's selection rules."""
import unittest

import numpy as np

from context_probe import groups, select_sets


class SelectionTests(unittest.TestCase):
    def test_grouping_keeps_singletons_and_respects_real_time_gaps(self):
        ats = np.array([0, 3, 9, 100, 103, 120])
        self.assertEqual(groups(range(6), ats), [[0, 1, 2], [3, 4], [5]])

    def make(self):
        ats = np.arange(0, 1002, 3)
        classes = np.array(['other', 'banpick', 'ingame'])
        probs = np.zeros((len(ats), 3)); probs[:, 0] = 1
        probs[(ats >= 210) & (ats < 300)] = [0, .99, .01]
        probs[(ats >= 300) & (ats <= 900)] = [0, .01, .99]
        match = {'match_id': 'fixture', 'series_game_no': 1,
                 'duration': 600, 'result_evidence': 'out/ck/fixture/g000900.jpg'}
        return ats, probs, classes, match

    def test_start_plus_sixty_uses_same_ingame_run(self):
        ats, probs, classes, match = self.make()
        picked = select_sets(ats, probs, classes, [match])[0]
        self.assertEqual(picked['status'], 'proposed')
        self.assertEqual([ats[f['index']] for f in picked['frames']], [297, 360])

    def test_multiple_plausible_starts_remain_unresolved(self):
        ats, probs, classes, match = self.make()
        probs[(ats >= 150) & (ats <= 225)] = [0, .01, .99]
        picked = select_sets(ats, probs, classes, [match])[0]
        self.assertEqual(picked['status'], 'unresolved')
        self.assertEqual(picked['frames'], [])

    def test_a_short_ingame_false_positive_does_not_start_a_set(self):
        ats, probs, classes, match = self.make()
        probs[(ats >= 150) & (ats <= 165)] = [0, .01, .99]
        picked = select_sets(ats, probs, classes, [match])[0]
        self.assertEqual(picked['observed_ingame_start'], 300)

    def test_distant_draft_is_not_attached(self):
        ats, probs, classes, match = self.make()
        probs[(ats >= 210) & (ats < 300)] = [1, 0, 0]
        probs[(ats >= 60) & (ats < 100)] = [0, .99, .01]
        picked = select_sets(ats, probs, classes, [match])[0]
        self.assertEqual([f['kind'] for f in picked['frames']], ['ingame_plus_60'])


if __name__ == '__main__':
    unittest.main()
