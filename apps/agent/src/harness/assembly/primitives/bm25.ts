export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Index {
  search(query: string, limit: number): string[];
}

const K1 = 1.2;
const B = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

export function createBm25Index(documents: Bm25Document[]): Bm25Index {
  const docs = documents.map((doc) => ({
    id: doc.id,
    tokens: tokenize(doc.text),
  }));
  const docLengths = docs.map((d) => d.tokens.length);
  const avgLen = docLengths.length === 0
    ? 0
    : docLengths.reduce((a, b) => a + b, 0) / docLengths.length;

  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set(doc.tokens);
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docs.length;

  return {
    search(query: string, limit: number): string[] {
      const qTerms = tokenize(query);
      if (qTerms.length === 0 || n === 0) return [];

      const scores = docs.map((doc, i) => {
        const len = docLengths[i] ?? 0;
        const tf = new Map<string, number>();
        for (const term of doc.tokens) tf.set(term, (tf.get(term) ?? 0) + 1);

        let score = 0;
        for (const term of qTerms) {
          const freq = tf.get(term) ?? 0;
          if (freq === 0) continue;
          const docFreq = df.get(term) ?? 0;
          const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
          const denom = freq + K1 * (1 - B + B * (len / (avgLen || 1)));
          score += idf * ((freq * (K1 + 1)) / denom);
        }
        return { id: doc.id, score };
      });

      return scores
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, limit))
        .map((row) => row.id);
    },
  };
}
