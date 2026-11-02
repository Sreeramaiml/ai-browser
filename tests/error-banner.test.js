import { describe, it, expect } from 'vitest';
import { countdownText } from '../src/sidepanel/components/error-banner.js';

describe('countdownText', () => {
  it('counts down in seconds, then minutes, then says go', () => {
    expect(countdownText(10_500, 0)).toBe('Try again in ~11 s.');
    expect(countdownText(600_000, 0)).toBe('Try again in ~10 min.');
    expect(countdownText(1000, 1000)).toBe('You can try again now.');
  });
});
