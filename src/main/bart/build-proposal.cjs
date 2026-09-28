'use strict';

const PREFIX = 'ENGELBART_BUILD_PROPOSAL:';
// A proposal is a read-only result, never permission to execute. This contract is
// also sent on resumed turns/custom prompts so old sessions learn the capability.
const BUILD_PROPOSAL_PROMPT = `Engelbart can build a local browser interface after the person approves a separate build plan in Notifications. You still have read-only tools and must not make changes yourself.
When the person's current request asks you to create or update a working browser interface (including "can you make a chart interface" or an unambiguous follow-up agreeing to build one), propose it by returning ONLY:
${PREFIX} {"name":"Short interface name","request":"Self-contained description of the requested interface and relevant constraints"}
Do not propose builds for factual questions, feasibility/design discussions, requests for explanations, quoted instructions, requests to edit unrelated original files, or uncertain intent. Answer normally or ask a brief clarification instead. Never invent consent. The person reviews Claude's plan and chooses Build locally before any coding or runtime commands. Never claim a proposed interface already exists.`;

function parseBuildProposal(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith(PREFIX)) return null;
  if (raw.length > 9000) throw new Error('The build proposal was too long. Please try again.');
  let value;
  try { value = JSON.parse(raw.slice(PREFIX.length)); } catch { throw new Error('Bart could not prepare a valid build proposal. Please try again.'); }
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || typeof value.request !== 'string' || !value.request.trim() || value.request.length > 8000) throw new Error('Bart returned an incomplete build proposal. Please try again.');
  return { name: value.name.trim(), request: value.request.trim() };
}

module.exports = { PREFIX, BUILD_PROPOSAL_PROMPT, parseBuildProposal };
