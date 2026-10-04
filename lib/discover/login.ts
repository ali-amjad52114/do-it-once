// Login detection for discovery (pure, unit-tested). The agent NEVER types, reads or stores passwords:
// when a page needs sign-in, discovery pauses and the user signs in themselves in the interactive live view.
import type { InteractiveElement, PageState } from '@/lib/contracts';

const URL_RE = /(sign[-_]?in|log[-_]?in|\/ap\/signin|\/account\/login|\/session\/new)/i;
const TITLE_RE = /\b(sign[ -]?in|log[ -]?in)\b/i;
const PASSWORD_RE = /pass(word|code)/i;

type El = Pick<InteractiveElement, 'role' | 'name' | 'tag' | 'hidden'>;

/** True when the page asks the user to sign in: a visible password field, or a sign-in URL/title. */
export function needsLogin(page: Pick<PageState, 'url' | 'title'>, els: El[] = []): boolean {
  const hasPassword = els.some(
    (e) => !e.hidden && (e.tag === 'input' || e.role === 'textbox' || e.role === 'password') && PASSWORD_RE.test(e.name),
  );
  if (hasPassword) return true;
  let path = page.url;
  try {
    const u = new URL(page.url);
    path = u.pathname + u.search;
  } catch {
    /* not a URL: test it as-is */
  }
  return URL_RE.test(path) || TITLE_RE.test(page.title);
}

/** Kernel profile name for a site host: site-<host>, sanitized (one profile per host). */
export function profileForUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const clean = host.replace(/[^a-z0-9.-]/g, '-').slice(0, 60);
    return clean ? `site-${clean}` : null;
  } catch {
    return null;
  }
}
