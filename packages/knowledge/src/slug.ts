// Duplicated (not imported from @katnor/agents or @katnor/artifacts) so
// this package doesn't pick up either as a dependency just for one small
// function - see those packages' own slug.ts for the same rationale.

/** Lowercase, hyphenated, alnum-only slug. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'page';
}
