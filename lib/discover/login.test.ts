import { describe, expect, it } from 'vitest';
import { needsLogin, profileForUrl } from './login';

const el = (role: string, name: string, tag = 'input', hidden = false) => ({ role, name, tag, hidden });

describe('needsLogin', () => {
  it('detects sign-in URLs', () => {
    expect(needsLogin({ url: 'https://www.amazon.com/ap/signin?openid=x', title: 'Amazon' })).toBe(true);
    expect(needsLogin({ url: 'https://x.test/signin?next=/store/orders', title: 'Store' })).toBe(true);
    expect(needsLogin({ url: 'https://x.test/login', title: '' })).toBe(true);
  });
  it('detects sign-in titles', () => {
    expect(needsLogin({ url: 'https://x.test/a', title: 'Amazon Sign-In' })).toBe(true);
    expect(needsLogin({ url: 'https://x.test/a', title: 'Log in to Lumen' })).toBe(true);
  });
  it('detects a visible password field', () => {
    expect(needsLogin({ url: 'https://x.test/a', title: 'Home' }, [el('textbox', 'Password')])).toBe(true);
    expect(needsLogin({ url: 'https://x.test/a', title: 'Home' }, [el('textbox', 'Password', 'input', true)])).toBe(false);
  });
  it('ignores normal pages', () => {
    expect(
      needsLogin({ url: 'https://x.test/store/orders', title: 'Your orders' }, [el('link', 'Sign out', 'a'), el('button', 'Return items', 'button')]),
    ).toBe(false);
    expect(needsLogin({ url: 'https://blog.test/logistics', title: 'Logistics' })).toBe(false);
  });
});

describe('profileForUrl', () => {
  it('sanitizes the host', () => {
    expect(profileForUrl('https://www.amazon.com/gp/your-account')).toBe('site-amazon.com');
    expect(profileForUrl('http://localhost:4012/store')).toBe('site-localhost');
    expect(profileForUrl('nope')).toBeNull();
  });
});
