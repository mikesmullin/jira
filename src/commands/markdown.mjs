/**
 * jira markdown - Convert standard Markdown to Jira-flavored Wiki Markup
 */

import { parseArgs } from 'util';
import { readFileSync } from 'fs';

const HELP = `
jira markdown - Convert a Markdown file to Jira-flavored Wiki Markup

USAGE:
  jira markdown <file>

OPTIONS:
  -h, --help    Show this help message

DESCRIPTION:
  Reads a standard Markdown file and converts it to Jira Wiki Markup,
  emitting the result to stdout. The source file is never modified.

  Conversion coverage:
    Headings        : # H1 → h1. / ## H2 → h2. / ... (ATX and setext)
    Bold            : **text** / __text__ → *text*
    Italic          : *text* / _text_ → _text_
    Bold + Italic   : ***text*** → *_text_*
    Strikethrough   : ~~text~~ → -text-
    Inline code     : \`code\` → {{code}}
    Fenced code     : \`\`\`lang ... \`\`\` → {code:lang} ... {code}
    Indented code   : 4-space indent → {noformat} ... {noformat}
    Blockquote      : > text → bq. text  (or {quote} block for multi-line)
    Unordered list  : - / * / + items → * / ** / *** (nested)
    Ordered list    : 1. items → # / ## / ### (nested)
    Mixed lists     : nesting tracks type per level (*#, #*, etc.)
    Links           : [text](url) → [text|url]
    Reference links : [text][ref] + [ref]: url → [text|url]
    Autolinks       : <https://url> → [https://url]
    Images          : ![alt](url) → !url!
    Reference imgs  : ![alt][ref] → !url!
    Tables          : Markdown GFM table → Jira ||header|| / |cell| format
    Horizontal rule : --- / *** / ___ → ----
    Hard line break : trailing two spaces → \\\\

EXAMPLES:
  jira markdown notes.md
  jira markdown notes.md > jira-notes.txt
`;

export async function runMarkdown(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const filePath = positionals[0];
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read file "${filePath}": ${err.message}`);
  }

  const jira = convertMarkdownToJira(content);
  process.stdout.write(jira);
}

// ---------------------------------------------------------------------------
// Core converter
// ---------------------------------------------------------------------------

export function convertMarkdownToJira(md) {
  const rawLines = md.split('\n');

  // Pre-pass: collect reference-style link/image definitions and strip them.
  // Format: [id]: url "optional title"
  const refs = {};
  const refDefRegex = /^\[([^\]]+)\]:\s+(\S+)(?:\s+"([^"]*)")?(?:\s+'([^']*)')?(?:\s+\(([^)]*)\))?\s*$/;
  const lines = [];
  for (const line of rawLines) {
    const m = line.match(refDefRegex);
    if (m) {
      refs[m[1].toLowerCase()] = { url: m[2], title: m[3] || m[4] || m[5] };
    } else {
      lines.push(line);
    }
  }

  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // -----------------------------------------------------------------------
    // Fenced code block: ``` or ~~~
    // -----------------------------------------------------------------------
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const lang = fenceMatch[2].trim();
      const codeLines = [];
      i++;
      while (i < lines.length) {
        const closingMatch = lines[i].match(/^(`{3,}|~{3,})\s*$/);
        if (closingMatch && closingMatch[1][0] === fenceChar && closingMatch[1].length >= fenceLen) {
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      const langPart = lang ? `:${lang}` : '';
      output.push(`{code${langPart}}`);
      for (const cl of codeLines) output.push(cl);
      output.push('{code}');
      continue;
    }

    // -----------------------------------------------------------------------
    // Setext headings: next line is === or ---
    // -----------------------------------------------------------------------
    if (i + 1 < lines.length && line.trim() !== '') {
      const next = lines[i + 1];
      if (/^=+\s*$/.test(next)) {
        output.push(`h1. ${applyInline(line.trim(), refs)}`);
        i += 2;
        continue;
      }
      // Setext h2: only if current line is not itself a list item or HR
      if (/^-+\s*$/.test(next) && !line.match(/^(\s*)([-*+]|\d+\.)\s/) && !isHorizontalRule(line)) {
        output.push(`h2. ${applyInline(line.trim(), refs)}`);
        i += 2;
        continue;
      }
    }

    // -----------------------------------------------------------------------
    // ATX headings: # through ######
    // -----------------------------------------------------------------------
    const atxMatch = line.match(/^(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/);
    if (atxMatch) {
      const level = atxMatch[1].length;
      const text = atxMatch[2].trim();
      output.push(`h${level}. ${applyInline(text, refs)}`);
      i++;
      continue;
    }

    // -----------------------------------------------------------------------
    // Horizontal rule: ---, ***, ___ (3+ chars, no other content)
    // -----------------------------------------------------------------------
    if (isHorizontalRule(line)) {
      output.push('----');
      i++;
      continue;
    }

    // -----------------------------------------------------------------------
    // Blockquote: lines starting with >
    // -----------------------------------------------------------------------
    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      if (quoteLines.length === 1) {
        output.push(`bq. ${applyInline(quoteLines[0], refs)}`);
      } else {
        output.push('{quote}');
        for (const ql of quoteLines) output.push(applyInline(ql, refs));
        output.push('{quote}');
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // GFM table: lines starting with |
    // -----------------------------------------------------------------------
    if (/^\|/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      for (const tl of convertTable(tableLines, refs)) output.push(tl);
      continue;
    }

    // -----------------------------------------------------------------------
    // List items: unordered (- * +) or ordered (1.)
    // Also captures GFM task lists: - [ ] / - [x]
    // Collect the whole contiguous list block (blank lines between items ok).
    // -----------------------------------------------------------------------
    if (/^(\s*)([-*+]|\d+\.)\s/.test(line)) {
      const listItems = [];
      let j = i;
      while (j < lines.length) {
        const lm = lines[j].match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
        if (lm) {
          // Detect GFM task list checkbox: [ ] or [x] / [X]
          let text = lm[3];
          let taskPrefix = '';
          const taskMatch = text.match(/^\[([ xX])\]\s+(.*)/);
          if (taskMatch) {
            taskPrefix = taskMatch[1].trim().toLowerCase() === 'x' ? '(/) ' : '(x) ';
            text = taskMatch[2];
          }
          listItems.push({ indent: lm[1].length, ordered: /^\d+\./.test(lm[2]), text, taskPrefix });
          j++;
        } else if (
          lines[j].trim() === '' &&
          j + 1 < lines.length &&
          /^(\s*)([-*+]|\d+\.)\s/.test(lines[j + 1])
        ) {
          // Blank line between list items – skip and continue collecting.
          j++;
        } else {
          break;
        }
      }
      i = j;
      for (const ll of convertList(listItems, refs)) output.push(ll);
      continue;
    }

    // -----------------------------------------------------------------------
    // Indented code block: 4-space or 1-tab indent (not inside list context)
    // -----------------------------------------------------------------------
    if (/^(    |\t)/.test(line)) {
      const codeLines = [];
      while (i < lines.length && /^(    |\t)/.test(lines[i])) {
        codeLines.push(lines[i].replace(/^(    |\t)/, ''));
        i++;
      }
      output.push('{noformat}');
      for (const cl of codeLines) output.push(cl);
      output.push('{noformat}');
      continue;
    }

    // -----------------------------------------------------------------------
    // Regular line (paragraph text, blank lines, etc.)
    // -----------------------------------------------------------------------
    output.push(applyInline(line, refs));
    i++;
  }

  return output.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the line is a Markdown horizontal rule. */
function isHorizontalRule(line) {
  const stripped = line.trim();
  if (stripped.length < 3) return false;
  // Must consist only of one repeated character from - * _ (with optional spaces)
  const ch = stripped[0];
  if (ch !== '-' && ch !== '*' && ch !== '_') return false;
  const withoutSpaces = stripped.replace(/\s/g, '');
  return withoutSpaces.split('').every(c => c === ch) && withoutSpaces.length >= 3;
}

/** Convert a collected list of list-item metadata to Jira markup lines. */
function convertList(items, refs) {
  const result = [];
  const indentStack = [];  // stack of indent values
  const typeStack = [];    // stack of '#' or '*'

  for (const item of items) {
    const { indent, ordered } = item;
    // Pop stack levels that are deeper than current indent
    while (indentStack.length > 0 && indent < indentStack[indentStack.length - 1]) {
      indentStack.pop();
      typeStack.pop();
    }

    if (indentStack.length === 0 || indent > indentStack[indentStack.length - 1]) {
      // New nesting level
      indentStack.push(indent);
      typeStack.push(ordered ? '#' : '*');
    } else {
      // Same nesting level – update marker type in case ul/ol changed
      typeStack[typeStack.length - 1] = ordered ? '#' : '*';
    }

    const marker = typeStack.join('');
    result.push(`${marker} ${item.taskPrefix || ''}${applyInline(item.text, refs)}`);
  }

  return result;
}

/** Convert a collected block of GFM table lines to Jira table markup. */
function convertTable(tableLines, refs) {
  const result = [];
  let dataRowCount = 0;

  for (const line of tableLines) {
    // Skip separator rows (only -, |, :, space)
    if (/^\|[\s|:-]+\|$/.test(line)) continue;

    // Split on | and remove the leading/trailing empty strings from split.
    const cells = line
      .split('|')
      .slice(1, -1)
      .map(c => c.trim());

    if (dataRowCount === 0) {
      // Header row: wrap cells with ||
      result.push('||' + cells.map(c => applyInline(c, refs)).join('||') + '||');
    } else {
      // Data row: wrap cells with |
      result.push('|' + cells.map(c => applyInline(c, refs)).join('|') + '|');
    }
    dataRowCount++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Inline transformation
// ---------------------------------------------------------------------------

/**
 * Convert inline Markdown syntax within a single line (or inline span) to
 * Jira Wiki Markup. Uses placeholders to prevent double-conversion.
 */
function applyInline(text, refs = {}) {
  // We accumulate "protected" spans in this array. Each entry is a final
  // Jira string that must not be transformed further.
  const protected_ = [];

  function protect(s) {
    const idx = protected_.length;
    protected_.push(s);
    return `\x00P${idx}\x00`;
  }

  // 0. Markdown backslash escapes: \X → protect as Jira-escaped \X so that
  //    characters which are also special in Jira markup (*, _, -, ~, ^, etc.)
  //    are not mis-interpreted by Jira's renderer.
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!|<>~^])/g, (_, ch) => protect(`\\${ch}`));

  // 1. Inline code: `code` → {{code}}
  //    Use a non-greedy match; handle escaped backticks by requiring at least
  //    one non-backtick char inside.
  text = text.replace(/`([^`]+)`/g, (_, code) => protect(`{{${code}}}`));

  // 2. Images before links (both reference and inline).
  //    ![alt](url "title") → !url|title=title!  or  !url!
  text = text.replace(/!\[([^\]]*)\]\(([^)\s"]+)(?:\s+"([^"]*)")?\)/g, (_, alt, url, title) => {
    const suffix = title ? `|title=${title}` : alt ? `|alt=${alt}` : '';
    return protect(`!${url}${suffix}!`);
  });

  //    ![alt][ref] or ![alt][] reference-style images
  text = text.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (_, alt, ref) => {
    const key = (ref || alt).toLowerCase();
    const refData = refs[key];
    if (!refData) return protect(`!${alt}!`);
    return protect(`!${refData.url}!`);
  });

  // 3. Inline links: [text](url "title") → [text|url]
  text = text.replace(/\[([^\]]+)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g, (_, linkText, url) => {
    return protect(`[${linkText}|${url}]`);
  });

  //    Reference-style links: [text][ref] or [text][]
  text = text.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (_, linkText, ref) => {
    const key = (ref || linkText).toLowerCase();
    const refData = refs[key];
    if (!refData) return linkText;
    return protect(`[${linkText}|${refData.url}]`);
  });

  //    Autolinks: <https://url> or <mailto:addr>
  text = text.replace(/<((?:https?|mailto):[^>]+)>/g, (_, url) => protect(`[${url}]`));

  // 3b. Inline HTML tags with text content → Jira equivalents
  //     Order: most-specific first to avoid double-matching.
  //     <strong> / <b>
  text = text.replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, (_, t) => protect(`*${t}*`));
  //     <em> / <i>
  text = text.replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, (_, t) => protect(`_${t}_`));
  //     <sup>
  text = text.replace(/<sup>([\s\S]*?)<\/sup>/gi, (_, t) => protect(`^${t}^`));
  //     <sub>
  text = text.replace(/<sub>([\s\S]*?)<\/sub>/gi, (_, t) => protect(`~${t}~`));
  //     <u>
  text = text.replace(/<u>([\s\S]*?)<\/u>/gi, (_, t) => protect(`+${t}+`));
  //     <s> / <del> / <strike>
  text = text.replace(/<(?:s|del|strike)>([\s\S]*?)<\/(?:s|del|strike)>/gi, (_, t) => protect(`-${t}-`));
  //     <code>
  text = text.replace(/<code>([\s\S]*?)<\/code>/gi, (_, t) => protect(`{{${t}}}`));
  //     <br> / <br/> / <br /> (self-closing)
  text = text.replace(/<br\s*\/?>/gi, () => protect(' \\\\'));

  // 4. Bold + Italic: ***text*** or ___text___
  //    Also handles mixed: **_text_** or _**text**_
  text = text.replace(/\*{3}([^*\n]+)\*{3}/g, (_, t) => protect(`*_${t}_*`));
  text = text.replace(/_{3}([^_\n]+)_{3}/g, (_, t) => protect(`*_${t}_*`));
  text = text.replace(/\*{2}_([^_\n]+)_\*{2}/g, (_, t) => protect(`*_${t}_*`));
  text = text.replace(/_\*{2}([^*\n]+)\*{2}_/g, (_, t) => protect(`*_${t}_*`));

  // 5. Bold: **text** or __text__ → *text*
  text = text.replace(/\*{2}([^*\n]+)\*{2}/g, (_, t) => protect(`*${t}*`));
  text = text.replace(/_{2}([^_\n]+)_{2}/g, (_, t) => protect(`*${t}*`));

  // 6. Italic: *text* → _text_  (only remaining * after bold consumed above)
  //    _text_ is already Jira italic – no change needed.
  text = text.replace(/\*([^*\n]+)\*/g, (_, t) => protect(`_${t}_`));

  // 7. Strikethrough: ~~text~~ → -text-
  text = text.replace(/~~([^~\n]+)~~/g, (_, t) => protect(`-${t}-`));

  // 8. Hard line break: trailing two or more spaces → Jira \\
  text = text.replace(/  +$/, ' \\\\');

  // 9. Restore all placeholders (loop because protected spans never contain
  //    \x00Pn\x00 themselves, so a single pass suffices).
  text = text.replace(/\x00P(\d+)\x00/g, (_, idx) => protected_[parseInt(idx, 10)]);

  return text;
}
