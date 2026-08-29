#!/usr/bin/env node

import { SCENARIOS, runScenarioSuite } from './scenarios.mjs';


function usage() {
  return [
    'Find-Engine public synthetic demo',
    '',
    'Usage:',
    '  npm run demo',
    '  node demo/cli.mjs --scenario correct|wrong|insufficient|all [--json]',
    '',
    'The demo reads the committed synthetic PDFs through PDF.js and calls the',
    'same matchingEngine interface used by host applications.',
  ].join('\n');
}


function parseArgs(argv) {
  const options = { scenario: 'all', json: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--json') options.json = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else if (value === '--scenario') options.scenario = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (options.scenario !== 'all' && !SCENARIOS[options.scenario]) {
    throw new Error(`Unknown scenario: ${options.scenario}`);
  }
  return options;
}


function printHuman(results) {
  console.log('\nFind-Engine · public synthetic PDF demo');
  console.log('Core engine: zero runtime dependencies · Demo adapter: PDF.js\n');
  for (const result of results) {
    const rungs = Object.entries(result.summary.rungs)
      .map(([rung, count]) => `${rung}=${count}`)
      .join(', ') || 'no matches';
    console.log(`[${result.title}]`);
    console.log(`  pair: ${result.pairStatus}`);
    console.log(`  result: ${rungs}`);
    console.log(`  elapsed: ${result.summary.elapsedMs} ms`);
    if (result.decision?.reasonCodes?.length) {
      console.log(`  reasons: ${result.decision.reasonCodes.join(', ')}`);
    }
    const first = result.matches[0];
    if (first?.cappedBy) console.log(`  capped by: ${first.cappedBy}`);
    console.log('');
  }
}


async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const ids = options.scenario === 'all' ? Object.keys(SCENARIOS) : [options.scenario];
  const results = await runScenarioSuite(ids);
  if (options.json) console.log(JSON.stringify(results, null, 2));
  else printHuman(results);
}


main().catch(error => {
  console.error(`Demo failed: ${error.message}`);
  process.exitCode = 1;
});
