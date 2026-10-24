/** @file Provider-independent search token normalization and deterministic food relevance ranking. */

export type FoodSearchTokenOptions = {
  minTokenLength?: number;
  stopWords?: ReadonlySet<string>;
};

/** Normalize provider text into a stable lowercase token string. */
export function normalizeFoodSearchText(value?: string): string {
  if (!value) return '';

  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Drop possessive suffixes so "joe's" matches "joe".
    .replace(/['\u2019]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Apply intentionally small stemming so common plural queries match singular product names. */
function stemFoodSearchToken(token: string): string {
  if (!token) return '';
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Normalize, stem and deduplicate query tokens, optionally excluding short terms and supplied stop words. */
export function tokenizeFoodSearchQuery(
  query: string,
  options: FoodSearchTokenOptions = {}
): string[] {
  const normalized = normalizeFoodSearchText(query);
  if (!normalized) return [];

  const minTokenLength = options.minTokenLength ?? 1;
  const tokens = normalized
    .split(' ')
    .filter(Boolean)
    .map(stemFoodSearchToken)
    .filter((token) => token.length >= minTokenLength)
    .filter((token) => !options.stopWords?.has(token));

  return Array.from(new Set(tokens));
}

/** Join normalized tokens, preserving the caller's fallback when tokenization yields no searchable text. */
export function buildFoodSearchQuery(tokens: string[], fallback: string): string {
  const joined = tokens.join(' ').trim();
  return joined || fallback;
}

/** Build synonym alternatives for product concepts used by every text-search provider. */
export function buildProductTokenGroups(productTokens: string[]): string[][] {
  const groups: string[][] = [];
  if (productTokens.length > 0) groups.push(productTokens);

  const tokenSet = new Set(productTokens);
  if (tokenSet.has('hot') && tokenSet.has('dog')) {
    groups.push(['frank'], ['frankfurter'], ['wiener']);
  }

  return groups.map((group) => group.map(stemFoodSearchToken).filter(Boolean));
}

/** Count query-token membership in the normalized product token set. */
export function countTokenMatches(
  haystack: ReadonlySet<string>,
  tokens: string[]
): number {
  return tokens.reduce(
    (count, token) => (haystack.has(token) ? count + 1 : count),
    0
  );
}

/** Award full-match weight only for a nonempty complete match; otherwise weight each matched term. */
export function scoreTokenMatches(
  matchCount: number,
  tokenCount: number,
  fullMatchScore: number,
  partialMatchWeight: number
): number {
  if (tokenCount === 0) return 0;
  if (matchCount >= tokenCount) return fullMatchScore;
  return matchCount * partialMatchWeight;
}

/** Use the strongest alternative token-group match rather than accumulating duplicate query interpretations. */
export function scoreProductTokenGroups(
  haystack: ReadonlySet<string>,
  groups: string[][]
): number {
  let best = 0;
  for (const group of groups) {
    const matches = countTokenMatches(haystack, group);
    const score = scoreTokenMatches(matches, group.length, 100, 10);
    if (score > best) best = score;
  }
  return best;
}
