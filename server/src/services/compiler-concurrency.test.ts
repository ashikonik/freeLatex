import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileProject, compilationLimit } from './compiler.js';

let workDir: string;
let stubDir: string;

/**
 * A stand-in for tectonic.
 *
 * It records the moment it starts and the moment it ends, so the test can
 * tell how many of them overlapped. The counter lives in a file, because
 * each run is a separate process.
 */
const STUB = `#!/bin/sh
COUNT_FILE="$1"
LOG="$2"

START=$(date +%s%N)
echo "start $START" >> "$LOG"
echo "x" >> "$COUNT_FILE"
sleep 0.3
END=$(date +%s%N)
echo "end $END" >> "$LOG"
`;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'freelatex-concurrency-'));
  stubDir = await mkdtemp(join(tmpdir(), 'freelatex-stub-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(stubDir, { recursive: true, force: true });
});

describe('the compilation limit', () => {
  it('keeps the number of running compilations within the limit', async () => {
    const stub = join(stubDir, 'tectonic-stub.sh');
    await writeFile(stub, STUB, 'utf8');
    await chmod(stub, 0o755);

    const countFile = join(stubDir, 'count');
    await writeFile(countFile, '', 'utf8');

    // The stub takes the count file and the log as its arguments, so the
    // real arguments are appended after them.
    const wrapper = join(stubDir, 'tectonic');
    await writeFile(
      wrapper,
      `#!/bin/sh\nexec "${stub}" "${countFile}" "${join(stubDir, 'log')}" "$@"\n`,
      'utf8',
    );
    await chmod(wrapper, 0o755);

    const attempts = compilationLimit + 3;
    const running = Array.from({ length: attempts }, () =>
      compileProject({
        projectDir: workDir,
        mainFile: 'main.tex',
        timeoutMs: 30_000,
        binaryPath: wrapper,
      }),
    );

    await Promise.all(running);

    // The counter file holds one line per process that started.
    const counted = (await readFile(countFile, 'utf8')).split('\n').filter(Boolean).length;
    expect(counted).toBe(attempts);

    // The log holds a start and an end for each run; the overlaps are the
    // moments between a start and the next end.
    const lines = (await readFile(join(stubDir, 'log'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    const events = lines.map((line) => {
      const [kind, time] = line.split(' ');
      return { kind: kind ?? '', time: Number(time) };
    });

    let peak = 0;
    let current = 0;
    for (const event of events) {
      current += event.kind === 'start' ? 1 : -1;
      peak = Math.max(peak, current);
    }

    expect(peak).toBeLessThanOrEqual(compilationLimit);
    // The gate has to actually let work through, not refuse all of it.
    expect(peak).toBeGreaterThan(0);
  }, 30_000);
});
