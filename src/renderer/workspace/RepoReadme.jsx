import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import GithubSlugger from 'github-slugger';
import { api, errorMessage } from '../api.js';

// Resolve paths relative to the actual README, including READMEs in .github/.
// Repository-root paths must retain the default branch, not point at github.com/.
export function readmeUrl(value, key, readme) {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return '';
  const link = key === 'href';
  if (link && value.startsWith('#')) return value;
  try {
    const source = link ? readme.htmlUrl : readme.rawUrl;
    const path = readme.path.split('/').map(encodeURIComponent).join('/');
    const base = value.startsWith('/') && !value.startsWith('//') ? source.slice(0, -path.length) : source;
    const url = new URL(value.startsWith('/') && !value.startsWith('//') ? value.slice(1) : value, base);
    if (url.username || url.password || !(link ? ['https:', 'http:'] : ['https:']).includes(url.protocol)) return '';
    // GitHub's blob page is HTML, not image bytes.
    if (!link && url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/blob\//.test(url.pathname)) {
      url.hostname = 'raw.githubusercontent.com';
      url.pathname = url.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, '$1/');
    }
    return url.href;
  } catch { return ''; }
}

function headingIds() {
  return (tree) => {
    const slugger = new GithubSlugger();
    const text = (node) => node.type === 'text' ? node.value : (node.children || []).map(text).join('');
    const visit = (node) => {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) {
        const slug = slugger.slug(text(node));
        if (!node.properties.id) node.properties.id = `repo-readme-${slug}`;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function imageSources(value, readme) {
  return (value || '').split(',').slice(0, 32).flatMap((candidate) => {
    const match = candidate.trim().match(/^(\S+)(?:\s+(\d+w|\d+(?:\.\d+)?x))?$/);
    const url = match && readmeUrl(match[1], 'src', readme);
    return url ? [`${url}${match[2] ? ` ${match[2]}` : ''}`] : [];
  }).join(', ') || undefined;
}

export const ReadmeContent = React.memo(function ReadmeContent({ readme, onOpenLink }) {
  const article = React.useRef(null);
  const follow = (event, href) => {
    event.preventDefault();
    if (!href) return;
    if (!href.startsWith('#')) { onOpenLink?.(href); return; }
    let anchor;
    try { anchor = decodeURIComponent(href.slice(1)); } catch { return; }
    const ids = new Set([anchor, `repo-readme-${anchor}`, `user-content-${anchor}`]);
    const target = Array.from(article.current?.querySelectorAll('[id]') || []).find((element) => ids.has(element.id));
    target?.scrollIntoView({ block: 'start' });
  };
  return <article ref={article} className="repo-readme" aria-label="Repository README">
    {readme.format === 'text' ? <pre className="repo-readme-plain">{readme.content}</pre> : <ReactMarkdown
      remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize, headingIds]}
      urlTransform={(url, key) => readmeUrl(url, key, readme)}
      components={{
        a: ({ node, href, ...props }) => <a {...props} href={href || undefined} onClick={(event) => follow(event, href)} onAuxClick={(event) => { if (event.button === 1) follow(event, href); }} />,
        img: ({ node, src, ...props }) => src ? <img {...props} src={src} loading="lazy" referrerPolicy="no-referrer" /> : <span>{props.alt}</span>,
        source: ({ node, srcSet, ...props }) => <source {...props} srcSet={imageSources(srcSet, readme)} />,
        table: ({ node, ...props }) => <div className="repo-readme-table"><table {...props} /></div>,
      }}
    >{readme.content}</ReactMarkdown>}
  </article>;
});

// Keyed by repository in RepoPane: a slow response can never replace another repo's README.
function RepoReadme({ repo, refreshVersion = 0 }) {
  const [request, setRequest] = React.useState(0);
  const [state, setState] = React.useState({ status: 'loading' });
  const [linkError, setLinkError] = React.useState('');
  React.useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    api.repositoryReadme(repo.id, { refresh: request > 0 || refreshVersion > 0 }).then(
      (result) => { if (live) setState(result); },
      (error) => { if (live) setState({ status: 'error', error: errorMessage(error) }); },
    );
    return () => { live = false; };
  }, [repo.id, request, refreshVersion]);
  const open = React.useCallback(async (url) => {
    setLinkError('');
    try { await api.openExternal(url); } catch (error) { setLinkError(errorMessage(error)); }
  }, []);
  return <div className="repo-document" aria-busy={state.status === 'loading'}>
    {state.status === 'ready' ? <ReadmeContent readme={state} onOpenLink={open} /> : <div className="repo-readme-status">
      {state.status === 'loading' && <p className="repo-notice" role="status">Loading README…</p>}
      {state.status === 'missing' && <p className="repo-notice">No public README was found. This repository may be private or may not have a README. You can still use the build controls above.</p>}
      {state.status === 'error' && <div className="repo-notice" role="alert"><p>{state.error}</p><button className="repo-button" onClick={() => setRequest((value) => value + 1)}>Retry README</button></div>}
    </div>}
    {linkError && <p className="repo-error" role="alert">{linkError}</p>}
  </div>;
}

// Build log updates should not repeatedly parse a long README.
export default React.memo(RepoReadme);
