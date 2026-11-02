// @ts-check
// YouTube helpers (classic script): video info for summaries, and seek-to-timestamp for chapter chips.

(() => {
  const ns = /** @type {any} */ (globalThis).__sahayak;

  /** The video ID of the page we're on, or null. Mirrors shared/youtube-url.js for the page's own URL. */
  function currentVideoId() {
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) return null;
    const parts = location.pathname.split('/').filter(Boolean);
    const id = parts[0] === 'watch' ? new URLSearchParams(location.search).get('v')
      : ['shorts', 'live', 'embed'].includes(parts[0]) ? parts[1] : null;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }

  function mainVideo() {
    return /** @type {HTMLVideoElement|null} */ (document.querySelector('video.html5-main-video') ?? document.querySelector('video'));
  }

  ns.handlers.CS_YT_INFO = () => {
    const video = mainVideo();
    const duration = video?.duration;
    return {
      videoId: currentVideoId(),
      title: document.title.replace(/\s*-\s*YouTube\s*$/, '').trim() || null,
      durationSeconds: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
      // A live stream's <video> reports an infinite duration (EC-YT-06).
      isLive: duration === Infinity
    };
  };

  /**
   * Jump the player to `seconds` if this page is showing `videoId`. Waits up to 5 s for the player
   * to be ready (e.g. during an ad) before giving up, so the caller can open a link instead (EC-YT-11).
   * @param {{ videoId: string, seconds: number }} payload
   */
  ns.handlers.CS_YT_SEEK = async ({ videoId, seconds }) => {
    if (currentVideoId() !== videoId) return { ok: false, reason: 'different_video' };
    const deadline = Date.now() + 5000;
    let video = mainVideo();
    while ((!video || video.readyState < 1) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      video = mainVideo();
    }
    if (!video || video.readyState < 1) return { ok: false, reason: 'not_ready' };
    video.currentTime = Math.max(0, seconds);
    video.play().catch(() => {}); // autoplay may be blocked; seeking still worked
    return { ok: true };
  };
})();
