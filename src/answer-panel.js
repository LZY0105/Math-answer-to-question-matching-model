// PDF Module — the answer-lookup panel.
//
// Shows the answer for each question on the current exercise page. It renders
// what the matcher decided and never decides anything itself.
//
// The governing display rule: a match's CONFIDENCE must be visible, not buried.
// A number-only match across an unaligned book is a guess, and presenting it
// with the same authority as a chapter-aligned content match would quietly
// mislead — the user cannot tell the two apart from the answer text alone.
// Weak matches are therefore labelled, and ambiguous ones show the alternatives
// instead of a choice this module is not entitled to make.

import { CONFIDENCE } from './question-matcher.js';

const CONFIDENCE_META = {
  [CONFIDENCE.HIGH]: { label: '匹配可靠', className: 'is-high' },
  [CONFIDENCE.MEDIUM]: { label: '较可能匹配', className: 'is-medium' },
  [CONFIDENCE.LOW]: { label: '匹配不确定，请自行核对', className: 'is-low' },
  [CONFIDENCE.NONE]: { label: '无法确定', className: 'is-none' },
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** A plain message: no answer book, scanned document, nothing on this page. */
export function renderAnswerNotice(host, message) {
  if (!host) return;
  host.innerHTML = `<div class="answer-panel"><div class="answer-notice">${escapeHtml(message)}</div></div>`;
}

/**
 * Renders one row per question on the page.
 *
 * The answer is hidden behind a disclosure by default. Someone working through
 * an exercise usually wants to attempt it first, and a panel that reveals every
 * answer the moment it opens would remove that choice.
 */
export function renderAnswerMatches(host, matches, {
  page, aligned, onReveal, textQuality,
} = {}) {
  if (!host) return;

  // OPAQUE text compares correctly but decodes to nothing a reader recognises —
  // the CJK mapping is broken, so it renders as a stream of Bengali and Thai.
  // It is legitimate evidence for the MATCH and must never be shown as the
  // ANSWER; the reader is sent to the page instead.
  const displayable = textQuality !== 'OPAQUE';

  const header = `
    <div class="answer-head">
      <span>第 ${page} 页 · ${matches.length} 题</span>
      <span class="answer-stage">${aligned ? '已按目录章节对齐' : '未使用目录对齐'}</span>
    </div>`;

  const wrap = document.createElement('div');
  wrap.className = 'answer-panel';
  wrap.innerHTML = header;

  for (const match of matches) {
    const meta = CONFIDENCE_META[match.confidence] || CONFIDENCE_META[CONFIDENCE.NONE];
    const row = document.createElement('div');
    row.className = `answer-row ${meta.className}`;

    const label = match.question.label ? `第 ${escapeHtml(match.question.label)} 题` : '未编号';
    const preview = displayable
      ? escapeHtml(String(match.question.text || '').slice(0, 60))
      : '';

    if (!match.matched) {
      // Ambiguity is shown as ambiguity, with the alternatives listed so the
      // user can decide — the module must not pick one for them.
      // An entry indexed from the bookmark tree alone carries no text — that is
      // the normal case when the text layer was rejected — so the id and the
      // page have to identify the alternative on their own.
      const alts = (match.candidates || []).map((c) => {
        const body = displayable ? (c.answer || c.text) : '';
        const where = `第 ${escapeHtml(c.label)} 题 · 答案册第 ${escapeHtml(c.page)} 页`;
        return `<li>${where}${body ? `：${escapeHtml(body)}` : ''}</li>`;
      }).join('');
      row.innerHTML = `
        <div class="answer-q"><b>${label}</b> <span class="answer-conf ${meta.className}">${meta.label}</span></div>
        <div class="answer-qtext">${preview}</div>
        <div class="answer-reason">${escapeHtml(match.reason || '')}</div>
        ${alts ? `<ul class="answer-alts">${alts}</ul>` : ''}`;
      wrap.appendChild(row);
      continue;
    }

    row.innerHTML = `
      <div class="answer-q">
        <b>${label}</b>
        <span class="answer-conf ${meta.className}">${meta.label}</span>
        <button type="button" class="answer-goto" data-role="goto">答案册第 ${escapeHtml(match.entry.page)} 页</button>
      </div>
      <div class="answer-qtext">${preview}</div>
      <details class="answer-reveal">
        <summary>显示答案</summary>
        <div class="answer-value">${displayable && (match.entry.answer || match.entry.text)
          ? escapeHtml(match.entry.answer || match.entry.text)
          : `<span class="answer-empty">此书文本层无法显示，请翻到答案册第 ${escapeHtml(match.entry.page)} 页查看</span>`}</div>
      </details>
      <div class="answer-reason">${escapeHtml(match.reason || '')}</div>`;

    row.querySelector('[data-role="goto"]')?.addEventListener('click', () => onReveal?.(match));
    wrap.appendChild(row);
  }

  host.replaceChildren(wrap);
}
