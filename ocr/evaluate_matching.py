"""Score OCR output the way the matcher uses it, not by exact LaTeX.

The matcher never compares LaTeX strings for equality. Stage 2 of the cascade
(RESEARCH-REPORT.md §3.4) scores content by character-bigram Dice and, where
both sides carry at least two operators, by Dice over operator-context windows
of radius 3 (§6.1). A recognised formula is useful to it when that score picks
the right candidate over the wrong ones -- which exact match cannot tell you:
a missing ``\\,`` fails exact match and changes nothing the matcher sees.

So this reports, from an ``evaluate_scratch.py`` output file:
  * exact match, and exact match after canonicalisation;
  * per-sample similarity between prediction and reference;
  * a retrieval simulation: each prediction is scored against its own reference
    and K-1 distractor references (same book when a manifest is given), and the
    question is whether the own reference ranks first, and by what margin.

Implemented from the specification in RESEARCH-REPORT.md §3.4 and §6.1, not
from src/. Two things the report does not pin down are assumptions here and are
named as such: the operator set (OPERATORS) and how LaTeX is reduced to the
character form the matcher windows over (canonical_symbols).
"""
from __future__ import annotations

import argparse
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path

B = chr(92)
TOKEN = re.compile(B + B + r'(?:begin|end)\{[a-zA-Z*]+\}|' + B + B + r'[A-Za-z]+|' + B + B + r'.|.', re.S)
PAD = '·'          # the report's window padding character
RADIUS = 3         # selected in §6.1

# Invisible or purely typographic: they change nothing the matcher sees.
TYPESETTING = {B + x for x in (',', ';', '!', ':', ' ', 'quad', 'qquad', 'left', 'right', 'middle',
                               'displaystyle', 'textstyle', 'scriptstyle', 'big', 'Big', 'bigg', 'Bigg',
                               'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'limits', 'nolimits')} | {'~', '$'}
# \left. and \right. are invisible delimiters: the dot after them draws nothing.
SIZED_DELIMITER = {B + 'left', B + 'right', B + 'middle'}

# Font and text wrappers change the typeface, not the content: \mathrm{Aut},
# {Aut}, \mbox{\bf Aut($G$)} and Aut are one formula. TexTeller labels use all
# four for the same printed word, so leaving them in turns the teacher's own
# inconsistency into recognition error.
STYLE = {B + x for x in ('mathrm', 'mathit', 'mathbf', 'mathsf', 'mathtt', 'textrm', 'textit', 'textbf',
                         'textsf', 'texttt', 'text', 'mbox', 'hbox', 'operatorname', 'boldsymbol',
                         'rm', 'bf', 'it', 'sf', 'tt')}
# Commands whose brace arguments are structure. \mathbb and friends stay here
# because they change which symbol is meant (R is not the reals).
ARGS = {B + name: n for name, n in (
    ('frac', 2), ('dfrac', 2), ('tfrac', 2), ('cfrac', 2), ('binom', 2), ('dbinom', 2), ('tbinom', 2),
    ('overset', 2), ('underset', 2), ('stackrel', 2),
    ('sqrt', 1), ('overline', 1), ('underline', 1), ('hat', 1), ('widehat', 1), ('bar', 1), ('vec', 1),
    ('tilde', 1), ('widetilde', 1), ('dot', 1), ('ddot', 1), ('check', 1), ('breve', 1),
    ('overrightarrow', 1), ('overleftarrow', 1), ('xrightarrow', 1),
    ('mathbb', 1), ('mathcal', 1), ('mathfrak', 1), ('mathscr', 1))}

# "Brackets are canonicalised rather than deleted" (§3.4): every visible
# bracket kind becomes one form. TeX braces are handled separately below,
# because most of them are not visible at all.
OPEN = {'(', '[', B + '{', B + 'langle', B + 'lbrace', B + 'lbrack'}
CLOSE = {')', ']', B + '}', B + 'rangle', B + 'rbrace', B + 'rbrack'}
# Marks a multi-token structural argument, so x^{2+1} stays apart from x^{2}+1.
GROUP_OPEN, GROUP_CLOSE = '⦃', '⦄'

# Each TeX command becomes one symbol, so a radius-3 window spans three symbols
# the way it spans three characters of a text layer.
SYMBOL = {
    'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ', 'epsilon': 'ϵ', 'varepsilon': 'ε',
    'zeta': 'ζ', 'eta': 'η', 'theta': 'θ', 'vartheta': 'ϑ', 'iota': 'ι', 'kappa': 'κ',
    'lambda': 'λ', 'mu': 'μ', 'nu': 'ν', 'xi': 'ξ', 'pi': 'π', 'rho': 'ρ', 'sigma': 'σ',
    'tau': 'τ', 'upsilon': 'υ', 'phi': 'ϕ', 'varphi': 'φ', 'chi': 'χ', 'psi': 'ψ', 'omega': 'ω',
    'Gamma': 'Γ', 'Delta': 'Δ', 'Theta': 'Θ', 'Lambda': 'Λ', 'Xi': 'Ξ', 'Pi': 'Π', 'Sigma': 'Σ',
    'Phi': 'Φ', 'Psi': 'Ψ', 'Omega': 'Ω',
    'cdot': '⋅', 'times': '×', 'div': '÷', 'pm': '±', 'mp': '∓',
    'leq': '≤', 'le': '≤', 'geq': '≥', 'ge': '≥', 'neq': '≠', 'ne': '≠', 'approx': '≈',
    'equiv': '≡', 'sim': '∼', 'simeq': '≃', 'cong': '≅', 'propto': '∝',
    'in': '∈', 'notin': '∉', 'subset': '⊂', 'subseteq': '⊆', 'supset': '⊃', 'supseteq': '⊇',
    'cup': '∪', 'cap': '∩', 'setminus': '∖', 'emptyset': '∅', 'varnothing': '∅',
    # Arrow length is typography; the relation is the same.
    'to': '→', 'rightarrow': '→', 'longrightarrow': '→', 'Rightarrow': '⇒', 'Longrightarrow': '⇒',
    'implies': '⇒', 'Leftrightarrow': '⇔', 'Longleftrightarrow': '⇔', 'iff': '⇔',
    'mapsto': '↦', 'longmapsto': '↦',
    'infty': '∞', 'partial': '∂', 'nabla': '∇', 'forall': '∀', 'exists': '∃',
    'int': '∫', 'iint': '∬', 'iiint': '∭', 'oint': '∮', 'sum': '∑', 'prod': '∏',
    'sqrt': '√', 'prime': '′', 'cdots': '⋯', 'ldots': '…', 'dots': '…', 'vdots': '⋮', 'ddots': '⋱',
    'oplus': '⊕', 'otimes': '⊗', 'perp': '⊥', 'parallel': '∥', 'angle': '∠',
}
# Anchors for context windows. The report shows ^ and + anchoring; the rest of
# this set is an assumption covering the arithmetic, relational and set
# operators that behave the same way.
OPERATORS = set('+-=^_/*<>|') | set('⋅×÷±∓≤≥≠≈≡∼≃≅∝∈∉⊂⊆⊃⊇∪∩∖→⇒⇔↦⊕⊗')

_private = {}


def _nest(tokens):
    """Tokens -> nested lists, one list per {...} group. Unbalanced input is
    closed at the end rather than rejected; both sides get the same treatment."""
    root, stack = [], []
    current = root
    for tok in tokens:
        if tok == '{':
            stack.append(current)
            current.append([])
            current = current[-1]
        elif tok == '}':
            if stack:
                current = stack.pop()
        else:
            current.append(tok)
    return root


def _flatten(items, out):
    """Emit tokens, deciding for each brace group whether it is structure.

    A group that is the argument of ^, _ or a command in ARGS is structure: a
    single-token argument drops its braces (x^{2} renders as x^2), a longer
    one keeps a marker (x^{2+1} is not x^{2}+1). Any other group is plain TeX
    grouping and draws nothing, so its braces go ({Z} renders as Z).
    """
    need = 0                       # upcoming atoms that are structural arguments
    skip_dot = False
    for item in items:
        if isinstance(item, list):
            inner = []
            _flatten(item, inner)
            if need:
                need -= 1
                out.extend(inner if len(inner) <= 1 else [GROUP_OPEN, *inner, GROUP_CLOSE])
            else:
                out.extend(inner)
            continue
        tok = item
        if tok.isspace():
            continue
        if skip_dot:
            skip_dot = False
            if tok == '.':         # \left. / \right.: an invisible delimiter
                continue
        if tok in SIZED_DELIMITER:
            skip_dot = True
            continue
        if tok in TYPESETTING or tok in STYLE:
            continue
        out.append(tok)
        if tok in ('^', '_'):
            need += 1
        elif tok in ARGS:
            need += ARGS[tok]
        elif need:
            need -= 1              # a bare single-token argument, as in \frac12


def canonical_symbols(latex: str) -> str:
    """Reduce LaTeX to the one-symbol-per-token form the matcher windows over,
    mapping render-equivalent spellings to the same string."""
    flat = []
    _flatten(_nest(TOKEN.findall(latex)), flat)
    out = []
    for tok in flat:
        if tok in OPEN:
            out.append('(')
        elif tok in CLOSE:
            out.append(')')
        elif tok in (GROUP_OPEN, GROUP_CLOSE):
            out.append(tok)
        elif tok.startswith(B) and len(tok) > 1:
            name = tok[1:]
            if name in SYMBOL:
                out.append(SYMBOL[name])
            else:
                # Stable one-symbol stand-in for any other command (\frac, \lim,
                # \begin{pmatrix}, ...), from the Unicode private-use area.
                out.append(_private.setdefault(tok, chr(0xE000 + len(_private))))
        else:
            out.append(tok)
    return ''.join(out)


def bigrams(s: str) -> Counter:
    return Counter(s[i:i + 2] for i in range(len(s) - 1)) if len(s) > 1 else Counter({s: 1})


def operator_contexts(s: str) -> Counter:
    padded = PAD * RADIUS + s + PAD * RADIUS
    return Counter(padded[i - RADIUS:i + RADIUS + 1]
                   for i in range(RADIUS, RADIUS + len(s)) if padded[i] in OPERATORS)


def dice(a: Counter, b: Counter) -> float:
    total = sum(a.values()) + sum(b.values())
    return 2 * sum((a & b).values()) / total if total else 1.0


class Features:
    __slots__ = ('text', 'bigram', 'context')

    def __init__(self, latex: str):
        self.text = canonical_symbols(latex)
        self.bigram = bigrams(self.text)
        self.context = operator_contexts(self.text)


def similarity(a: Features, b: Features) -> tuple[float, bool]:
    """Operator-context Dice when both sides have two or more anchors (§3.4),
    otherwise character-bigram Dice. Returns (score, context_used)."""
    if sum(a.context.values()) >= 2 and sum(b.context.values()) >= 2:
        return dice(a.context, b.context), True
    return dice(a.bigram, b.bigram), False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--report', type=Path, required=True, help='evaluate_scratch.py output JSON')
    parser.add_argument('--manifest', type=Path, help='manifest with a "book" field, for same-book distractors')
    parser.add_argument('--candidates', type=int, default=50, help='pool size per query, own reference included')
    parser.add_argument('--seed', type=int, default=20260928)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()

    rows = json.loads(args.report.read_text(encoding='utf-8'))['predictions']
    book = {}
    if args.manifest:
        with args.manifest.open(encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    book[r['id']] = r.get('book') or '?'
    n = len(rows)
    ref = [Features(r['expected']) for r in rows]
    hyp = [Features(r['predicted']) for r in rows]

    exact = sum(1 for r in rows if r['exact'])
    canon_exact = sum(1 for r, e, h in zip(rows, ref, hyp) if r['ended_with_eos'] and e.text == h.text)
    pair = [similarity(h, e) for h, e in zip(hyp, ref)]
    applies = sum(1 for _, used in pair if used)

    # Retrieval: does the prediction pick out its own reference from a pool?
    groups = defaultdict(list)
    for i, r in enumerate(rows):
        groups[book.get(r['id'], 'all') if book else 'all'].append(i)
    rng = random.Random(args.seed)
    top1 = oracle_top1 = inversions = 0
    margins, oracle_margins = [], []
    for i, r in enumerate(rows):
        pool = [j for j in groups[book.get(r['id'], 'all') if book else 'all'] if j != i]
        if len(pool) > args.candidates - 1:
            pool = rng.sample(pool, args.candidates - 1)
        # Distractors whose reference is textually identical to the query's own
        # are not wrong answers; the matcher could not and should not separate them.
        pool = [j for j in pool if ref[j].text != ref[i].text]
        own = similarity(hyp[i], ref[i])[0]
        best_wrong = max((similarity(hyp[i], ref[j])[0] for j in pool), default=0.0)
        top1 += own > best_wrong
        inversions += best_wrong > own
        margins.append(own - best_wrong)
        # Upper bound: the reference itself as the query. Measures how separable
        # the formulas are at all, independent of recognition.
        o_best = max((similarity(ref[i], ref[j])[0] for j in pool), default=0.0)
        oracle_top1 += 1.0 > o_best
        oracle_margins.append(1.0 - o_best)

    def pct(x):
        return 100 * x / n

    mean = lambda xs: sum(xs) / len(xs) if xs else 0.0
    ms = sorted(margins)
    summary = {
        'samples': n,
        'exact_match': exact / n,
        'canonical_exact_match': canon_exact / n,
        'mean_similarity_to_reference': mean([s for s, _ in pair]),
        'similarity_at_least_0_9': sum(1 for s, _ in pair if s >= 0.9) / n,
        'operator_context_applies': applies / n,
        'retrieval': {
            'candidates_per_query': args.candidates,
            'distractors': 'same book' if book else 'random from the whole report',
            'top1_accuracy': top1 / n,
            'inversions': inversions / n,
            'mean_margin': mean(margins),
            'margin_p10': ms[int(0.1 * (n - 1))] if ms else 0.0,
            'oracle_top1_accuracy': oracle_top1 / n,
            'oracle_mean_margin': mean(oracle_margins),
        },
        'spec': 'RESEARCH-REPORT.md §3.4 and §6.1; operator set and LaTeX-to-symbol reduction are local assumptions',
    }

    print('样本 %d' % n)
    print('  精确匹配 (evaluate_scratch 口径)      %6.2f%%' % pct(exact))
    print('  规范化后精确匹配                      %6.2f%%' % pct(canon_exact))
    print('  与参考的相似度 均值                    %.4f' % summary['mean_similarity_to_reference'])
    print('  相似度 >= 0.9 的样本                  %6.2f%%' % (100 * summary['similarity_at_least_0_9']))
    print('  运算符上下文适用 (两侧锚点都 >= 2)     %6.2f%%' % pct(applies))
    print('检索模拟 (每题 %d 个候选, 干扰项取自%s)' % (args.candidates, '同一本书' if book else '整个报告随机'))
    print('  识别结果能挑出自己的参考 (top-1)      %6.2f%%' % (100 * summary['retrieval']['top1_accuracy']))
    print('  最强错误候选反超 (倒挂)               %6.2f%%' % (100 * summary['retrieval']['inversions']))
    print('  平均裕量 %.3f   p10 裕量 %.3f' % (summary['retrieval']['mean_margin'], summary['retrieval']['margin_p10']))
    print('  上限: 用参考本身检索的 top-1          %6.2f%%  (平均裕量 %.3f)'
          % (100 * summary['retrieval']['oracle_top1_accuracy'], summary['retrieval']['oracle_mean_margin']))
    if args.output:
        args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
