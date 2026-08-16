import { stripAnsi } from "./term";

/**
 * Markdown'ı düz terminal metnine çevirir (kalın, başlık, liste, link, inline code,
 * code fence vb. sözdizimini temizler). ANSI eklemez; renklendirme çağıran tarafta.
 */
export function mdToText(md: string): string {
  let t = md;
  // code fence satırları
  t = t.replace(/^```[^\n]*$/gm, "");
  t = t.replace(/^~~~[^\n]*$/gm, "");
  // satır ortasında kalan fence işaretleri
  t = t.replace(/```[a-zA-Z0-9_-]*/g, "");
  t = t.replace(/~~~/g, "");
  // başlıklar
  t = t.replace(/^#{1,6}[ \t]+/gm, "");
  // blockquote
  t = t.replace(/^>[ \t]?/gm, "");
  // yatay çizgiler (---, ***, ___)
  t = t.replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "");
  // kalın
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  // görseller ve linkler
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // inline code
  t = t.replace(/`([^`\n]+)`/g, "$1");
  // italik (boşluklu `a * b` ifadelerine dokunma)
  t = t.replace(/(^|[^*])\*([^*\s][^*\n]*)\*(?!\*)/g, "$1$2");
  // listeler
  t = t.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
  t = t.replace(/^([ \t]*)\d+[.)][ \t]+/gm, "$1");
  // fazla boş satırları sıkıştır
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trimEnd();
}

/**
 * Metni belirtilen görünür genişliğe satır satır sarar; aşırı uzun tek parçaları
 * (URL, hash vb.) zorla böler.
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
