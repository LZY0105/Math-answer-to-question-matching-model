"""The matching evaluator must reproduce the worked examples in RESEARCH-REPORT.md."""
import unittest

from evaluate_matching import Features, canonical_symbols, dice, operator_contexts, similarity

B = chr(92)


class ReportExamples(unittest.TestCase):
    def test_operator_windows_match_section_3_4(self):
        # §3.4: x^2+3x -> "··x^2+3" "x^2+3x·"
        self.assertEqual(operator_contexts('x^2+3x'), {'··x^2+3': 1, 'x^2+3x·': 1})
        self.assertEqual(operator_contexts('x^3+5x'), {'··x^3+5': 1, 'x^3+5x·': 1})

    def test_near_identical_expressions_share_no_context(self):
        # §3.4: "Neither token matches, where a bigram bag shares x^, + and x."
        a, b = operator_contexts('x^2+3x'), operator_contexts('x^3+5x')
        self.assertEqual(dice(a, b), 0.0)

    def test_brackets_are_canonicalised_not_deleted(self):
        # §3.4: deleting brackets would make 1/(x+1) and 1/x+1 the same string.
        self.assertNotEqual(canonical_symbols('1/(x+1)'), canonical_symbols('1/x+1'))
        # TeX grouping braces follow the same rule: x^{2+1} is not x^{2}+1.
        self.assertNotEqual(canonical_symbols('x^{2+1}'), canonical_symbols('x^{2}+1'))

    def test_bracket_kinds_are_one_canonical_form(self):
        self.assertEqual(canonical_symbols('[a+b]'), canonical_symbols('(a+b)'))
        self.assertEqual(canonical_symbols(B + 'left(a+b' + B + 'right)'), canonical_symbols('(a+b)'))

    def test_typesetting_is_invisible(self):
        spaced = 'f(x)' + B + ',dx'
        self.assertEqual(canonical_symbols(spaced), canonical_symbols('f(x)dx'))

    def test_context_needs_two_anchors_each_side(self):
        # §3.4: suppressed when either side has fewer than two anchors.
        _, used = similarity(Features('n^{2}'), Features('n^{2}'))
        self.assertFalse(used)
        _, used = similarity(Features('x^{2}+3x=0'), Features('x^{2}+3x=0'))
        self.assertTrue(used)

    def test_commands_become_single_symbols(self):
        self.assertEqual(len(canonical_symbols(B + 'alpha')), 1)
        self.assertEqual(len(canonical_symbols(B + 'frac')), 1)


class TexTellerSpellings(unittest.TestCase):
    """Pairs taken from epoch-2 validation: TexTeller reference vs model output.
    Each renders the same, so each must canonicalise to the same string."""

    def same(self, a, b):
        self.assertEqual(canonical_symbols(a), canonical_symbols(b), (a, b))

    def differ(self, a, b):
        self.assertNotEqual(canonical_symbols(a), canonical_symbols(b), (a, b))

    def test_plain_grouping_braces_draw_nothing(self):
        self.same('G=' + B + 'left({Z},+' + B + 'right)', 'G=(Z,+)')
        self.same(B + 'sigma' + B + 'tau' + B + 'in{Aut}' + B + 'left(G' + B + 'right)',
                  B + 'sigma' + B + 'tau' + B + 'in Aut' + B + 'left(G' + B + 'right)')

    def test_font_wrappers_are_not_content(self):
        self.same(B + 'mbox{' + B + 'bf Aut($G$)}', 'Aut' + B + 'left(G' + B + 'right)')
        self.same(B + 'mathrm{Aut}(G)', 'Aut(G)')
        self.same('A^{' + B + 'mathrm{T}}', 'A^{T}')

    def test_spacing_is_not_content(self):
        self.same(B + 'alpha' + B + '!' + B + '!>' + B + '!-1', B + 'alpha>-1')
        self.same(B + 'forall' + B + ',x', B + 'forall x')

    def test_single_token_script_braces_are_optional(self):
        self.same('x^{2}', 'x^2')
        self.same(B + 'frac{1}{2}', B + 'frac12')

    def test_invisible_delimiter(self):
        self.same(B + 'left|x' + B + 'right.', '|x')

    def test_arrow_length_is_typography(self):
        self.same(B + 'longmapsto', B + 'mapsto')

    def test_structure_is_still_content(self):
        # The things that must NOT merge.
        self.differ('x^{2+1}', 'x^{2}+1')
        self.differ(B + 'frac{x+1}{2}', B + 'frac{x}{2}+1')
        self.differ('1/(x+1)', '1/x+1')
        self.differ(B + 'mathbb{R}', 'R')          # the reals are not the letter R
        self.differ(B + 'frac{1}{3}' + B + 'Gamma', B + 'Gamma')   # the dropped 1/3 from epoch 2


if __name__ == '__main__':
    unittest.main()
