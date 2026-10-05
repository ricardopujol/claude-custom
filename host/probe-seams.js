'use strict';
/**
 * The Git panel's probe seams (verify/probe-git-tree.js): environment variables that point it at a probe's
 * own data instead of gh and ~/.claude. UNSET IN REAL USE.
 *
 *   CLAUDE_CUSTOM_OPEN_PRS_FIXTURE   a file of `gh pr list` JSON stands in for gh (no network, no account)
 *   CLAUDE_CUSTOM_GIT_PROJECTS_DIR   the transcripts come from here, not ~/.claude/projects
 *   CLAUDE_CUSTOM_REVIEWS_DIR        the review reports come from here, not ~/.claude/reviews
 *   CLAUDE_CUSTOM_CLAUDE_HOME        the wand finds skills under here, not ~/.claude (verify/probe-wand.js)
 *   CLAUDE_CUSTOM_OLLAMA_URL         the where-are-we summary talks to this Ollama, not 127.0.0.1:11434 (verify/probe-where-summary.js)
 *   CLAUDE_CUSTOM_SUMMARY_DIR        its summaries and GPU slot live here, not in .harness/state
 *   CLAUDE_CUSTOM_SUMMARY_POWER      'mains' | 'battery': the power state it sees, so a probe doesn't depend on the charger
 *   CLAUDE_CUSTOM_INDEXING_JOURNAL   the indexing field's journal, not .harness/state (verify/probe-indexing-strip.js);
 *                                    it also uses the Ollama, slot folder and power seams above
 *
 * They're read by the production host and main, so a seam that leaks in (a shell that exported one) must be
 * visible: announce() logs one line naming every active seam, and a fixture that can't be read or isn't gh's
 * JSON says so once, instead of reading as "gh is down" (PR #93 Miguel I5).
 */

const nodeFs = require('fs');

const SEAMS = ['CLAUDE_CUSTOM_OPEN_PRS_FIXTURE', 'CLAUDE_CUSTOM_GIT_PROJECTS_DIR', 'CLAUDE_CUSTOM_REVIEWS_DIR', 'CLAUDE_CUSTOM_CLAUDE_HOME',
  'CLAUDE_CUSTOM_OLLAMA_URL', 'CLAUDE_CUSTOM_SUMMARY_DIR', 'CLAUDE_CUSTOM_SUMMARY_POWER', 'CLAUDE_CUSTOM_INDEXING_JOURNAL'];

const val = (env, k) => (env && typeof env[k] === 'string' && env[k] !== '' ? env[k] : null);

function readSeams(env) {
  return {
    openPrsFixture: val(env, SEAMS[0]),
    projectsDir: val(env, SEAMS[1]),
    reviewsDir: val(env, SEAMS[2]),
    claudeHome: val(env, SEAMS[3]),
    ollamaUrl: val(env, SEAMS[4]),
    summaryDir: val(env, SEAMS[5]),
    summaryPower: ['mains', 'battery'].includes(val(env, SEAMS[6])) ? val(env, SEAMS[6]) : null,
    indexingJournal: val(env, SEAMS[7]),
    active: SEAMS.filter(k => (k === SEAMS[6] ? ['mains', 'battery'].includes(val(env, k)) : val(env, k) !== null)),
  };
}

/** Logs one line when any seam is set; answers whether it did. */
function announce(seams, log) {
  if (!seams || !seams.active.length) return false;
  log(`[seams] probe seams active: ${seams.active.join(', ')} -- the panels read the probe's data, not gh / ~/.claude`);
  return true;
}

/** An async reader of the open-PRs fixture: parse()'s answer, or null (unknown) -- said once, not silently. */
function fixtureReader(file, { parse, log, readFile = nodeFs.readFileSync } = {}) {
  let said = false;
  const once = (line) => { if (!said) { said = true; log(line); } };
  return async () => {
    let text;
    try {
      text = readFile(file, 'utf8');
    } catch (err) {
      once(`[seams] can't read the open-PRs fixture ${file}: ${(err && err.message) || err}`);
      return null;
    }
    const parsed = parse(text);
    if (parsed === null || parsed === undefined) once(`[seams] the open-PRs fixture ${file} is not gh pr list JSON`);
    return parsed === undefined ? null : parsed;
  };
}

module.exports = { readSeams, announce, fixtureReader, SEAMS };
