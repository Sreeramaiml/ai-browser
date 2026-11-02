import { describe, it, expect } from 'vitest';
import { canonicalVideoUrl, formatTimestamp, parseYouTubeUrl, videoUrlAt } from '../src/shared/youtube-url.js';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeUrl (EC-YT-01)', () => {
  const forms = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=30s`,
    `https://youtube.com/watch?feature=share&v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=AbCdEf`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}?start=10`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `youtu.be/${ID}`,
    `  www.youtube.com/watch?v=${ID}  `,
    `https://WWW.YOUTUBE.COM/watch?v=${ID}`
  ];
  for (const url of forms) {
    it(`${url.trim()} → canonical`, () => {
      expect(parseYouTubeUrl(url)).toEqual({ ok: true, videoId: ID, url: `https://www.youtube.com/watch?v=${ID}` });
    });
  }
});

describe('parseYouTubeUrl rejects (EC-YT-02..04, EC-YT-13)', () => {
  const bad = [
    ['https://www.youtube.com/playlist?list=PL123', 'not_a_video'],
    ['https://www.youtube.com/@somechannel', 'not_a_video'],
    ['https://www.youtube.com/results?search_query=cats', 'not_a_video'],
    ['https://www.youtube.com/', 'not_a_video'],
    ['https://www.youtube.com/watch?v=abc', 'invalid_id'],
    ['https://youtu.be/', 'not_a_video'],
    ['https://vimeo.com/123456', 'not_youtube'],
    ['https://youtube.com.evil.example/watch?v=' + ID, 'not_youtube'],
    ['javascript:alert(1)', 'not_youtube'],
    ['', 'not_youtube'],
    [undefined, 'not_youtube']
  ];
  for (const [url, reason] of bad) {
    it(`${String(url) || '(empty)'} → ${reason}`, () => {
      const r = parseYouTubeUrl(url);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
    });
  }
});

describe('URL helpers', () => {
  it('builds canonical and timestamped links', () => {
    expect(canonicalVideoUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(videoUrlAt(ID, 95.7)).toBe(`https://www.youtube.com/watch?v=${ID}&t=95s`);
    expect(videoUrlAt(ID, -5)).toBe(`https://www.youtube.com/watch?v=${ID}&t=0s`);
  });

  it('formats timestamps as m:ss or h:mm:ss', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(75)).toBe('1:15');
    expect(formatTimestamp(600)).toBe('10:00');
    expect(formatTimestamp(3725)).toBe('1:02:05');
  });
});
