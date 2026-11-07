/**
 * The errors of a TeX log.
 *
 * A TeX log reports an error as a block: the message starts with an
 * exclamation mark, the context follows, and the line the error happened on
 * comes last as `l.<number>`. The line number is the part a reader needs,
 * so the whole block is kept rather than just the message.
 */

/**
 * Pull the errors out of a TeX log.
 *
 * An error block is the line that starts with `!` and the lines that follow
 * it until the next error. A block that ends with a `l.<number>` line keeps
 * that line, because it names the place the error happened.
 *
 * @param log The engine's log.
 */
export function extractErrors(log: string): string[] {
  const lines = log.split('\n').map((line) => line.trim());
  const errors: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.startsWith('!')) {
      continue;
    }

    // The lines that follow the message belong to it until the next error.
    const block = [line];
    for (let next = index + 1; next < lines.length; next += 1) {
      const following = lines[next];
      if (following === undefined || following.startsWith('!')) {
        break;
      }
      // The line the error happened on ends the block.
      if (following.startsWith('l.')) {
        block.push(following);
        break;
      }
      block.push(following);
    }

    errors.push(block.join('\n'));

    // The lines that were consumed as part of the error are not read again.
    index += block.length - 1;
  }

  return errors;
}
