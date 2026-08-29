const state = {
  scenario: 'correct',
  request: 0,
};

const elements = Object.fromEntries([
  'decision-workbench', 'decision-state', 'state-label', 'decision-title', 'decision-description',
  'trace-identity', 'trace-question', 'trace-verdict', 'result-count', 'elapsed',
  'exercise-name', 'answer-name', 'exercise-pages', 'answer-pages', 'exercise-pdf',
  'answer-pdf', 'exercise-open', 'answer-open', 'rerun', 'run-note',
  'identity-evidence', 'question-evidence', 'safety-evidence', 'identity-verdict',
  'question-verdict', 'safety-verdict', 'question-excerpt', 'answer-excerpt',
  'mobile-exercise-name', 'mobile-answer-name',
].map(id => [id, document.getElementById(id)]));

const tabs = [...document.querySelectorAll('[data-scenario]')];
const traceSteps = [...document.querySelectorAll('[data-trace]')];

const scenarioFiles = {
  correct: ['find-engine-exercise-book.pdf', 'find-engine-answer-key.pdf'],
  wrong: ['find-engine-exercise-book.pdf', 'find-engine-wrong-year-answer-key.pdf'],
  insufficient: ['find-engine-exercise-book.pdf', 'find-engine-answer-key.pdf'],
};

const labels = {
  correct: {
    loading: 'Validating a matching 2026 exercise and answer set.',
    note: 'Expected: 24 automatic matches with exact question labels.',
  },
  wrong: {
    loading: 'Testing a 2026 exercise book against a 2025 answer key.',
    note: 'Expected: stop before question matching because the years conflict.',
  },
  insufficient: {
    loading: 'Testing a click region with an adapter that cannot honour geometry.',
    note: 'Expected: a high-scoring candidate is still capped at REVIEW.',
  },
};

function setText(id, value) {
  elements[id].textContent = value;
}

function setVerdict(id, text, kind = '') {
  const element = elements[id];
  element.textContent = text;
  element.className = `evidence-verdict${kind ? ` is-${kind}` : ''}`;
}

function setFiles(scenario) {
  const [exercise, answer] = scenarioFiles[scenario];
  const exerciseUrl = `/fixtures/${exercise}`;
  const answerUrl = `/fixtures/${answer}`;
  setText('exercise-name', exercise);
  setText('answer-name', answer);
  setText('mobile-exercise-name', exercise);
  setText('mobile-answer-name', answer);
  elements['exercise-pdf'].src = `${exerciseUrl}#page=2&toolbar=0&navpanes=0&view=FitH`;
  elements['answer-pdf'].src = `${answerUrl}#page=2&toolbar=0&navpanes=0&view=FitH`;
  elements['exercise-open'].href = exerciseUrl;
  elements['answer-open'].href = answerUrl;
}

function markTabs(scenario, busy) {
  for (const tab of tabs) {
    const active = tab.dataset.scenario === scenario;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-pressed', String(active));
    tab.disabled = busy;
  }
  elements.rerun.disabled = busy;
}

function markTrace(classes = {}) {
  for (const step of traceSteps) {
    step.classList.remove('is-complete', 'is-stopped', 'is-review');
    const className = classes[step.dataset.trace];
    if (className) step.classList.add(className);
  }
}

function showLoading(scenario) {
  elements['decision-workbench'].dataset.state = 'loading';
  markTabs(scenario, true);
  markTrace();
  setFiles(scenario);
  setText('state-label', 'Running engine');
  setText('decision-title', 'Checking the evidence…');
  setText('decision-description', labels[scenario].loading);
  setText('trace-identity', 'Reading year · subject · role');
  setText('trace-question', 'Waiting for pair decision');
  setText('trace-verdict', 'Awaiting result');
  setText('result-count', '—');
  setText('elapsed', '—');
  setText('run-note', labels[scenario].note);
  setText('identity-evidence', 'Reading years, subjects, and document roles.');
  setText('question-evidence', 'Waiting for a verified document pair.');
  setText('safety-evidence', 'No answer is shown until the gates finish.');
  setVerdict('identity-verdict', 'Pending');
  setVerdict('question-verdict', 'Pending');
  setVerdict('safety-verdict', 'Pending');
  setText('question-excerpt', '—');
  setText('answer-excerpt', '—');
}

function shorten(text, limit = 145) {
  if (!text) return 'Not available—the engine stopped before this stage.';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function documentIdentity(result) {
  const evidence = result.decision?.evidence;
  const exerciseYear = evidence?.year?.exercise?.year ?? 'unknown';
  const answerYear = evidence?.year?.answer?.year ?? 'unknown';
  const subject = evidence?.subject?.exercise?.subject?.replaceAll('_', ' ') ?? 'unknown subject';
  return { exerciseYear, answerYear, subject };
}

function showResult(result) {
  const first = result.matches[0] ?? null;
  const identity = documentIdentity(result);
  const autoCount = result.summary.rungs.AUTO_MATCH ?? 0;
  const reviewCount = result.summary.rungs.REVIEW ?? 0;

  setText('exercise-name', result.documents.exercise.name);
  setText('answer-name', result.documents.answer.name);
  setText('mobile-exercise-name', result.documents.exercise.name);
  setText('mobile-answer-name', result.documents.answer.name);
  setText('exercise-pages', `${result.documents.exercise.pages} pages`);
  setText('answer-pages', `${result.documents.answer.pages} pages`);
  setText('result-count', String(result.summary.total));
  setText('elapsed', `${result.summary.elapsedMs} ms`);
  setText('question-excerpt', shorten(first?.question?.text));
  setText('answer-excerpt', shorten(first?.answer?.text));

  if (result.pairStatus === 'REJECTED_PAIR') {
    elements['decision-workbench'].dataset.state = 'blocked';
    setText('state-label', 'Blocked safely');
    setText('decision-title', 'Wrong book refused');
    setText('decision-description', 'The exercise and answer books disagree on document identity, so question matching never starts.');
    setText('trace-identity', `${identity.exerciseYear} ≠ ${identity.answerYear} · conflict`);
    setText('trace-question', 'Not run · pair gate stopped');
    setText('trace-verdict', 'PAIR_IDENTITY_MISMATCH');
    setText('run-note', '0 answers shown. The mismatch is rejected before retrieval.');
    setText('identity-evidence', `Exercise ${identity.exerciseYear}; answer ${identity.answerYear}; both classified as ${identity.subject}.`);
    setText('question-evidence', 'Intentionally absent. A failed identity gate cannot enter question matching.');
    setText('safety-evidence', 'Automatic output blocked; no candidate answer is exposed.');
    setVerdict('identity-verdict', 'Conflict', 'blocked');
    setVerdict('question-verdict', 'Not run', 'blocked');
    setVerdict('safety-verdict', 'Refused', 'blocked');
    markTrace({ identity: 'is-stopped', question: 'is-stopped', verdict: 'is-stopped' });
    return;
  }

  const anchors = result.decision?.evidence?.anchors;
  const anchorCopy = anchors ? `${anchors.shared}/${anchors.sampled} shared structural anchors` : 'No anchor evidence';
  setText('identity-evidence', `${identity.exerciseYear} = ${identity.answerYear}; ${identity.subject}; roles are exercise → answer.`);
  setText('trace-identity', `${identity.exerciseYear} · ${identity.subject} · roles verified`);
  setVerdict('identity-verdict', 'Verified');

  if (reviewCount > 0) {
    elements['decision-workbench'].dataset.state = 'review';
    setText('state-label', 'Review required');
    setText('decision-title', 'Evidence capped');
    setText('decision-description', 'The candidate may score highly, but the requested click region cannot be verified by this adapter.');
    setText('trace-question', `${anchorCopy}; region not applied`);
    setText('trace-verdict', first?.cappedBy ?? 'REVIEW');
    setText('run-note', 'The engine returns REVIEW, not an automatic answer.');
    setText('question-evidence', `${anchorCopy}. Region applied: no.`);
    setText('safety-evidence', `${first?.cappedBy ?? 'Evidence cap'} prevents automatic display.`);
    setVerdict('question-verdict', 'Incomplete', 'review');
    setVerdict('safety-verdict', 'Review', 'review');
    markTrace({ identity: 'is-complete', question: 'is-review', verdict: 'is-review' });
    return;
  }

  elements['decision-workbench'].dataset.state = 'matched';
  setText('state-label', 'Automatic match');
  setText('decision-title', `${autoCount} exact matches`);
  setText('decision-description', 'The document pair is verified and every indexed question resolves to the answer with the same label.');
  setText('trace-question', `${anchorCopy}; labels agree`);
  setText('trace-verdict', `AUTO_MATCH × ${autoCount}`);
  setText('run-note', `${autoCount}/${result.summary.total} results reached AUTO_MATCH; labels are unique.`);
  setText('question-evidence', `${anchorCopy}; the sample match uses label ${first?.question?.label ?? '—'}.`);
  setText('safety-evidence', `${autoCount} automatic matches; no review or refusal rung in this run.`);
  setVerdict('question-verdict', 'Complete');
  setVerdict('safety-verdict', 'Auto match');
  markTrace({ identity: 'is-complete', question: 'is-complete', verdict: 'is-complete' });
}

function showError(error) {
  elements['decision-workbench'].dataset.state = 'blocked';
  setText('state-label', 'Demo error');
  setText('decision-title', 'The local run did not finish');
  setText('decision-description', error.message || 'Unknown error');
  setText('run-note', 'Start the demo through npm run demo:web so the API and fixtures are available.');
  setVerdict('identity-verdict', 'Unavailable', 'blocked');
  setVerdict('question-verdict', 'Not run', 'blocked');
  setVerdict('safety-verdict', 'No output', 'blocked');
  markTrace({ identity: 'is-stopped', question: 'is-stopped', verdict: 'is-stopped' });
}

async function run(scenario) {
  state.scenario = scenario;
  const request = ++state.request;
  showLoading(scenario);
  try {
    const response = await fetch(`/api/run?scenario=${encodeURIComponent(scenario)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Engine API returned ${response.status}.`);
    const result = await response.json();
    if (request !== state.request) return;
    showResult(result);
  } catch (error) {
    if (request !== state.request) return;
    showError(error);
  } finally {
    if (request === state.request) markTabs(scenario, false);
  }
}

for (const tab of tabs) tab.addEventListener('click', () => run(tab.dataset.scenario));
elements.rerun.addEventListener('click', () => run(state.scenario));

run(state.scenario);
