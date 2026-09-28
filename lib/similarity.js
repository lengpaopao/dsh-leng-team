/**
 * Lightweight text normalization + Jaccard/character similarity.
 * Used by the watchdog for semantic dead-loop detection (not pure timeout).
 */

/**
 * Normalize text: lower-case, strip punctuation, collapse whitespace, keep CJK.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[\u2000-\u206f\s\p{P}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Character-level n-gram Jaccard similarity (robust for CJK & code).
 * 1.0 = identical, 0 = disjoint.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const A = normalizeText(a);
  const B = normalizeText(b);
  if (!A || !B) return A === B ? 1 : 0;
  if (A === B) return 1;

  const gram = (s, n) => {
    const set = new Set();
    for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
    return set;
  };

  const n = 3;
  const gA = gram(A, n);
  const gB = gram(B, n);
  let inter = 0;
  for (const g of gA) if (gB.has(g)) inter++;
  const denom = gA.size + gB.size - inter;
  return denom === 0 ? 0 : inter / denom;
}
