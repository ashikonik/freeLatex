import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';

/**
 * The LaTeX grammar.
 *
 * CodeMirror's own StreamLanguage parser is used rather than a Lezer grammar:
 * LaTeX's macro syntax is context-sensitive and cannot be parsed by a
 * context-free grammar without a full macro expander, so the tokeniser works
 * on the surface form instead. That is enough for highlighting, which is all
 * the editor needs.
 */

/**
 * The state a line is tokenised from.
 *
 * LaTeX has no construct that spans a line break — a comment ends at the
 * newline — so the parser carries no state between lines.
 */
type LaTeXState = Record<string, never>;

/**
 * The keywords that are highlighted as commands.
 *
 * The list is the set of LaTeX's document-structuring and font commands, not
 * every macro in existence — an exhaustive list would highlight package
 * specific macros inconsistently.
 */
export const LATEX_KEYWORDS: ReadonlySet<string> = new Set([
  'documentclass',
  'usepackage',
  'begin',
  'end',
  'title',
  'author',
  'date',
  'maketitle',
  'abstract',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'chapter',
  'part',
  'label',
  'ref',
  'eqref',
  'pageref',
  'cite',
  'citep',
  'citet',
  'bibliography',
  'bibliographystyle',
  'item',
  'footnote',
  'includegraphics',
  'input',
  'include',
  'newcommand',
  'renewcommand',
  'providecommand',
  'DeclareMathOperator',
  'textbf',
  'textit',
  'texttt',
  'textsc',
  'textsf',
  'textrm',
  'textnormal',
  'emph',
  'underline',
  'uline',
  'text',
  'mathrm',
  'mathbf',
  'mathit',
  'mathsf',
  'mathtt',
  'mathcal',
  'mathbb',
  'mathfrak',
  'boldsymbol',
  'operatorname',
  'frac',
  'dfrac',
  'tfrac',
  'sqrt',
  'sum',
  'prod',
  'int',
  'lim',
  'left',
  'right',
  'big',
  'Big',
  'bigg',
  'Bigg',
  'langle',
  'rangle',
  'cdot',
  'times',
  'div',
  'pm',
  'mp',
  'leq',
  'geq',
  'neq',
  'approx',
  'equiv',
  'infty',
  'partial',
  'nabla',
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
  'eta',
  'theta',
  'iota',
  'kappa',
  'lambda',
  'mu',
  'nu',
  'xi',
  'pi',
  'rho',
  'sigma',
  'tau',
  'upsilon',
  'phi',
  'chi',
  'psi',
  'omega',
  'Gamma',
  'Delta',
  'Theta',
  'Lambda',
  'Xi',
  'Pi',
  'Sigma',
  'Upsilon',
  'Phi',
  'Psi',
  'Omega',
  'hspace',
  'vspace',
  'newline',
  'linebreak',
  'pagebreak',
  'newpage',
  'clearpage',
  'centering',
  'raggedright',
  'raggedleft',
  'flushleft',
  'flushright',
  'small',
  'footnotesize',
  'scriptsize',
  'tiny',
  'large',
  'Large',
  'LARGE',
  'huge',
  'Huge',
  'verb',
  'url',
  'href',
]);

/**
 * The language extension for LaTeX.
 *
 * The support keeps one piece of state — whether the previous line ended in
 * an unterminated comment — because a LaTeX comment can span a line break.
 */
export function latex(): Extension {
  return StreamLanguage.define<LaTeXState>({
      name: 'latex',

      startState(): LaTeXState {
        return {};
      },

      token(stream): string | null {
        if (stream.eol()) {
          return null;
        }

        const char = stream.peek();

        if (char === '%') {
          // A LaTeX comment runs to the end of the line and no further.
          stream.skipToEnd();
          return 'comment';
        }

        if (char === '\\') {
          stream.next();
          // A command is a backslash followed by letters, or by a single
          // non-letter character.
          const name = stream.match(/^[A-Za-z@]+/);
          if (name) {
            const word = Array.isArray(name) ? name[0] : null;
            return word !== null && LATEX_KEYWORDS.has(word) ? 'keyword' : 'macroName';
          }
          if (!stream.eol()) {
            stream.next();
          }
          return 'macroName';
        }

        if (char === '{' || char === '}') {
          stream.next();
          return 'bracket';
        }

        if (char === '$') {
          stream.next();
          return 'dollar';
        }

        if (char === '&' || char === '~' || char === '_' || char === '^') {
          stream.next();
          return 'operator';
        }

        // Ordinary text runs up to the next special character.
        stream.eatWhile((next) => !'\\{}$%&~_^'.includes(next));
        return null;
      },

      languageData: {
        commentTokens: { line: '%' },
        closeBrackets: { brackets: ['(', '[', '{', '"'] },
      },

      tokenTable: {
        keyword: tags.keyword,
        macroName: tags.function(tags.variableName),
        comment: tags.comment,
        bracket: tags.bracket,
        dollar: tags.special(tags.string),
        operator: tags.operator,
      },
  });
}
