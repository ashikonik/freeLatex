import { describe, expect, it } from 'vitest';

import { encodeRoomName, colorForClientId, COLLABORATOR_COLORS } from './CodeMirrorEditor.js';

describe('the room name', () => {
  /**
   * The names below were produced by the server's own encoder, so a change to
   * the client's rule that breaks the agreement between the two ends shows up
   * here rather than as a room that never connects.
   */
  it('matches the server for a file at the root', () => {
    expect(encodeRoomName('prj_1', 'main.tex')).toBe('prj_1.bWFpbi50ZXg');
  });

  it('matches the server for a file in a directory', () => {
    expect(encodeRoomName('prj_1', 'chapters/intro.tex')).toBe(
      'prj_1.Y2hhcHRlcnMvaW50cm8udGV4',
    );
  });

  it('matches the server for a path with characters that need escaping', () => {
    expect(encodeRoomName('prj_1', 'a b/c+d/ü.tex')).toBe(
      'prj_1.YSBiL2MrZC_DvC50ZXg',
    );
  });

  it('is a single URL path segment', () => {
    const room = encodeRoomName('prj_1', 'chapters/intro.tex');

    // A slash would split the room across two path segments, and a room
    // name that travels in a URL cannot contain one.
    expect(room).not.toContain('/');
  });

  it('encodes a path that tries to escape the project directory', () => {
    // The room name is opaque, so a traversing path is not readable as one
    // — and the server refuses it when it decodes the name.
    const room = encodeRoomName('prj_1', '../../etc/passwd');

    expect(room).not.toContain('..');
    expect(room).toBe('prj_1.Li4vLi4vZXRjL3Bhc3N3ZA');
  });
});

describe('the collaborator colours', () => {
  it('gives the same client id the same colour', () => {
    expect(colorForClientId(42)).toBe(colorForClientId(42));
  });

  it('gives a client id a colour from the palette', () => {
    expect(COLLABORATOR_COLORS).toContain(colorForClientId(42));
    expect(COLLABORATOR_COLORS).toContain(colorForClientId(-7));
    expect(COLLABORATOR_COLORS).toContain(colorForClientId(0));
  });

  it('does not fail on a negative client id', () => {
    // The id is a number that may be negative, so the index must not be.
    expect(colorForClientId(-1)).toBe(COLLABORATOR_COLORS[1]);
  });
});
