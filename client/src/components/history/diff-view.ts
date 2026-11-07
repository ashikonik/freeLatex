/**
 * The reading of a unified diff.
 *
 * The server answers a diff request with the unified diff text of each
 * changed file. A browser cannot show that as a side-by-side comparison
 * without knowing which side every line belongs to, so the lines are read
 * here and the drawing is left to the component.
 */

/** A line of a unified diff. */
export interface DiffLine {
  /** The line as the server wrote it, without its marker. */
  text: string;
  /** Which side of the comparison the line is on. */
  kind: 'context' | 'added' | 'removed';
}

/**
 * Read a unified diff into its lines.
 *
 * A unified diff marks each line with its first character: a space for a
 * line that is on both sides, a plus for one that was added, a minus for one
 * that was removed.
 *
 * The structure of the diff — the `Index:` line, the `===` separator, the
 * `---`/`+++` file headers and the `@@` hunk headers — is not content, so it
 * is left out.
 *
 * @param patch The unified diff of one file.
 */
export function parseDiff(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];

  // A patch ends with a newline, and the text after the last newline is not
  // a line of the diff.
  const rawLines = patch.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  for (const raw of rawLines) {
    // The structure of the patch. The `---` and `+++` lines are the two file
    // headers, and the `Index:` line and the `===` separator are what some
    // producers write before them.
    if (
      raw.startsWith('@@') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('Index: ') ||
      raw.startsWith('===')
    ) {
      continue;
    }

    if (raw.startsWith('+')) {
      lines.push({ text: raw.slice(1), kind: 'added' });
      continue;
    }
    if (raw.startsWith('-')) {
      lines.push({ text: raw.slice(1), kind: 'removed' });
      continue;
    }
    if (raw.startsWith(' ')) {
      lines.push({ text: raw.slice(1), kind: 'context' });
      continue;
    }
    if (raw.startsWith('\\')) {
      // The "no newline at end of file" marker. It says something about the
      // line before it rather than being a line of its own.
      continue;
    }
    // A line with no marker at all is an empty context line: a unified diff
    // writes an empty line of context as a line holding a single space, so a
    // line that is entirely empty carries no content either.
    lines.push({ text: raw, kind: 'context' });
  }

  return lines;
}

/**
 * Split a diff into the two sides of the comparison.
 *
 * The two sides are what a reader compares: the old file on one side and the
 * new file on the other. A line that only exists on one side leaves a gap on
 * the other, which is what pairs the two up.
 */
export interface DiffSides {
  /** The lines of the older side, in order. */
  left: (DiffLine | undefined)[];
  /** The lines of the newer side, in order. */
  right: (DiffLine | undefined)[];
}

/**
 * Pair the lines of a diff into two columns.
 *
 * A run of removed lines and the run of added lines that follows it are two
 * halves of the same change, so the first removed line is paired with the
 * first added line, the second with the second, and so on. A run that is
 * longer than the other leaves a gap on the other side.
 *
 * @param lines The lines of the diff.
 */
export function pairDiff(lines: DiffLine[]): DiffSides {
  const left: (DiffLine | undefined)[] = [];
  const right: (DiffLine | undefined)[] = [];

  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) {
      index += 1;
      continue;
    }

    if (line.kind === 'context') {
      left.push(line);
      right.push(line);
      index += 1;
      continue;
    }

    // The run of removed lines.
    const removed: DiffLine[] = [];
    while (index < lines.length && lines[index]?.kind === 'removed') {
      removed.push(lines[index] as DiffLine);
      index += 1;
    }

    // The run of added lines that replaces them.
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index]?.kind === 'added') {
      added.push(lines[index] as DiffLine);
      index += 1;
    }

    const pairs = Math.max(removed.length, added.length);
    for (let pair = 0; pair < pairs; pair += 1) {
      left.push(removed[pair]);
      right.push(added[pair]);
    }
  }

  return { left, right };
}
