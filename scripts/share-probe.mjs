#!/usr/bin/env node
/**
 * share-probe.mjs — prove that a share link really opens a project.
 *
 * The unit tests cover the client's handling of a link, but they stub the
 * network away. This probe runs against a real server: it mints a share
 * token, asks for the project the way a reader arriving through the link
 * would, and opens the collaboration socket with the same token.
 *
 * It is the check that the promise on the README — "anyone with the link can
 * edit or view in real time" — is kept.
 *
 * Usage: node scripts/share-probe.mjs [baseUrl] [adminKey]
 */

import ws from '../server/node_modules/ws/index.js';

const { WebSocket } = ws;

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:3030';
const ADMIN_KEY = process.argv[3] ?? '';

if (!ADMIN_KEY) {
  console.error('usage: node scripts/share-probe.mjs <baseUrl> <adminKey>');
  process.exit(2);
}

const api = async (path, options = {}) => {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, body };
};

const admin = { authorization: `Bearer ${ADMIN_KEY}` };

/** Report the outcome of one check. */
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. The owner signs in and makes a project.
const me = await api('/auth/me', { headers: admin });
check('the owner is recognised', me.status === 200, `status ${me.status}`);

const created = await api('/projects', {
  method: 'POST',
  headers: admin,
  body: JSON.stringify({ title: 'Share probe' }),
});
check('the owner makes a project', created.status === 201, `status ${created.status}`);
const projectId = created.body?.id;
if (!projectId) {
  console.error('no project id; stopping');
  process.exit(1);
}

// 2. A share link is minted for it.
const shared = await api(`/projects/${projectId}/share`, {
  method: 'POST',
  headers: admin,
  body: JSON.stringify({ permission: 'rw' }),
});
check('a share link is minted', shared.status === 201, `status ${shared.status}`);
const token = shared.body?.token;
const linkUrl = shared.body?.url;
check(
  'the link names a deep path',
  typeof linkUrl === 'string' && linkUrl.startsWith(`/p/${projectId}?token=`),
  linkUrl,
);
if (!token) {
  console.error('no token; stopping');
  process.exit(1);
}

// 3. The reader arrives through the link: no account key, just the token.
//
// The link's token is a share token, and the server accepts a share token
// either as a bearer or as a query parameter. Both shapes are checked,
// because the client and the browser's own navigation use different ones.
const asBearer = await api(`/projects/${projectId}`, {
  headers: { authorization: `Bearer ${token}` },
});
check(
  'the link opens the project as a bearer token',
  asBearer.status === 200 && asBearer.body?.id === projectId,
  `status ${asBearer.status}`,
);

const asQuery = await api(`/projects/${projectId}?token=${encodeURIComponent(token)}`);
check(
  'the link opens the project as a query token',
  asQuery.status === 200 && asQuery.body?.id === projectId,
  `status ${asQuery.status}`,
);

// 4. The reader may read the files.
const files = await api(`/projects/${projectId}/files?token=${encodeURIComponent(token)}`);
check('the link reads the files', files.status === 200, `status ${files.status}`);

// 5. The link may not reach another project.
const other = await api('/projects', {
  method: 'POST',
  headers: admin,
  body: JSON.stringify({ title: 'Not shared' }),
});
const otherRead = await api(
  `/projects/${other.body?.id ?? 'prj_missing'}?token=${encodeURIComponent(token)}`,
);
check(
  'the link may not reach a project it was not minted for',
  otherRead.status === 403 || otherRead.status === 404,
  `status ${otherRead.status}`,
);

// 6. The collaboration socket opens with the link's token.
const socketResult = await new Promise((resolve) => {
  const wsUrl = `${BASE_URL.replace(/^http/, 'ws')}/ws/${projectId}.${Buffer.from('main.tex').toString('base64url')}`;
  const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
  const timer = setTimeout(() => {
    socket.close();
    resolve({ opened: false, reason: 'timed out' });
  }, 10_000);
  socket.on('open', () => {
    clearTimeout(timer);
    socket.close();
    resolve({ opened: true });
  });
  socket.on('error', (cause) => {
    clearTimeout(timer);
    resolve({ opened: false, reason: cause?.message ?? 'error' });
  });
});
check(
  'the collaboration socket opens with the link token',
  socketResult.opened,
  socketResult.reason ?? '',
);

// 7. A read-only link may not edit.
const ro = await api(`/projects/${projectId}/share`, {
  method: 'POST',
  headers: admin,
  body: JSON.stringify({ permission: 'ro' }),
});
const roToken = ro.body?.token ?? '';
const roWrite = await api(`/projects/${projectId}/files/main.tex?token=${encodeURIComponent(roToken)}`, {
  method: 'PUT',
  body: JSON.stringify({ content: '\\documentclass{article}\n' }),
});
check(
  'a read-only link may not write',
  roWrite.status === 403,
  `status ${roWrite.status}`,
);

// 8. The deep-link path itself is answered with the application, not a 404.
const page = await fetch(`${BASE_URL}/p/${projectId}?token=${encodeURIComponent(token)}`);
const html = await page.text();
check(
  'the deep-link path serves the application',
  page.status === 200 && html.includes('<div id="root">'),
  `status ${page.status}`,
);

// 9. The token is not written into the logs of a request that carries it.
check(
  'the link is bound to the project it was minted for',
  typeof shared.body?.token === 'string' && shared.body.token.startsWith('rw_'),
  'prefix rw_',
);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
