/**
 * The lexer under the export census, at the shapes a real source file puts it in.
 *
 * ## Why this file exists
 *
 * `export-census.ts` reads TypeScript **as text**, because the census asks a question the compiler
 * cannot answer: which exported symbols are mentioned anywhere outside their own file. Getting that
 * wrong in either direction is expensive. A comment that mentions a symbol makes an orphan look
 * referenced — that happened, and `assertRuleTable` silently left the orphan ledger. A string that
 * looks like a comment swallows the rest of the file, so every later declaration disappears from the
 * census and the denominator shrinks without an edit.
 *
 * The scanner therefore has to know where a literal starts, where it ends, and where a slash is a
 * division rather than a regular expression. Those are the arms this file covers: the census's
 * package figure read 93.73 / 92.81 / 94.44 while every other file in `cortex-core` sat at 100, and
 * what was missing was not a feature — it was the four literal forms the suite never wrote.
 *
 * ## The property each test asserts
 *
 * Not the exact output string, which would pin the scanner's spacing, but the two facts the census
 * depends on: **the comment after the literal is gone**, and **the code after the literal survives**.
 * A scanner that ended the literal early fails the second; one that ended it late fails the first.
 */

import { describe, expect, it } from 'vitest';

import { stripComments, stripStringContent } from '../export-census.js';

describe('the slash, as division or as a regular expression', () => {
  it('reads a regex at the very start of a file, where no character precedes it', () => {
    // `back < 0` is the first arm of `regexCanStart`, and it can only be reached by a source that
    // opens with a literal. A scanner that treated it as division would then read the body as
    // identifiers and the file's first comment as code.
    const stripped = stripComments('/a+/.test(marker); // mentions target\nconst after = 1;');

    expect(stripped).not.toContain('mentions target');
    expect(stripped).toContain('const after = 1;');
  });

  it('does not end a regex at a slash inside a character class', () => {
    // `[/]` is the case the `inClass` flag exists for: without it the class closes the literal one
    // character early, the trailing `]` reads as code, and the comment after it is scanned as code.
    const stripped = stripComments('const re = /[/]/; // mentions target\nconst after = 1;');

    expect(stripped).not.toContain('mentions target');
    expect(stripped).toContain('const after = 1;');
  });

  it('carries an escaped character through a regex body and its flags', () => {
    const stripped = stripComments('const re = /a\\/b/gi; // mentions target\nconst after = 1;');

    expect(stripped).not.toContain('mentions target');
    expect(stripped).toContain('const after = 1;');
  });

  it('treats a slash after an identifier as division, so the rest of the line is still code', () => {
    // The other direction: with `x / y` the scanner must NOT enter regex mode and swallow the line.
    const stripped = stripComments(
      'const ratio = total / count; // mentions target\nconst after = 1;',
    );

    expect(stripped).not.toContain('mentions target');
    expect(stripped).toContain('const ratio = total / count;');
  });

  it('recognises a keyword before a slash, so `return /re/` is a literal', () => {
    const stripped = stripComments(
      'function f() { return /x/; } // mentions target\nconst after = 1;',
    );

    expect(stripped).not.toContain('mentions target');
    expect(stripped).toContain('const after = 1;');
  });
});

describe('the template literal', () => {
  it('skips an interpolation and everything after it on the same line', () => {
    const stripped = stripComments('const t = `a ${b} c`; // mentions target\nconst after = 1;');

    expect(stripped).not.toContain('mentions target');
    expect(stripped).toContain('const after = 1;');
  });

  it('skips an escaped backtick rather than ending the literal there', () => {
    const stripped = stripComments('const t = `a \\` b`; // mentions target\nconst after = 1;');

    expect(stripped).not.toContain('mentions target');
    expect(stripped).toContain('const after = 1;');
  });

  it('does not run off the end of a file whose template is never closed', () => {
    // A truncated file is a real input: half-written source lands in a working tree, and a scanner
    // that looped to `index >= length` without terminating would either hang or throw. Asserting
    // that the call returns is the whole contract; what it returns cannot matter.
    expect(() => stripComments('const t = `never closed')).not.toThrow();
  });

  it('keeps a dollar that is not the start of an interpolation', () => {
    const stripped = stripComments('const t = `cost $5`; // mentions target\nconst after = 1;');

    expect(stripped).not.toContain('mentions target');
    expect(stripped).toContain('const after = 1;');
  });
});

describe('the census reads code, not prose', () => {
  it('drops a symbol named only in a comment, and keeps one named in code', () => {
    // The end the scanner exists for. `orphanSymbol` appears in a doc comment and nowhere else, so
    // it must survive as an orphan; `liveSymbol` is mentioned in code, so it must not.
    const source = [
      '/**',
      ' * `orphanSymbol` is discussed here and used nowhere.',
      ' */',
      'export function liveSymbol(): void {}',
      'liveSymbol();',
    ].join('\n');

    const stripped = stripComments(source);

    expect(stripped).toContain('liveSymbol');
    expect(stripped).not.toContain('orphanSymbol');
  });

  it('blanks a string body without touching the code around it', () => {
    const stripped = stripStringContent("const label = 'orphanSymbol';\nconst liveSymbol = 1;");

    expect(stripped).not.toContain('orphanSymbol');
    expect(stripped).toContain('liveSymbol');
  });
});

describe('the same literals through `stripStringContent`', () => {
  /**
   * The second scanner, and the reason it needs its own cases: `stripComments` and
   * `stripStringContent` carry two copies of one state machine, and a test written against one of
   * them says nothing about the other. That is exactly what the census reported -- the comment
   * scanner's template arms covered, the string scanner's arms not -- and two copies of a lexer is
   * the kind of duplication where the copies drift one character at a time.
   */
  it('keeps the code inside a template substitution and blanks the text around it', () => {
    const stripped = stripStringContent('const t = `text ${liveSymbol} more`;\nconst after = 1;');

    expect(stripped).toContain('liveSymbol');
    expect(stripped).not.toContain('text');
    expect(stripped).toContain('const after = 1;');
  });

  it('skips an escaped backtick inside a template', () => {
    const stripped = stripStringContent('const t = `a \\` orphanSymbol b`;\nconst liveSymbol = 1;');

    expect(stripped).not.toContain('orphanSymbol');
    expect(stripped).toContain('liveSymbol');
  });

  it('does not run off the end of a file whose template is never closed', () => {
    expect(() => stripStringContent('const t = `never closed')).not.toThrow();
  });

  it('leaves a regex body alone, including its flags', () => {
    const stripped = stripStringContent('const re = /orphanSymbol/gi;\nconst liveSymbol = 1;');

    // A regular expression is code, not a string: its body names nothing the census should count as
    // a caller, but it also must not be blanked, because the scanner cannot tell a symbol inside one
    // from a symbol in source without parsing the pattern.
    expect(stripped).toContain('orphanSymbol');
    expect(stripped).toContain('liveSymbol');
  });
});
