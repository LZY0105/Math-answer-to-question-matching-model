#!/usr/bin/env node
// The wrong-book / wrong-role matrix, run through the public interface only.
//
// Every combination goes through preparePair(). Testing an internal helper would
// prove nothing: the defect being measured is that a caller could bypass the
// gates, so the gates have to be exercised where a caller would meet them.
//
// A combination passes when it produces zero AUTO_MATCH results. Rejection at
// the document level is better still, and is reported separately.

import { readFileSync } from 'node:fs';
import { preparePair } from '../src/matching-engine.js';
import { PAIR_STATUS, RUNG } from '../src/decision.js';

const CORPUS = process.argv[2] || 'tmp/expanded-corpus-20260825.json';
const raw = JSON.parse(readFileSync(CORPUS, 'utf-8'));

const ROLES = {
  q2023: 'EX', a2024: 'EX', g2024: 'EX', q2025: 'EX',
  ans2023: 'ANS', a2024_ma: 'ANS', a2024_alg: 'ANS', a2025: 'ANS',
};
const VALID = new Set(['q2023|ans2023', 'a2024|a2024_ma', 'g2024|a2024_alg', 'q2025|a2025']);

const asDoc = (d) => ({
  numPages: d.numPages,
  outline: d.outline,
  async extractText({ from, to } = {}) {
    if (from == null && to == null) return d.lines;
    return d.lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
  },
});

const keys = Object.keys(ROLES);
const rows = [];

for (const L of keys) {
  for (const R of keys) {
    if (L === R && ROLES[L] === 'EX') { /* Q->Q self still counts */ }
    const combo = `${L}|${R}`;
    const isValid = VALID.has(combo);
    const prepared = await preparePair({
      exerciseDocument: asDoc(raw[L]),
      answerDocument: asDoc(raw[R]),
      expectScript: 'han',
    });

    let auto = 0;
    let accepted = 0;
    let pages = 0;
    if (prepared.session) {
      const ex = raw[L];
      // Sample pages: the point is whether ANY auto-match escapes, and a stride
      // that touches every section is enough to establish that cheaply.
      const stride = Math.max(1, Math.floor(ex.numPages / 40));
      for (let p = 1; p <= ex.numPages; p += stride) {
        const ms = await prepared.session.matchQuestion({ page: p });
        pages++;
        for (const m of ms) {
          if (m.rung === RUNG.AUTO_MATCH) auto++;
          if (m.matched) accepted++;
        }
      }
    }

    rows.push({
      combo, L, R, isValid,
      leftRole: ROLES[L], rightRole: ROLES[R],
      pairStatus: prepared.status,
      blocked: prepared.status === PAIR_STATUS.REJECTED_PAIR,
      reason: prepared.decision.reasonCodes.join(','),
      auto, accepted, pages,
    });
  }
}

const invalid = rows.filter(r => !r.isValid);
const valid = rows.filter(r => r.isValid);

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  Pair / role matrix through preparePair() only');
console.log('═══════════════════════════════════════════════════════════════════════');

console.log(`\n── invalid combinations: ${invalid.length} ──`);
const leaked = invalid.filter(r => r.auto > 0);
const blocked = invalid.filter(r => r.blocked);
console.log(`  blocked at document level : ${blocked.length}/${invalid.length}`);
console.log(`  produced any AUTO_MATCH   : ${leaked.length}/${invalid.length}`);
console.log(`  total AUTO_MATCH leaked   : ${invalid.reduce((s, r) => s + r.auto, 0)}`);
if (leaked.length) {
  console.log('\n  LEAKS:');
  for (const r of leaked.slice(0, 12)) {
    console.log(`    ${r.combo.padEnd(24)} ${r.leftRole}->${r.rightRole}`
      + ` status=${r.pairStatus} auto=${r.auto} reason=${r.reason}`);
  }
}
const byReason = new Map();
for (const r of invalid) byReason.set(r.reason || '(none)', (byReason.get(r.reason || '(none)') || 0) + 1);
console.log('\n  rejection reasons:');
for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}  ${reason}`);
}

console.log(`\n── valid pairs: ${valid.length} ──`);
for (const r of valid) {
  console.log(`  ${r.combo.padEnd(24)} status=${String(r.pairStatus).padEnd(14)}`
    + ` auto=${String(r.auto).padStart(5)} accepted=${String(r.accepted).padStart(5)}`
    + ` reason=${r.reason || '-'}`);
}
console.log('');
