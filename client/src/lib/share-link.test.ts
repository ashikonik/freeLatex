import { afterEach, describe, expect, it } from 'vitest';

import {
  clearActiveShareLink,
  isShareTokenShape,
  parseShareLink,
  readActiveShareProjectId,
  readActiveShareToken,
  setActiveShareLink,
} from './share-link.js';

describe('the shape of a share token', () => {
  it('recognises the two kinds of share token', () => {
    expect(isShareTokenShape('rw_abc')).toBe(true);
    expect(isShareTokenShape('ro_abc')).toBe(true);
  });

  it('does not mistake an account key for a share token', () => {
    expect(isShareTokenShape('sk_user_abc')).toBe(false);
    expect(isShareTokenShape('admin-secret')).toBe(false);
  });
});

describe('the share link in a URL', () => {
  it('reads the project and the token', () => {
    const link = parseShareLink('https://example.com/p/prj_1?token=rw_secret');
    expect(link).toEqual({ projectId: 'prj_1', token: 'rw_secret' });
  });

  it('reads a relative URL', () => {
    const link = parseShareLink('/p/prj_1?token=ro_secret');
    expect(link).toEqual({ projectId: 'prj_1', token: 'ro_secret' });
  });

  it('ignores a path that is not a share path', () => {
    expect(parseShareLink('https://example.com/?token=rw_secret')).toBeUndefined();
    expect(parseShareLink('https://example.com/projects/prj_1?token=rw_secret')).toBeUndefined();
  });

  it('ignores a share path without a token', () => {
    expect(parseShareLink('https://example.com/p/prj_1')).toBeUndefined();
  });

  it('ignores a token that is not a share token', () => {
    expect(parseShareLink('https://example.com/p/prj_1?token=sk_user_abc')).toBeUndefined();
  });

  it('ignores a share path without a project', () => {
    expect(parseShareLink('https://example.com/p/?token=rw_secret')).toBeUndefined();
  });

  it('keeps other query parameters to themselves', () => {
    const link = parseShareLink('https://example.com/p/prj_1?token=rw_secret&theme=dark');
    expect(link).toEqual({ projectId: 'prj_1', token: 'rw_secret' });
  });
});

describe('the share link of the current visit', () => {
  afterEach(() => {
    clearActiveShareLink();
  });

  it('holds the link that was put in place', () => {
    setActiveShareLink({ projectId: 'prj_1', token: 'rw_secret' });
    expect(readActiveShareToken()).toBe('rw_secret');
    expect(readActiveShareProjectId()).toBe('prj_1');
  });

  it('forgets the link when it is cleared', () => {
    setActiveShareLink({ projectId: 'prj_1', token: 'rw_secret' });
    clearActiveShareLink();
    expect(readActiveShareToken()).toBeUndefined();
    expect(readActiveShareProjectId()).toBeUndefined();
  });
});
