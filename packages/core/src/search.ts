export interface Searchable {
  name: string;
  barcodes: readonly string[];
  code?: string;
}

/** Minúsculas y sin acentos: "Alfajor Guaymallén" ≈ "alfajor guaymallen". */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/** Coincidencia exacta por código de barras o código interno (lo que manda el lector). */
export function findByCode<T extends Searchable>(items: readonly T[], code: string): T | undefined {
  const c = code.trim();
  if (!c) return undefined;
  const lc = c.toLowerCase();
  return items.find((p) => p.barcodes.includes(c) || (p.code !== undefined && p.code.toLowerCase() === lc));
}

/**
 * Busca por todas las palabras, en cualquier orden. Prioriza los nombres que empiezan con la búsqueda.
 */
export function searchProducts<T extends Searchable>(items: readonly T[], query: string, limit = 30): T[] {
  const q = normalize(query);
  if (!q) return [];
  const tokens = q.split(/\s+/);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const name = normalize(item.name);
    const haystack = `${name} ${item.code ? normalize(item.code) : ""} ${item.barcodes.join(" ")}`;
    if (!tokens.every((t) => haystack.includes(t))) continue;
    const score = name.startsWith(q) ? 0 : name.split(/\s+/).some((w) => w.startsWith(tokens[0]!)) ? 1 : 2;
    scored.push({ item, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name, "es"))
    .slice(0, limit)
    .map((s) => s.item);
}
