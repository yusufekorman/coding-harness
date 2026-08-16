import { stripAnsi } from "./term";

/**
 * Converts Markdown to plain terminal text (strips bold, headings, lists, links,
 * inline code, code fences, etc.). Does not add ANSI; coloring is up to the caller.
 */
export function mdToText(md: string): string {
  let t = md;
  // code fence lines
  t = t.replace(/^```[^\n]*$/gm, "");
  t = t.replace(/^~~~[^\n]*$/gm, "");
  // leftover fence markers mid-line
  t = t.replace(/```[a-zA-Z0-9_-]*/g, "");
  t = t.replace(/~~~/g, "");
  // headings
  t = t.replace(/^#{1,6}[ \t]+/gm, "");
  // blockquote
  t = t.replace(/^>[ \t]?/gm, "");
  // horizontal rules (---, ***, ___)
  t = t.replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "");
  // bold
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  // images and links
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // inline code
  t = t.replace(/`([^`\n]+)`/g, "$1");
  // italics (leave spaced `a * b` expressions alone)
  t = t.replace(/(^|[^*])\*([^*\s][^*\n]*)\*(?!\*)/g, "$1$2");
  // lists
  t = t.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
  t = t.replace(/^([ \t]*)\d+[.)][ \t]+/gm, "$1");
  // collapse excess blank lines
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trimEnd();
}

/**
 * Wraps text line by line to the given visible width; forces breaks in overly long
 * single tokens (URL, hash, etc.).
 */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];

  const push = (l: string) => {
    while (stripAnsi(l).length > w) {
      out.push(l.slice(0, w));
      l = l.slice(w);
    }
    out.push(l);
  };

  for (const para of text.split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!line) {
        line = word;
        continue;
      }
      if (stripAnsi(line).length + 1 + stripAnsi(word).length <= w) {
        line += " " + word;
        continue;
      }
      push(line);
      line = word;
    }
    push(line);
  }

  return out;
}
