// @ts-check
// Recognise YouTube video links in all their forms and turn them into one canonical URL (EC-YT-01..04).

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be', 'www.youtu.be'
]);

/**
 * @typedef {{ ok: true, videoId: string, url: string }
 *   | { ok: false, reason: 'not_youtube'|'not_a_video'|'invalid_id', message: string }} YouTubeParse
 */

/** @param {string} videoId */
export function canonicalVideoUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Link to a moment in the video.
 * @param {string} videoId
 * @param {number} seconds
 */
export function videoUrlAt(videoId, seconds) {
  return `${canonicalVideoUrl(videoId)}&t=${Math.max(0, Math.floor(seconds))}s`;
}

/**
 * @param {unknown} input a URL, possibly pasted with spaces or without the scheme
 * @returns {YouTubeParse}
 */
export function parseYouTubeUrl(input) {
  let raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, reason: 'not_youtube', message: 'Paste a YouTube link.' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`; // "youtu.be/abc" without https://

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not_youtube', message: 'That isn’t a valid link.' };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!YOUTUBE_HOSTS.has(host) || !/^https?:$/.test(url.protocol)) {
    return { ok: false, reason: 'not_youtube', message: 'Only public YouTube links are supported.' };
  }

  let id = null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (host.endsWith('youtu.be')) {
    id = segments[0] ?? null;
  } else if (segments[0] === 'watch') {
    id = url.searchParams.get('v'); // a playlist link with v= still names one video (EC-YT-02)
  } else if (['shorts', 'embed', 'live', 'v', 'e'].includes(segments[0])) {
    id = segments[1] ?? null;
  }

  if (id === null) {
    // Channel, search, home or playlist-only pages (EC-YT-02, EC-YT-03).
    return { ok: false, reason: 'not_a_video', message: 'Open a single YouTube video to summarise it.' };
  }
  if (!VIDEO_ID_RE.test(id)) {
    return { ok: false, reason: 'invalid_id', message: 'That YouTube link looks incomplete. Copy the whole link and try again.' };
  }
  return { ok: true, videoId: id, url: canonicalVideoUrl(id) };
}

/**
 * "75" → "1:15", "3725" → "1:02:05".
 * @param {number} totalSeconds
 */
export function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
