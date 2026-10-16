"""标签写法统一规则的测试。在 ocr/ 目录下运行：python -m unittest test_normalize_labels"""
import importlib.util
import unittest

from evaluate_matching import canonical_symbols
from normalize_labels import detokenize, normalize_label, tokenize

B = chr(92)

# 真实 TexTeller 标签里出现过的写法
SAMPLES = [
    B + "left( x " + B + "right)^{2}",
    B + "left. " + B + "frac{d f}{d x} " + B + "right|_{x=0}",
    B + "left" + B + "{ " + B + "begin{array}{l} x>0 " + B + "end{array} " + B + "right.",
    "f(x)" + B + ",dx",
    B + "alpha" + B + "!" + B + "!>" + B + "!-1",
    "a " + B + "rightarrow b",
    B + "bigl( x " + B + "bigr)",
    B + "sum" + B + "limits_{i=1}^{n} x_{i}",
    B + "mathrm{Aut} ( G )",
    "x " + B + "quad y",
    B + "geqslant 0",
]


class NormalizeLabelsTest(unittest.TestCase):
    def check(self, source, expected):
        self.assertEqual(normalize_label(source), expected)

    def test_sized_delimiters_keep_only_the_bracket(self):
        self.check(B + "left( x " + B + "right)", "(x)")
        self.check(B + "left" + B + "{ x " + B + "right" + B + "}", B + "{x" + B + "}")
        self.check(B + "bigl[ x " + B + "Bigr|", "[x|")
        self.check(B + "left|x" + B + "middle|y" + B + "right|", "|x|y|")

    def test_left_right_scoping_an_infix_fraction_stays(self):
        # 去掉后两个 \atop 落在同一组里，MathJax 报 Ambiguous use of \atop
        source = B + "left( a" + B + "quad 0" + B + "atop 0" + B + "quad b" + B + "right)"
        self.assertEqual(tokenize(normalize_label(source)), tokenize(source))
        # 中缀命令在这对括号之外时照常去掉
        self.check(B + "left( a " + B + "right) " + B + "over b", "(a)" + B + "over b")

    def test_null_delimiters_disappear_with_their_dot(self):
        self.check(B + "left. " + B + "frac{d f}{d x} " + B + "right|_{x=0}",
                   B + "frac{df}{dx}|_{x=0}")
        self.check(B + "left" + B + "{ x " + B + "right.", B + "{x")

    def test_thin_spaces_go_visible_spaces_stay(self):
        self.check("f(x)" + B + ",dx", "f(x)dx")
        self.check(B + "alpha" + B + "!" + B + "!>" + B + "!-1", B + "alpha>-1")
        self.check("x " + B + "quad y", "x" + B + "quad y")
        self.check("a" + B + " b~c", "a" + B + " b~c")

    def test_aliases_take_the_common_spelling(self):
        self.check("a " + B + "rightarrow b", "a" + B + "to b")
        self.check(B + "vert x " + B + "rvert", "|x|")
        self.check(B + "lnot p", B + "neg p")
        self.check(B + "left" + B + "lbrace x " + B + "right" + B + "rbrace", B + "{x" + B + "}")

    def test_blackboard_hack_keeps_the_letter(self):
        self.check("I" + B + "!" + B + "!P(A)", "P(A)")
        self.check("I" + B + "!" + B + "!" + B + "!I", "I")
        self.check("1" + B + "!" + B + "!1_{A}", "1_{A}")
        # 单个负间距不是拼字
        self.check("x" + B + "!y", "xy")

    def test_visible_differences_are_untouched(self):
        for source in (B + "mathrm{Aut}", "{Z}", B + "sum" + B + "limits_{i}", B + "geqslant",
                       B + "dfrac{1}{2}", "a" + B + "mid b", B + "mathsf{A}", "f^{" + B + "prime}"):
            self.assertEqual(tokenize(normalize_label(source)), tokenize(source), source)

    def test_idempotent(self):
        for source in SAMPLES:
            once = normalize_label(source)
            self.assertEqual(normalize_label(once), once, source)

    def test_matcher_sees_the_same_formula(self):
        # 规则只去掉配对规范化本来就会忽略的东西（拼字与 \vert 类别名除外）
        for source in SAMPLES:
            self.assertEqual(canonical_symbols(normalize_label(source)), canonical_symbols(source), source)

    def test_detokenize_round_trips(self):
        for source in SAMPLES:
            self.assertEqual(tokenize(detokenize(tokenize(source))), tokenize(source), source)

    @unittest.skipUnless(importlib.util.find_spec("torch"), "需要 torch 才能加载训练分词器")
    def test_tokenizer_matches_training_tokenizer(self):
        from scratch_model import TeXTokenizer
        for source in SAMPLES + [B + "text{if x}", B + "begin{pmatrix}1&2" + B + B + "3&4" + B + "end{pmatrix}"]:
            self.assertEqual(tokenize(source), TeXTokenizer.tokenize(source), source)


if __name__ == "__main__":
    unittest.main()
