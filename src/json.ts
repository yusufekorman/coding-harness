export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }

  const start = trimmed.search(/[{\[]/);
  if (start !== -1) {
    for (let end = trimmed.length; end > start; end--) {
      const sub = trimmed.slice(start, end);
      try {
        return JSON.parse(sub);
      } catch {
        /* keep shrinking */
      }
    }
  }

  return null;
}
