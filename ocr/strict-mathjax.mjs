// Shared fail-closed TeX rendering for authored OCR training labels.
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

export const STRICT_TEX_POLICY = Object.freeze({
  version: 1,
  disabled_packages: ['noerrors', 'noundefined'],
  parser_errors: 'throw',
  output_error_nodes: 'reject merror and data-mjx-error',
});

export function createStrictFormulaRenderer() {
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document('', {
    InputJax: new TeX({
      packages: AllPackages.filter(name => !STRICT_TEX_POLICY.disabled_packages.includes(name)),
      // Never turn malformed TeX into a visible error message training image.
      formatError: (_jax, error) => { throw error; },
    }),
    OutputJax: new SVG({ fontCache: 'none' }),
  });
  return {
    render(latex) {
      if (typeof latex !== 'string' || !latex.trim()) throw new TypeError('Formula must be a nonempty TeX string');
      try {
        const converted = document.convert(latex, { display: true });
        const svg = adaptor.outerHTML(adaptor.firstChild(converted));
        if (!svg.startsWith('<svg') || /data-mjx-error|data-mml-node=["']merror["']|<(?:[\w-]+:)?merror(?:\s|>)/i.test(svg)) {
          throw new Error('MathJax returned an error node or a non-SVG result');
        }
        return svg;
      } catch (error) {
        throw new Error(`Invalid TeX ${JSON.stringify(latex)}: ${error?.message ?? String(error)}`, { cause: error });
      }
    },
  };
}
