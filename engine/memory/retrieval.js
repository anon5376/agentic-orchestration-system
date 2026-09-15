// Deterministic retrieval with no dependency: lexical overlap, tag matches, recency,
// confidence and pins. A later embedding provider implements the same interface.
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'its', 'into', 'than', 'then', 'they', 'them', 'their', 'what', 'when', 'where', 'which', 'while', 'will', 'would', 'should', 'could', 'about', 'over', 'under', 'only', 'also', 'more', 'most', 'some', 'such', 'each', 'other', 'there', 'these', 'those', 'your', 'you', 'our', 'run', 'task']);

export function tokenize(text) {
  const tokens = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}

function overlap(queryTokens, docTokens) {
  if (!queryTokens.size || !docTokens.size) return 0;
  let hits = 0;
  for (const token of queryTokens) if (docTokens.has(token)) hits += 1;
  return hits / queryTokens.size;
}

export class LexicalRetrieval {
  id = 'lexical';

  score(item, { queryTokens, tags, now }) {
    const titleTokens = tokenize(item.title);
    const contentTokens = tokenize(item.content);
    const tagSet = new Set((item.tags || []).map((tag) => String(tag).toLowerCase()));
    let tagHits = 0;
    for (const tag of tags) if (tagSet.has(tag)) tagHits += 1;
    let tagTokenHits = 0;
    for (const token of queryTokens) if (tagSet.has(token)) tagTokenHits += 1;
    const ageDays = Math.max(0, (now - Date.parse(item.updatedAt || item.createdAt)) / 86_400_000);
    const recency = 1 / (1 + ageDays / 30);
    const typeBoost = item.type === 'decision' || item.type === 'failure_lesson' ? 0.3 : item.type === 'procedure' ? 0.2 : 0;
    return 3 * tagHits + 1.5 * tagTokenHits + 2 * overlap(queryTokens, titleTokens) + overlap(queryTokens, contentTokens) + recency + 0.5 * (item.confidence ?? 0.5) + (item.pinned ? 1 : 0) + typeBoost;
  }

  // Returns items ranked by score, deterministic on ties (newest first, then id).
  search(items, { query = '', tags = [], limit = 8, maxChars = 6000, now = Date.now(), minScore = 0 } = {}) {
    const queryTokens = tokenize(query);
    const wantedTags = new Set(tags.map((tag) => String(tag).toLowerCase()));
    const scored = items
      .map((item) => ({ item, score: this.score(item, { queryTokens, tags: wantedTags, now }) }))
      .filter((entry) => entry.score > minScore && (queryTokens.size || wantedTags.size ? entry.score > 1.0 + 0.5 * (entry.item.confidence ?? 0.5) + (entry.item.pinned ? 1 : 0) || entry.item.pinned : true))
      .sort((a, b) => b.score - a.score || Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt) || a.item.id.localeCompare(b.item.id));
    const selected = [];
    let chars = 0;
    let truncated = 0;
    for (const entry of scored) {
      if (selected.length >= limit) { truncated += 1; continue; }
      const size = String(entry.item.title).length + String(entry.item.content).length;
      if (chars + size > maxChars) { truncated += 1; continue; }
      chars += size;
      selected.push(entry);
    }
    return { selected, truncated, considered: items.length };
  }
}
