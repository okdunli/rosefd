// The dimensions a SHARED cache entry is negotiated on.
//
// Every server-side cache in this framework - the prod server's hot cache and
// the route render memo (`export const cache = N`) - answers bytes that were
// rendered for a different request, so each one's key has to name the whole
// representation. URL + cookie is not the whole representation: a render that
// localizes on Accept-Language, or that reads a private header of its own
// (x-locale, x-rv-url), produces different bytes per request under one URL
// (BUG.md AB). The framework carries accept-language unconditionally; anything
// beyond it has to be declared by the route - `export const hotVary =
// ['x-rv-url']` - which the build turns into a pattern-matched lookup
// (hotVaryFor) in the server bundle.
//
// Index 0 is therefore always accept-language. The rest are the declared
// headers, in declaration order, so a caller that replays them onto a
// synthesized request (the hot cache's warm render) can pair names with values
// by position.
export function hotVaryValues(
  pathname: string,
  hotVaryFor: ((p: string) => string[] | null) | undefined,
  get: (name: string) => string | null | undefined,
): string[] {
  const al = String(get('accept-language') ?? '').trim().toLowerCase();
  const dims = hotVaryFor?.(pathname) ?? [];
  if (!dims.length) return [al];
  return [al, ...dims.map((d) => String(get(d) ?? '').trim())];
}
