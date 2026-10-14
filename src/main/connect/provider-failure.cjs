'use strict';

// Whether an agent's failure means its Claude Code or Codex needs the person (2026-10-14, a beta tester on a fresh Mac:
// "Finding projects was broken … it said try again but it didn't work ever"): the CLI is not there, not signed in, or its
// account cannot run it. Such a failure never passes by trying again, so it is not shown as one: onboarding's discovery
// asks the person to connect that provider, and an import run waits for it (./session.cjs `blocked`) instead of failing
// every job one after another.
//
// What the CLIs say (checked 2026-10-14): Claude Code 2.1.300 signed out answers `-p` with the result "Not logged in ·
// Please run /login" (is_error, error "authentication_failed"); ./agents.cjs says "… was not found on the login shell
// PATH." for a CLI that is gone and "Codex is not signed in with a ChatGPT account" before running Codex without one.
// A usage limit is not here: connecting again does not lift it.

const FAILURE_RE = /not logged in|please run \/login|\/login\b|log ?in again|sign(?:ed)? ?in again|not signed in|signed out|authenticat|unauthori[sz]ed|\b401\b|invalid (?:api[ _-]?key|x-api-key|bearer|token|credentials)|oauth token|token (?:has )?expired|expired (?:token|credentials|session)|credit balance|does(?: not|n['’]t) have access|no access to claude|requires? (?:a )?(?:claude|chatgpt) (?:pro|max|plus|subscription)|subscription (?:required|is required|has expired|expired)|not found on the login shell path|chatgpt account|codex login/i;
const NOT_THIS = /usage.?limit|hit your limit|rate.?limit|overloaded|at capacity/i;

/** `error` (a ConnectError or its message) → whether connecting the provider is what it needs. */
function needsProvider(error) {
  if (!error) return false;
  if (typeof error === 'object' && error.kind === 'stopped') return false;
  const text = String(typeof error === 'string' ? error : error.message || '');
  if (NOT_THIS.test(text)) return false;
  if (typeof error === 'object' && error.kind === 'unavailable') return true;
  return FAILURE_RE.test(text);
}

module.exports = { needsProvider };
