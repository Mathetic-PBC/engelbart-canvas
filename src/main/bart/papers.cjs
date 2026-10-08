'use strict';

// @discover's paper tools (2026-09-30): resolve, references, citations, author_works, related and search, over OpenAlex
// (api.openalex.org), which answers without a key. Served to either CLI by ./papers-mcp.cjs. Nothing here reads or
// writes the disk, and nothing of the person's is sent: only what the agent looks up.
//
// OpenAlex prices each call against a small daily allowance for callers without a key (checked 2026-09-30: $0.10 a
// day; a record by its id is free, a filtered list $0.0001, a search $0.001), so the tools prefer lookups by id and
// filters to searches. A trace of a dozen papers costs well under a cent. Semantic Scholar was the other candidate; it
// refuses callers without a key most of the time (429).
//
// A record is what the agent needs to write a guide entry and to go on tracing: an id to pass to the other tools, the
// title, authors, year, venue, DOI, abstract, an open-access address and an arXiv page when there are any. Lists carry
// no abstract (resolve gives it), so a list of a hundred references stays small.
//
// The key (2026-10-08): nothing passed one before, and the keyless allowance ran out in a day of testing, every search
// then a 429. OPENALEX_API_KEY in the environment, else ~/.engelbart/config.json `openalex.apiKey`, read for every call so
// a key pasted in takes effect at once. After a 429 the tools say so for LIMITED_MS without calling again (`limited()`),
// so a climb can tell "OpenAlex is not available" from "nothing was found". ENGELBART_OPENALEX_API names a fake OpenAlex,
// for tests and scripted runs only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API = 'https://api.openalex.org';
const ARXIV_API = 'https://export.arxiv.org/api/query';
const TIMEOUT_MS = 20_000;
const LIMITED_MS = 10 * 60_000;
const MAX_LIST = 100;
const LIST_FIELDS = 'id,title,publication_year,authorships,primary_location,doi,cited_by_count,type';
const FULL_FIELDS = `${LIST_FIELDS},abstract_inverted_index,best_oa_location,open_access,locations,referenced_works_count,referenced_works,related_works`;

const DOI_RE = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i;
const ARXIV_RE = /^(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)?((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?(?:\.pdf)?$/i;
const WORK_RE = /^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i;
const AUTHOR_RE = /^(?:https?:\/\/openalex\.org\/)?(A\d+)$/i;

const short = (id) => String(id || '').replace(/^https?:\/\/openalex\.org\//, '');
const bareDoi = (doi) => (doi ? String(doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') : null);

/** OpenAlex keeps an abstract as word → positions; this puts the words back in order. */
function abstractOf(index) {
  if (!index || typeof index !== 'object') return null;
  const words = [];
  for (const [word, places] of Object.entries(index)) for (const at of Array.isArray(places) ? places : []) if (Number.isInteger(at) && at >= 0 && at < 20000) words[at] = word;
  const text = words.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 4000) : null;
}

function authorsOf(work, max) {
  const names = (Array.isArray(work.authorships) ? work.authorships : []).map((one) => one && one.author && one.author.display_name).filter(Boolean);
  return names.length > max ? [...names.slice(0, max), `et al. (${names.length} authors)`] : names;
}

const venueOf = (work) => (work.primary_location && ((work.primary_location.source && work.primary_location.source.display_name) || work.primary_location.raw_source_name)) || null;

function arxivOf(work) {
  for (const place of Array.isArray(work.locations) ? work.locations : []) {
    const m = String((place && place.landing_page_url) || '').match(/arxiv\.org\/abs\/([^?#\s]+)/i);
    if (m) return `https://arxiv.org/abs/${m[1].replace(/v\d+$/, '')}`;
  }
  const doi = bareDoi(work.doi);
  const m = doi && doi.match(/^10\.48550\/arxiv\.(.+)$/i);
  return m ? `https://arxiv.org/abs/${m[1]}` : null;
}

function openAccessOf(work) {
  const best = work.best_oa_location;
  if (best && best.pdf_url) return best.pdf_url;
  for (const place of Array.isArray(work.locations) ? work.locations : []) if (place && place.is_oa && place.pdf_url) return place.pdf_url;
  return (work.open_access && work.open_access.is_oa && work.open_access.oa_url) || (best && best.landing_page_url) || null;
}

/** An OpenAlex work as a list shows it. */
function listRecord(work) {
  return { id: short(work.id), title: work.title || '(untitled)', authors: authorsOf(work, 3), year: work.publication_year || null, venue: venueOf(work), type: work.type || null, doi: bareDoi(work.doi), cited_by: work.cited_by_count || 0 };
}

/** An OpenAlex work in full: what resolve returns. */
function fullRecord(work) {
  return {
    ...listRecord(work),
    authors: authorsOf(work, 12),
    abstract: abstractOf(work.abstract_inverted_index),
    open_access: openAccessOf(work),
    arxiv: arxivOf(work),
    doi_url: work.doi || null,
    references: work.referenced_works_count || 0,
    openalex: work.id || null,
  };
}

class PapersError extends Error {
  constructor(message, code = null) { super(message); if (code) this.code = code; }
}

/** The OpenAlex key: OPENALEX_API_KEY, else config.json's `openalex.apiKey` under `root` (~/.engelbart); null without one. */
function openAlexKey({ env = process.env, root = path.join(os.homedir(), '.engelbart') } = {}) {
  const fromEnv = String(env.OPENALEX_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const key = config && config.openalex && typeof config.openalex.apiKey === 'string' ? config.openalex.apiKey.trim() : '';
    return key || null;
  } catch { return null; }
}

const LIMITED = 'OpenAlex refused the call: the daily allowance for callers without a key is used up, or too many calls came at once.';

/**
 * `fetchImpl`, `wait` and `clock` are for tests. `apiKey`: a key, or a function asked for one each call (openAlexKey by
 * default). `api`: OpenAlex's address (ENGELBART_OPENALEX_API, a fake, else the real one).
 */
function createPapers({ fetchImpl = globalThis.fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), apiKey = () => openAlexKey(), api: base = process.env.ENGELBART_OPENALEX_API || API, clock = () => Date.now() } = {}) {
  let limitedAt = null; // when OpenAlex last answered 429; null once a call has gone through since
  const limited = () => limitedAt != null && clock() - limitedAt < LIMITED_MS;
  async function get(url, { json = true } = {}) {
    if (limited()) throw new PapersError(LIMITED, 'rate-limited');
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, { headers: { 'user-agent': 'Engelbart (research desktop app)', accept: json ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (error) {
        if (attempt === 0) { await wait(1500); continue; }
        throw new PapersError(`OpenAlex could not be reached (${String(error && error.message || error).split('\n')[0]}).`);
      }
      if (response.status === 404) { limitedAt = null; return null; }
      if ((response.status === 429 || response.status >= 500) && attempt === 0) { await wait(1500); continue; }
      if (response.status === 429) { limitedAt = clock(); throw new PapersError(LIMITED, 'rate-limited'); }
      if (!response.ok) throw new PapersError(`OpenAlex answered ${response.status}.`);
      limitedAt = null;
      return json ? response.json() : response.text();
    }
  }
  const api = (route, params = {}) => {
    const url = new URL(`${base}${route}`);
    for (const [key, value] of Object.entries(params)) if (value != null && value !== '') url.searchParams.set(key, String(value));
    const key = typeof apiKey === 'function' ? apiKey() : apiKey;
    if (key) url.searchParams.set('api_key', key);
    return get(url.toString());
  };
  const work = (id) => api(`/works/${id}`, { select: FULL_FIELDS });
  const list = async (filter, { sort, limit, search } = {}) => {
    const page = await api('/works', { filter, sort, search, per_page: Math.min(MAX_LIST, limit), select: LIST_FIELDS });
    return { total: (page && page.meta && page.meta.count) || 0, results: ((page && page.results) || []).map(listRecord) };
  };
  const byIds = async (ids) => {
    const out = new Map();
    for (let n = 0; n < ids.length; n += 50) {
      const page = await api('/works', { filter: `openalex:${ids.slice(n, n + 50).join('|')}`, per_page: 50, select: LIST_FIELDS });
      for (const one of (page && page.results) || []) out.set(short(one.id), listRecord(one));
    }
    return ids.map((id) => out.get(id)).filter(Boolean);
  };
  const clean = (text) => String(text || '').replace(/[,|:]/g, ' ').replace(/\s+/g, ' ').trim();
  const years = (from, until) => [from ? `from_publication_date:${Number(from)}-01-01` : '', until ? `to_publication_date:${Number(until)}-12-31` : ''].filter(Boolean);
  const count = (value, fallback, max = MAX_LIST) => Math.max(1, Math.min(max, Number.isInteger(value) ? value : fallback));

  /** A DOI, an arXiv id or address, an OpenAlex id, or a title → the one work it names, in full, or null. */
  async function findWork(query) {
    const text = String(query || '').trim();
    if (!text) throw new PapersError('Give a DOI, an arXiv id or a title.');
    let m;
    if ((m = text.match(WORK_RE))) return work(m[1].toUpperCase());
    if ((m = text.match(DOI_RE))) return work(`doi:${m[1].replace(/[.,;]+$/, '')}`);
    if ((m = text.match(ARXIV_RE))) {
      const byDoi = await work(`doi:10.48550/arxiv.${m[1]}`);
      if (byDoi) return byDoi;
      // Not every arXiv paper has its DataCite DOI in OpenAlex: its title, from arXiv, finds it.
      const feed = await get(`${ARXIV_API}?id_list=${encodeURIComponent(m[1])}`, { json: false }).catch(() => null);
      const title = feed && (feed.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/) || [])[1];
      if (!title) return null;
      return findWork(title.replace(/\s+/g, ' ').trim());
    }
    const hits = await api('/works', { filter: `title.search:${clean(text)}`, per_page: 5, select: 'id,title,cited_by_count' });
    const results = (hits && hits.results) || [];
    if (!results.length) return null;
    const plain = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const exact = results.filter((one) => plain(one.title) === plain(text));
    const pick = (exact.length ? exact : results).sort((a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0))[0];
    return work(short(pick.id));
  }
  async function need(id) {
    const found = await findWork(id);
    if (!found) throw new PapersError(`No paper was found for ${JSON.stringify(String(id).slice(0, 200))}.`);
    return found;
  }

  return {
    async resolve({ query }) {
      const found = await findWork(query);
      return found ? { found: true, paper: fullRecord(found) } : { found: false, query: String(query || '').slice(0, 200) };
    },
    async references({ id, limit }) {
      const paper = await need(id);
      const all = (Array.isArray(paper.referenced_works) ? paper.referenced_works : []).map(short);
      const records = (await byIds(all)).sort((a, b) => b.cited_by - a.cited_by).slice(0, count(limit, MAX_LIST));
      return { of: listRecord(paper), total: all.length, listed: records.length, order: 'most cited first', results: records };
    },
    async citations({ id, limit, sort = 'recent', from_year: fromYear }) {
      const paper = await need(id);
      const out = await list([`cites:${short(paper.id)}`, ...years(fromYear)].join(','), { sort: sort === 'cited' ? 'cited_by_count:desc' : 'publication_date:desc', limit: count(limit, 25) });
      return { of: listRecord(paper), total: out.total, order: sort === 'cited' ? 'most cited first' : 'most recent first', results: out.results };
    },
    async related({ id, limit }) {
      const paper = await need(id);
      const ids = (Array.isArray(paper.related_works) ? paper.related_works : []).map(short).slice(0, count(limit, 10, 25));
      return { of: listRecord(paper), results: await byIds(ids), about: 'OpenAlex\'s related works: papers that share its concepts and were published near it.' };
    },
    async author_works({ author, limit, sort = 'cited' }) {
      const text = String(author || '').trim();
      if (!text) throw new PapersError('Give an author\'s name or OpenAlex id.');
      let people;
      const m = text.match(AUTHOR_RE);
      if (m) { const one = await api(`/authors/${m[1].toUpperCase()}`); people = one ? [one] : []; }
      else { const page = await api('/authors', { search: text, per_page: 5 }); people = (page && page.results) || []; }
      if (!people.length) return { found: false, author: text.slice(0, 200) };
      const [person, ...others] = people;
      const describe = (one) => ({ id: short(one.id), name: one.display_name, works: one.works_count || 0, cited_by: one.cited_by_count || 0, institution: (one.last_known_institutions && one.last_known_institutions[0] && one.last_known_institutions[0].display_name) || null });
      const out = await list(`author.id:${short(person.id)}`, { sort: sort === 'recent' ? 'publication_date:desc' : 'cited_by_count:desc', limit: count(limit, 25) });
      return { found: true, author: describe(person), others_with_that_name: others.map(describe), total: out.total, order: sort === 'recent' ? 'most recent first' : 'most cited first', results: out.results };
    },
    /**
     * Words, optionally within years. `min_cited`, `types` (article, review, book-chapter…) and `with_abstract` filter in
     * OpenAlex itself (onboarding's searches use them: raw keyword hits were obscure papers no one cites).
     */
    async search({ query, limit, from_year: fromYear, until_year: untilYear, min_cited: minCited, types, with_abstract: withAbstract }) {
      const text = clean(query);
      if (!text) throw new PapersError('Give words to search for.');
      const filters = [...years(fromYear, untilYear)];
      if (Number.isInteger(minCited) && minCited > 0) filters.push(`cited_by_count:>${minCited - 1}`);
      const kinds = (Array.isArray(types) ? types : []).map((one) => String(one).replace(/[^a-z-]/g, '')).filter(Boolean);
      if (kinds.length) filters.push(`type:${kinds.join('|')}`);
      if (withAbstract) filters.push('has_abstract:true');
      const out = await list(filters.join(',') || undefined, { search: text, limit: count(limit, 10, 25) });
      return { total: out.total, order: 'relevance (OpenAlex ranks the most cited high: prefer the citation graph)', results: out.results };
    },
    /** Whether OpenAlex refused a call in the last LIMITED_MS (a 429): its tools fail at once meanwhile. */
    limited,
  };
}

const string = { type: 'string' };
const integer = (max) => ({ type: 'integer', minimum: 1, maximum: max });
const year = { type: 'integer', minimum: 1600, maximum: 2100 };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const ID = 'A paper: its OpenAlex id (W…) from an earlier result, a DOI, an arXiv id, or a title.';

const PAPER_TOOLS = [
  { name: 'resolve', description: 'Find the one paper a DOI, an arXiv id or address, an OpenAlex id (W…) or a title names. Returns its record in full: id (pass it to the other tools), title, authors, year, venue, DOI, abstract, an open-access address and its arXiv page when there are any, and how many works it cites and are cited by it. found: false when nothing matches.', inputSchema: schema({ query: string }, ['query']) },
  { name: 'references', description: `What a paper cites, most cited first, without abstracts (resolve gives one). ${ID}`, inputSchema: schema({ id: string, limit: integer(MAX_LIST) }, ['id']) },
  { name: 'citations', description: `What cites a paper: most recent first (sort "recent", the default) or most cited first ("cited"), from a year on when from_year is given. Without abstracts. ${ID}`, inputSchema: schema({ id: string, limit: integer(MAX_LIST), sort: { type: 'string', enum: ['recent', 'cited'] }, from_year: year }, ['id']) },
  { name: 'author_works', description: 'An author\'s works, most cited first (sort "cited", the default) or most recent first ("recent"). author: a name or an OpenAlex author id (A…). The best match is used; others with that name are listed, so check the institution.', inputSchema: schema({ author: string, limit: integer(MAX_LIST), sort: { type: 'string', enum: ['cited', 'recent'] } }, ['author']) },
  { name: 'related', description: `Papers OpenAlex links to this one by shared concepts and time, up to 25. ${ID}`, inputSchema: schema({ id: string, limit: integer(25) }, ['id']) },
  { name: 'search', description: 'Search papers by words, optionally within years. Ranking favours what is most cited, so use it to find starting points only when the person\'s library and document give none.', inputSchema: schema({ query: string, limit: integer(25), from_year: year, until_year: year }, ['query']) },
];

// Every tool only looks up: Codex runs a tool marked so without asking (codex exec cannot ask anyone).
for (const tool of PAPER_TOOLS) tool.annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

/** One tool call → the MCP result: the answer as JSON text, or what went wrong. */
async function callTool(papers, name, args) {
  const tool = PAPER_TOOLS.find((one) => one.name === name);
  if (!tool) return { content: [{ type: 'text', text: `There is no tool ${name}.` }], isError: true };
  const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const { properties } = tool.inputSchema;
  const bad = Object.keys(given).find((key) => !Object.hasOwn(properties, key)) || tool.inputSchema.required.find((key) => typeof given[key] !== 'string');
  if (bad) return { content: [{ type: 'text', text: `Invalid argument: ${bad}.` }], isError: true };
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await papers[name](given)) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof PapersError ? error.message : `The lookup failed: ${String(error && error.message || error).split('\n')[0]}` }], isError: true };
  }
}

module.exports = { PAPER_TOOLS, createPapers, callTool, abstractOf, fullRecord, listRecord, PapersError, openAlexKey, LIMITED_MS };
