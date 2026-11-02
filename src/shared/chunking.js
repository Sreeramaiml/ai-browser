// @ts-check
// Relevance chunking for long pages (architecture §8.6): split into ~2k-char chunks, always keep the
// first one, then fill the budget with the chunks that share the most keywords with the question.
// No embeddings: keyword overlap weighted by how rare each word is across the page.

import { CHAT_CHUNK_CHARS } from './config.js';

/** Marks text that was left out between two chunks. The chat prompt explains it to the model. */
export const GAP_MARKER = '\n\n[…]\n\n';

/** Question words that say nothing about where the answer is. English plus common Hinglish (EC-CHT-06). */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'about',
  'as', 'into', 'than', 'then', 'so', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
  'has', 'have', 'had', 'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must', 'shall',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'this', 'that', 'these', 'those',
  'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their', 'there', 'here',
  'any', 'all', 'some', 'more', 'most', 'other', 'such', 'no', 'not', 'only', 'own', 'same', 'too', 'very',
  'just', 'also', 'please', 'tell', 'explain', 'say', 'says', 'said', 'give', 'list', 'mention', 'mentioned',
  'page', 'article', 'post', 'site', 'website', 'one', 'ones', 'thing', 'things',
  'kya', 'hai', 'hain', 'tha', 'thi', 'the', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'me', 'aur', 'ya', 'yeh', 'ye',
  'woh', 'wo', 'is', 'us', 'iska', 'iski', 'iske', 'uska', 'uski', 'uske', 'par', 'pe', 'bhi', 'toh', 'to',
  'kaun', 'kab', 'kahan', 'kaise', 'kyun', 'kitna', 'kitne', 'kitni', 'batao', 'bataiye', 'bata', 'samjhao',
  'mujhe', 'hum', 'aap', 'tum', 'nahi', 'nahin', 'hota', 'hoti', 'hote', 'karta', 'karte', 'karna', 'liye'
]);

/**
 * Lower-cased words and numbers, in any script (Devanagari pages and questions work too).
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
}

/**
 * Crude English stemming so "prices" matches "price" and "caused" matches "cause". Applied to both
 * the question and the page; stems only need to agree with each other, not be real words.
 * @param {string} word
 */
function stem(word) {
  if (word.length <= 3 || !/^[a-z]+$/.test(word)) return word;
  return word
    .replace(/ie[sd]$/, 'y') // studies, studied → study
    .replace(/(?<=(?:s|x|z|ch|sh))es$/, '') // boxes → box
    .replace(/(?<![siu])s$/, '') // prices → price, but not class / analysis / status
    .replace(/(?<=[a-z]{3})(?:ing|ed)$/, '') // launched → launch, but not king / need
    .replace(/e$/, ''); // price, priced → pric
}

/**
 * The distinct search terms in a question.
 * @param {string} question
 * @returns {string[]}
 */
export function extractKeywords(question) {
  const keys = new Set();
  for (const token of tokenize(question)) {
    if (STOPWORDS.has(token)) continue;
    if (token.length < 2 && !/^\p{N}+$/u.test(token)) continue;
    keys.add(stem(token));
  }
  return [...keys];
}

/**
 * Break a line that is longer than a chunk at sentence ends, and hard-cut any sentence that still is.
 * @param {string} text
 * @param {number} size
 */
function pieces(text, size) {
  const out = [];
  for (const line of text.split(/\n+/)) {
    if (line.length <= size) {
      out.push(line);
      continue;
    }
    for (const sentence of line.split(/(?<=[.!?।])\s+/)) {
      for (let i = 0; i < sentence.length; i += size) out.push(sentence.slice(i, i + size));
    }
  }
  return out;
}

/**
 * Split text into chunks of at most `size` chars, on line and sentence boundaries where possible.
 * @param {string} text
 * @param {number} [size]
 * @returns {string[]}
 */
export function splitIntoChunks(text, size = CHAT_CHUNK_CHARS) {
  const chunks = [];
  let current = '';
  for (const piece of pieces(text, size)) {
    if (!piece.trim()) continue;
    if (current && current.length + 1 + piece.length > size) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Score each chunk by the question's keywords it contains. Rare words count more (idf), repeated
 * words a little more (log tf).
 * @param {string[]} chunks
 * @param {string[]} keywords
 * @returns {number[]}
 */
export function scoreChunks(chunks, keywords) {
  const counts = chunks.map((chunk) => {
    /** @type {Map<string, number>} */
    const m = new Map();
    for (const term of tokenize(chunk).map(stem)) m.set(term, (m.get(term) ?? 0) + 1);
    return m;
  });
  const idf = new Map(keywords.map((k) => {
    const df = counts.filter((m) => m.has(k)).length;
    return [k, Math.log(1 + chunks.length / (1 + df))];
  }));
  return counts.map((m) => keywords.reduce((score, k) => {
    const tf = m.get(k);
    return tf ? score + (idf.get(k) ?? 0) * (1 + Math.log(tf)) : score;
  }, 0));
}

/**
 * Fit a page into `budget` chars for one question: the head chunk, then the best-scoring chunks,
 * then whatever else fits. Chunks keep their page order; gaps are marked with GAP_MARKER.
 * @param {string} text
 * @param {string} query the question (plus the previous one, so follow-ups find the same section)
 * @param {number} budget
 * @param {{ chunkChars?: number }} [opts]
 * @returns {{ text: string, truncated: boolean }}
 */
export function selectRelevant(text, query, budget, { chunkChars = CHAT_CHUNK_CHARS } = {}) {
  if (text.length <= budget) return { text, truncated: false };
  const chunks = splitIntoChunks(text, chunkChars);
  if (chunks.length === 0) return { text: '', truncated: false };

  const scores = scoreChunks(chunks, extractKeywords(query));
  const order = chunks.map((_, i) => i).slice(1).sort((a, b) => scores[b] - scores[a] || a - b);

  const chosen = new Set([0]);
  let used = Math.min(chunks[0].length, budget);
  for (const i of order) {
    const cost = chunks[i].length + GAP_MARKER.length;
    if (used + cost > budget) continue; // a shorter chunk later in the order may still fit
    chosen.add(i);
    used += cost;
  }

  const picked = [...chosen].sort((a, b) => a - b);
  let out = chunks[0].slice(0, budget);
  for (let n = 1; n < picked.length; n++) {
    out += (picked[n] === picked[n - 1] + 1 ? '\n' : GAP_MARKER) + chunks[picked[n]];
  }
  if (picked[picked.length - 1] !== chunks.length - 1) out += GAP_MARKER.trimEnd();
  return { text: out, truncated: true };
}
