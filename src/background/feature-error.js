// @ts-check
// Errors that come from the page or the user's input rather than the model. Shown with our copy.

export class FeatureError extends Error {
  /**
   * @param {'NO_SELECTION'|'PROTECTED_FIELD'|'PAGE_RESTRICTED'|'NOT_ENOUGH_TEXT'|'INVALID_YOUTUBE_URL'|'UNKNOWN_ACTION'
   *   |'EMPTY_QUESTION'|'PAGE_CHANGED'|'ALREADY_IN_TARGET'|'PAGE_BLOCKED'|'CAPTURE_FAILED'|'IMAGE_INVALID'|'IMAGE_TOO_LARGE'
   *   |'TAB_GONE'|'PROFILE_EMPTY'|'SKILL_NOT_FOUND'|'SKILL_TEMPLATE'|'NEEDS_ACK'} code
   * @param {string} message
   * @param {Record<string, unknown>} [extra] more fields for the panel, e.g. a suggested next step
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'FeatureError';
    this.code = code;
    this.extra = extra;
  }

  toPayload() {
    return { ...this.extra, code: this.code, message: this.message, retryable: false };
  }
}
