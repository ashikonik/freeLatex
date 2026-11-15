#!/usr/bin/env node
/**
 * biber-probe.mjs — prove that the server compiles a biblatex document.
 *
 * The image's build-time check (docker/biblatex-check.sh) proves that the
 * compiler and the bibliography engine fit together. This proves the other
 * half: that the *server* finds the engine, lets the compiler run it, and
 * returns a PDF whose bibliography is not empty.
 *
 * It needs a real biber on the PATH. On a host that means installing one
 * that pairs with the compiler's biblatex — see docker/Dockerfile, which
 * pins the pair and explains why the version is not a free choice.
 *
 * Usage: node scripts/biber-probe.mjs [serverDistDir]
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const serverDist = resolve(process.argv[2] ?? 'server/dist');
const compilerModule = pathToFileURL(join(serverDist, 'services/compiler.js')).href;

const { compileProject, resolveBiberBinary } = await import(compilerModule);

const work = await mkdtemp(join(tmpdir(), 'freelatex-biber-'));

await writeFile(
  join(work, 'main.tex'),
  '\\documentclass{article}\n' +
    '\\usepackage[backend=biber]{biblatex}\n' +
    '\\addbibresource{refs.bib}\n' +
    '\\begin{document}\n' +
    'Hello \\cite{knuth1984}.\n' +
    '\\printbibliography\n' +
    '\\end{document}\n',
);

await writeFile(
  join(work, 'refs.bib'),
  '@book{knuth1984, author={Knuth, Donald E.}, title={The TeXbook}, year={1984}, publisher={Addison-Wesley}}\n',
);

const biber = await resolveBiberBinary();
console.log('biber found at:', biber ?? '(none)');
if (!biber) {
  console.error('FAIL: the server cannot find biber');
  process.exit(1);
}

const result = await compileProject({
  projectDir: work,
  mainFile: 'main.tex',
  timeoutMs: 120_000,
});

console.log('success:', result.success);
console.log('pdf bytes:', result.pdf?.length ?? 0);
console.log('errors:', JSON.stringify(result.errors, null, 2));

if (!result.success || !result.pdf || result.pdf.length === 0) {
  console.error('FAIL: the document did not build');
  console.error(result.log);
  process.exit(1);
}

// The bibliography has to have been written, not merely attempted. The
// compiler reports that it ran the engine; the bibliography itself lands in
// the `.bbl`, whose size says whether anything was actually put in it.
if (!result.log.includes('external tool biber')) {
  console.error('FAIL: the compiler did not run biber');
  console.error(result.log);
  process.exit(1);
}

const bbl = /Writing `.*\.bbl` \(([^)]+)\)/.exec(result.log);
if (!bbl) {
  console.error('FAIL: the compiler wrote no bibliography');
  console.error(result.log);
  process.exit(1);
}

const kilobytes = Number.parseFloat(bbl[1] ?? '0');
if (!Number.isFinite(kilobytes) || kilobytes < 0.5) {
  console.error(`FAIL: the bibliography is empty (${bbl[1]})`);
  console.error(result.log);
  process.exit(1);
}

console.log(`ok: the server compiled a biblatex document with biber (${bbl[1]} of bibliography)`);
