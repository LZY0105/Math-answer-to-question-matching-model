import { fileURLToPath } from 'node:url';

import { preparePair } from '../src/matching-engine.js';
import { openPdfDocument } from './pdfjs-document-adapter.mjs';


const fixture = (name) => fileURLToPath(new URL(`../output/pdf/demo/${name}`, import.meta.url));

export const SCENARIOS = Object.freeze({
  correct: Object.freeze({
    id: 'correct',
    title: 'Correct pair',
    description: 'Matching exercise and answer books resolve through their question-level structure.',
    exercise: fixture('find-engine-exercise-book.pdf'),
    answer: fixture('find-engine-answer-key.pdf'),
  }),
  wrong: Object.freeze({
    id: 'wrong',
    title: 'Wrong book',
    description: 'A 2026 exercise book paired with a 2025 answer key is blocked before matching.',
    exercise: fixture('find-engine-exercise-book.pdf'),
    answer: fixture('find-engine-wrong-year-answer-key.pdf'),
  }),
  insufficient: Object.freeze({
    id: 'insufficient',
    title: 'Insufficient evidence',
    description: 'A click region cannot be honoured by a text-only adapter, so an automatic answer is capped at REVIEW.',
    exercise: fixture('find-engine-exercise-book.pdf'),
    answer: fixture('find-engine-answer-key.pdf'),
  }),
});


function countRungs(matches) {
  return matches.reduce((counts, match) => {
    const rung = match.rung ?? 'UNKNOWN';
    counts[rung] = (counts[rung] ?? 0) + 1;
    return counts;
  }, {});
}


function compactMatch(match) {
  const answer = match.entry ?? match.answer ?? null;
  return {
    rung: match.rung,
    matched: match.matched,
    asserted: match.asserted ?? false,
    cappedBy: match.cappedBy ?? null,
    question: match.question ? {
      label: match.question.label,
      page: match.question.page,
      text: match.question.text,
    } : null,
    answer: answer ? {
      label: answer.label,
      page: answer.page,
      text: answer.text,
    } : null,
    regionApplied: match.regionApplied ?? null,
    regionReason: match.regionReason ?? null,
    confidence: match.confidence ?? null,
    reasonCodes: match.reasonCodes ?? [],
  };
}


async function matchIndexedQuestions(session) {
  const matches = [];
  for (const question of session.exerciseIndex.entries) {
    const result = await session.matchQuestion({ page: question.page, label: question.label });
    if (result[0]) matches.push(result[0]);
  }
  return matches;
}


export async function runScenario(id) {
  const scenario = SCENARIOS[id];
  if (!scenario) throw new Error(`Unknown scenario: ${id}`);

  const startedAt = performance.now();
  const includeGeometry = id !== 'insufficient';
  const exerciseDocument = await openPdfDocument(scenario.exercise, { includeGeometry });
  const answerDocument = await openPdfDocument(scenario.answer);

  try {
    const prepared = await preparePair({ exerciseDocument, answerDocument });
    let matches = [];
    if (prepared.session) {
      if (id === 'insufficient') {
        matches = await prepared.session.matchQuestion({
          page: 2,
          region: { top: 90, bottom: 260 },
        });
      } else {
        // The public demo models the tablet workflow: one selected question at
        // a time. Supplying the label also prevents an outline span that ends on
        // the next question's page from being counted twice by a whole-page run.
        matches = await matchIndexedQuestions(prepared.session);
      }
    }

    return {
      scenario: scenario.id,
      title: scenario.title,
      description: scenario.description,
      documents: {
        exercise: { name: exerciseDocument.name, pages: exerciseDocument.numPages },
        answer: { name: answerDocument.name, pages: answerDocument.numPages },
      },
      pairStatus: prepared.status,
      decision: prepared.decision,
      summary: {
        total: matches.length,
        rungs: countRungs(matches),
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      },
      matches: matches.map(compactMatch),
    };
  } finally {
    await Promise.all([exerciseDocument.destroy(), answerDocument.destroy()]);
  }
}


export async function runScenarioSuite(ids = Object.keys(SCENARIOS)) {
  const results = [];
  for (const id of ids) results.push(await runScenario(id));
  return results;
}
