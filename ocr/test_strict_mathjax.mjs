import assert from 'node:assert/strict';
import test from 'node:test';
import { createStrictFormulaRenderer } from './strict-mathjax.mjs';

test('an undefined command cannot silently become visible fallback text', () => {
  const renderer = createStrictFormulaRenderer();
  for (const latex of [String.raw`x\leqy`, String.raw`x\pmy`, String.raw`x\timesy`]) {
    assert.throws(() => renderer.render(latex), /Invalid TeX.*Undefined control sequence/);
  }
});

test('a separated operator renders the actual relation and recovers after rejection', () => {
  const renderer = createStrictFormulaRenderer();
  assert.throws(() => renderer.render(String.raw`x\leqy`));
  const svg = renderer.render(String.raw`x\leq y`);
  assert.match(svg, /data-c="2264"/);
  assert.doesNotMatch(svg, /merror|data-mjx-error|leqy/);
});

test('malformed grouping is rejected instead of producing an error image', () => {
  const renderer = createStrictFormulaRenderer();
  assert.throws(() => renderer.render(String.raw`\frac{x}{`), /Invalid TeX/);
});

test('fractions, scripts, integrals and expression matrix cells remain renderable', () => {
  const renderer = createStrictFormulaRenderer();
  for (const latex of [
    String.raw`\frac{x_{i}^{2}+1}{y}`,
    String.raw`\int_{0}^{1}\frac{x}{x+1}\,dx`,
    String.raw`\begin{pmatrix}\sin x&\frac{1}{2}\\x^{2}&\sqrt{y}\end{pmatrix}`,
  ]) assert.match(renderer.render(latex), /^<svg/);
});
