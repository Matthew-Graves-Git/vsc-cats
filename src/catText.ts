/** Helpers that turn Cat Bot's messages into the short text the panel shows. */

/** Case-insensitive regex from a setting; an invalid pattern is matched literally. */
function toRegex(s: string): RegExp {
  try {
    return new RegExp(s, 'i');
  } catch {
    return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "Fine cat has appeared! Type "cat" to catch it!" -> "Fine cat has appeared!" */
export function spawnCaption(text: string, trigger: string): string {
  const m = toRegex(trigger).exec(text);
  return squash(m ? text.slice(0, m.index + m[0].length) : text);
}

/** "Fine cat has appeared!" -> "Fine cat" */
export function spawnType(text: string, trigger: string): string | undefined {
  const m = toRegex(trigger).exec(text);
  if (!m) {
    return undefined;
  }
  const type = squash(text.slice(0, m.index)).replace(/\s+(has|is)$/i, '');
  return /\bcat$/i.test(type) && type.length <= 40 ? type : undefined;
}

/** "Fine cat" -> "Fine Cat Appeared!"; no type -> "Cat Appeared!" */
export function spawnTitle(type: string | undefined): string {
  const name = (type ?? '').replace(/\s*\bcat$/i, '').trim();
  return name ? `${name} Cat Appeared!` : 'Cat Appeared!';
}

/**
 * The word right before "cat" in the spawn text, lowercased, for picking the GIF.
 * "Fine cat has appeared!" -> "fine", "A wild eGirl cat has appeared!" -> "egirl".
 * Only the text before the trigger counts, so 'Type "cat" to catch it!' is ignored.
 */
export function spawnWord(text: string, trigger: string): string | undefined {
  const m = toRegex(trigger).exec(text);
  const before = m ? text.slice(0, m.index) : text;
  let word: string | undefined;
  for (const w of before.matchAll(/(\S+)\s+cat\b/gi)) {
    word = w[1]; // keep the last one
  }
  const clean = word?.replace(/[^0-9a-z]/gi, '').toLowerCase();
  return clean || undefined;
}

/**
 * Cat Bot's late-catcher list -> the names on it.
 * "Late Fine catchers:\nmatthewgraves_ (+0.42s, 12 total)\n-# up to 3 late catchers..." -> ["matthewgraves_"]
 */
export function parseLateCatchers(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s+\(\+[\d.]+s,/.exec(line);
    if (m) {
      names.push(m[1].replace(/\\_/g, '_').trim());
    }
  }
  return names;
}

/** True when the text looks like Cat Bot's late-catcher list. */
export const isLateCatchers = (text: string): boolean => /\bLate\b.+\bcatchers:/i.test(text);

/** Case-insensitive name comparison; Cat Bot escapes underscores as "\_". */
export function sameName(a: string | undefined, b: string | undefined): boolean {
  const norm = (s: string) => s.replace(/\\_/g, '_').replace(/^@/, '').trim().toLowerCase();
  return !!a && !!b && norm(a) !== '' && norm(a) === norm(b);
}

/**
 * "matthewgraves_ cought  Nice cat!!!!1! You now have..." -> { who: "matthewgraves_", type: "Nice cat" }
 */
export function parseCatch(text: string, caught: string): { who?: string; type?: string } {
  const m = toRegex(caught).exec(text);
  if (!m) {
    return {};
  }
  const who = squash(text.slice(0, m.index)).replace(/^@/, '');
  const type = /^\s*(.{1,40}?\bcat)\b/i.exec(text.slice(m.index + m[0].length))?.[1];
  return {
    who: who && who.length <= 32 ? who : undefined,
    type: type ? squash(type) : undefined,
  };
}
