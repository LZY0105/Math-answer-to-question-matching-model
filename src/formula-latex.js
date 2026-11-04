// LaTeX, as a formula recogniser emits it, in the form the matcher reads.
//
// The engine scores text the way a PDF text layer presents it: the printed
// symbols in reading order, scripts inline after their base, no markup. A
// recognised formula arrives as LaTeX — x^{2}, \frac{1}{x+1}, \lim_{x \to 0} —
// and compared as-is it would score against a text layer the way two different
// typesettings of one formula score against each other: as a conflict. The
// report's §7.5 says it plainly: thresholds do not survive a change of
// representation. So the representation is changed back before anything is
// scored.
//
// The target is what the demo adapter produces from a text layer for the same
// printed formula, measured on the 2024 books:
//
//   printed        text layer      LaTeX                       here
//   x³ + 3x + 1    x 3 + 3 x + 1   x^{3}+3x+1                  x3+3x+1
//   aₙ₊₁           a n +1          a_{n+1}                     an+1
//   √(x²+1)        √ x 2 + 1       \sqrt{x^{2}+1}              √x2+1
//   α ≤ β          α ≤ β           \alpha \leq \beta           α≤β
//   lim x→0        lim x → 0       \lim_{x \to 0}              lim x→0
//
// Fractions have no text-layer form at all: the bar is drawn, not typed, and
// the numerator and denominator land on separate rows. They are emitted as
// A/B here because a slash is at least the right operator, and the option is
// kept open (`fractions: 'stack'`) because the right choice is a measurement,
// not a convention.
//
// What is deliberately lost: ^ and _ themselves (the text layer has neither),
// the grouping of a multi-token script (x^{2+1} reads as x2+1, exactly as the
// text layer reads it), font wrappers, sizing, spacing. What is kept: every
// visible symbol, every bracket kind as printed, the order of everything.
//
// The canonicalisation in ocr/evaluate_matching.py serves a different
// comparison — model output against teacher output, both LaTeX — and keeps
// what this one drops. The two agree on what is invisible.

/** One LaTeX token: an environment delimiter, a command, an escaped char, or a char. */
const TOKEN = /\\(?:begin|end)\{[a-zA-Z*]+\}|\\[A-Za-z]+|\\.|./gsu;

/** Commands that change layout and draw nothing. */
const TYPESETTING = new Set([
  ',', ';', '!', ':', ' ', 'quad', 'qquad', 'left', 'right', 'middle',
  'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle',
  'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr',
  'limits', 'nolimits', 'notag', 'nonumber', 'phantom', 'hphantom', 'vphantom', 'allowbreak',
].map(x => '\\' + x));

/** Font and text wrappers: the typeface changes, the content does not. */
const STYLE = new Set([
  'mathrm', 'mathit', 'mathbf', 'mathsf', 'mathtt', 'textrm', 'textit', 'textbf', 'textsf',
  'texttt', 'text', 'mbox', 'hbox', 'operatorname', 'boldsymbol', 'bm', 'rm', 'bf', 'it', 'sf', 'tt',
  'mathbb', 'mathcal', 'mathfrak', 'mathscr', 'mathnormal',
].map(x => '\\' + x));

/** Accents: the text layer prints the letter and draws the mark. */
const ACCENT = new Set([
  'hat', 'widehat', 'bar', 'overline', 'underline', 'vec', 'tilde', 'widetilde', 'dot', 'ddot',
  'check', 'breve', 'acute', 'grave', 'overrightarrow', 'overleftarrow', 'underbrace', 'overbrace',
].map(x => '\\' + x));

/** Commands that become one printed symbol. */
const SYMBOL = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', varrho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ',
  Psi: 'Ψ', Omega: 'Ω',
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', ast: '*', star: '*', circ: '∘', bullet: '•',
  leq: '≤', le: '≤', leqslant: '≤', geq: '≥', ge: '≥', geqslant: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
  to: '→', rightarrow: '→', longrightarrow: '→', Rightarrow: '⇒', Longrightarrow: '⇒', implies: '⇒',
  leftarrow: '←', longleftarrow: '←', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
  Longleftrightarrow: '⇔', iff: '⇔', mapsto: '↦', longmapsto: '↦', uparrow: '↑', downarrow: '↓',
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨',
  int: '∫', iint: '∬', iiint: '∭', oint: '∮', sum: '∑', prod: '∏', coprod: '∐',
  sqrt: '√', prime: '′', cdots: '···', ldots: '...', dots: '...', dotsc: '...', dotsb: '···', vdots: '⋮', ddots: '⋱',
  oplus: '⊕', otimes: '⊗', ominus: '⊖', perp: '⊥', parallel: '∥', angle: '∠', triangle: '△',
  langle: '<', rangle: '>', lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']', vert: '|', Vert: '||',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', backslash: '\\', hbar: 'ℏ', ell: 'ℓ', Re: 'Re', Im: 'Im',
  aleph: 'ℵ', degree: '°', because: '∵', therefore: '∴', top: '⊤', bot: '⊥', mid: '|', nmid: '∤',
  colon: ':', dagger: '†', S: '§',
  nleq: '≰', nleqslant: '≰', ngeq: '≱', ngeqslant: '≱', nless: '≮', ngtr: '≯',
  nsubseteq: '⊈', nsupseteq: '⊉', nsim: '≁', ncong: '≇', nrightarrow: '↛', nparallel: '∦',
};

/**
 * A relation and its negation, as \not before the relation prints it.
 *
 * TeX's \not is a zero-width slash laid over whatever follows: \not= prints ≠,
 * \not\in prints ∉. The demo adapter reads the same pair off a text layer
 * (demo/pdfjs-document-adapter.mjs), so both sides of a comparison name the
 * negated relation by one code point.
 */
export const NEGATED_RELATION = Object.freeze({
  '=': '≠', '≡': '≢', '∼': '≁', '≈': '≉', '≅': '≇', '→': '↛', '∈': '∉', '∋': '∌',
  '⊂': '⊄', '⊃': '⊅', '⊆': '⊈', '⊇': '⊉', '<': '≮', '>': '≯', '≤': '≰', '≥': '≱',
  '|': '∤', '∥': '∦', '∃': '∄',
});

/** Matrix environments and the brackets they print. */
const MATRIX = {
  pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['||', '||'],
  matrix: ['', ''], smallmatrix: ['', ''], array: ['', ''], cases: ['{', ''], aligned: ['', ''],
  align: ['', ''], 'align*': ['', ''], gathered: ['', ''], gather: ['', ''], split: ['', ''],
  equation: ['', ''], 'equation*': ['', ''], eqnarray: ['', ''], 'eqnarray*': ['', ''],
};

/** Tokens into nested arrays, one array per {...} group. Unbalanced input closes at the end. */
function nest(tokens) {
  const root = [];
  const stack = [];
  let current = root;
  for (const tok of tokens) {
    if (tok === '{') {
      stack.push(current);
      const group = [];
      current.push(group);
      current = group;
    } else if (tok === '}') {
      if (stack.length) current = stack.pop();
    } else {
      current.push(tok);
    }
  }
  return root;
}

/**
 * Converts LaTeX to the matcher's text form.
 *
 * @param {string} latex
 * @param {{fractions?: 'slash'|'stack', scripts?: 'inline'|'caret'}} [options]
 *   fractions: 'slash' emits A/B (default); 'stack' emits the numerator then
 *   the denominator with nothing between, which is what a text layer yields.
 *   scripts: 'inline' drops ^ and _ (default, the text layer has neither);
 *   'caret' keeps them, for comparing two recognised formulas against each
 *   other where the anchor is worth having.
 * @returns {string}
 */
export function latexToText(latex, { fractions = 'slash', scripts = 'inline' } = {}) {
  const tokens = String(latex ?? '').match(TOKEN) ?? [];
  const out = [];
  const emit = (s) => { if (s) out.push(s); };

  // A structural argument, rendered. Multi-token arguments of a fraction are
  // bracketed so the slash binds the way the bar did; scripts are not, because
  // the text layer does not bracket them either.
  const render = (item, opts) => {
    if (Array.isArray(item)) {
      const inner = [];
      walk(item, inner, opts);
      return inner.join('');
    }
    return atom(item, opts);
  };
  const atom = (tok, opts) => {
    const inner = [];
    walk([tok], inner, opts);
    return inner.join('');
  };
  const bracketIfLong = (s) => (s.length > 1 ? `(${s})` : s);

  function walk(items, sink, opts) {
    let i = 0;
    const next = () => items[i++];
    const peek = () => items[i];
    while (i < items.length) {
      const item = next();
      if (Array.isArray(item)) {
        // A plain brace group draws nothing; its contents do.
        walk(item, sink, opts);
        continue;
      }
      const tok = item;
      if (/^\s+$/u.test(tok)) continue;
      if (tok === '~' || tok === '$' || tok === '&') { sink.push(' '); continue; }
      if (tok === '\\\\') { sink.push(' '); continue; }
      if (tok === "'") { sink.push('′'); continue; }
      if (TYPESETTING.has(tok)) {
        // \left. and \right. are invisible delimiters: the dot draws nothing.
        if ((tok === '\\left' || tok === '\\right' || tok === '\\middle') && peek() === '.') next();
        continue;
      }
      if (STYLE.has(tok)) continue;             // the wrapped group follows and renders itself
      if (tok === '^' || tok === '_') {
        if (opts.scripts === 'caret') sink.push(tok);
        const arg = next();
        if (arg !== undefined) sink.push(render(arg, opts));
        continue;
      }
      if (tok === '\\frac' || tok === '\\dfrac' || tok === '\\tfrac' || tok === '\\cfrac') {
        const a = render(next() ?? '', opts);
        const b = render(next() ?? '', opts);
        sink.push(opts.fractions === 'stack' ? `${a} ${b}` : `${bracketIfLong(a)}/${bracketIfLong(b)}`);
        continue;
      }
      if (tok === '\\binom' || tok === '\\dbinom' || tok === '\\tbinom') {
        const a = render(next() ?? '', opts);
        const b = render(next() ?? '', opts);
        sink.push(`(${a} ${b})`);
        continue;
      }
      if (tok === '\\sqrt') {
        let index = '';
        if (peek() === '[') {
          next();
          const idx = [];
          while (i < items.length && peek() !== ']') idx.push(next());
          next();
          index = render(idx, opts);
        }
        const arg = next();
        sink.push(`${index}√${arg === undefined ? '' : render(arg, opts)}`);
        continue;
      }
      if (ACCENT.has(tok)) {
        const arg = next();
        if (arg !== undefined) sink.push(render(arg, opts));
        continue;
      }
      if (tok === '\\overset' || tok === '\\underset' || tok === '\\stackrel') {
        const a = render(next() ?? '', opts);
        const b = render(next() ?? '', opts);
        sink.push(`${b}${a}`);
        continue;
      }
      if (tok === '\\xrightarrow' || tok === '\\xleftarrow') {
        const arg = next();
        sink.push(`${tok === '\\xrightarrow' ? '→' : '←'}${arg === undefined ? '' : render(arg, opts)}`);
        continue;
      }
      const env = tok.match(/^\\(begin|end)\{([a-zA-Z*]+)\}$/u);
      if (env) {
        const brackets = MATRIX[env[2]];
        if (brackets) sink.push(env[1] === 'begin' ? brackets[0] : brackets[1]);
        if (env[1] === 'begin' && (env[2] === 'array' || env[2] === 'tabular') && Array.isArray(peek())) next(); // column spec
        continue;
      }
      if (tok === '\\not') {
        // The slash negates the relation after it; with nothing to negate it
        // prints nothing readable.
        const arg = next();
        const rel = arg === undefined ? '' : render(arg, opts);
        if (rel) sink.push(NEGATED_RELATION[rel] ?? `${rel}\u0338`);
        continue;
      }
      if (tok.startsWith('\\') && tok.length > 1) {
        const name = tok.slice(1);
        if (name in SYMBOL) { sink.push(SYMBOL[name]); continue; }
        if (/^[A-Za-z]+$/u.test(name)) { sink.push(name); continue; }   // \lim, \sin, \ln, \det ...
        sink.push(name);                                               // \{ \} \| \% \_ ...
        continue;
      }
      sink.push(tok);
    }
  }

  walk(nest(tokens), out, { fractions, scripts });
  return out.join('').replace(/\s+/gu, ' ').trim();
}

/**
 * Whether a string looks like LaTeX rather than printed text, for a
 * recogniser that does not say which it returned.
 */
export function looksLikeLatex(text) {
  return /\\[A-Za-z]+|[{}^_]/u.test(String(text ?? ''));
}
