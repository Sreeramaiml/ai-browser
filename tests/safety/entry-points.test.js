import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { createAgentRunner } from '../../src/background/agent/agent-controller.js';
import { createAgentStore } from '../../src/background/agent/agent-store.js';
import { FeatureError } from '../../src/background/feature-error.js';
import { createFind } from '../../src/background/find.js';
import { createQuickActions } from '../../src/background/quick-actions.js';
import { createSkillRunner } from '../../src/background/skill-runner.js';
import { createSummaries } from '../../src/background/summaries.js';
import { starterSkills } from '../../src/shared/default-skills.js';

/** A gateway that records whether anything was sent. */
function gateway() {
  const sent = [];
  return {
    sent,
    stream: async (req) => { sent.push(req); req.onDelta('x'); return { text: 'x', model: 'm', provider: 'gemini', stopReason: 'end_turn' }; },
    json: async (req) => { sent.push(req); return { value: {}, model: 'm', provider: 'gemini' }; }
  };
}
const blocked = async () => { throw new FeatureError('PAGE_BLOCKED', 'Sahayak is switched off on payment and banking pages to keep your money safe.'); };
const io = () => ({ onStart: () => {}, onDelta: () => {} });
const codeOf = (p) => p.then(() => null, (e) => e.code);

describe('every feature checks the page before anything leaves the browser (P4.3 step 3)', () => {
  it('selection quick actions: a refusal sends nothing', async () => {
    const g = gateway();
    const reads = [];
    const qa = createQuickActions({
      gateway: g, getLanguage: async () => 'en', checkPage: blocked,
      getSelection: async (tabId) => { reads.push(tabId); return { text: 'secret' }; }
    });
    expect(await codeOf(qa.run({ kind: 'explain', tabId: 7 }, io()))).toBe('PAGE_BLOCKED');
    expect(reads).toEqual([]);
    expect(g.sent).toEqual([]);
  });

  it('selection quick actions on an acknowledged private page send the selected words only (EC-TIR-09)', async () => {
    const g = gateway();
    const starts = [];
    const qa = createQuickActions({
      gateway: g, getLanguage: async () => 'en', checkPage: async () => ({ scope: 'selection-only' }),
      getSelection: async () => ({
        text: 'Can we meet on Friday?', contextBefore: 'PRIVATE BEFORE', contextAfter: 'PRIVATE AFTER',
        pageTitle: 'Inbox (3) - asha@example.com', url: 'https://mail.google.com/mail/u/0/#inbox/abc'
      }),
      getPreferences: async () => ({ translateTarget: 'hi', tone: 'polite', name: null })
    });
    await qa.run({ kind: 'draft', tabId: 7 }, { onStart: (i) => starts.push(i), onDelta: () => {} });
    const sent = JSON.stringify(g.sent[0]);
    expect(sent).toContain('Can we meet on Friday?');
    for (const leak of ['PRIVATE BEFORE', 'PRIVATE AFTER', 'Inbox (3)', 'mail.google.com']) expect(sent).not.toContain(leak);
    expect(starts[0]).toMatchObject({ medium: 'email', privatePage: true, source: { url: '', pageTitle: '' } }); // medium guessed before the address was dropped
  });

  it('selection quick actions pass a NEEDS_ACK on to the panel', async () => {
    const qa = createQuickActions({
      gateway: gateway(), getLanguage: async () => 'en', getSelection: async () => ({ text: 'x' }),
      checkPage: async () => { throw new FeatureError('NEEDS_ACK', 'Only the text you selected…', { domain: 'mail.google.com' }); }
    });
    const err = await qa.run({ kind: 'translate', tabId: 7 }, io()).catch((e) => e);
    expect(err.toPayload()).toMatchObject({ code: 'NEEDS_ACK', domain: 'mail.google.com' });
  });

  it('YouTube: a blocked video link is refused before the model is asked', async () => {
    const g = gateway();
    const s = createSummaries({
      gateway: g, getPageText: async () => ({}), getTabUrl: async () => '', getVideoInfo: async () => null,
      getLanguage: async () => 'en', cache: { get: async () => undefined, set: async () => {} }, checkVideoUrl: blocked
    });
    expect(await codeOf(s.summarizeVideo({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }))).toBe('PAGE_BLOCKED');
    expect(g.sent).toEqual([]);
  });

  it('Find: a refusal sends nothing', async () => {
    const g = gateway();
    const find = createFind({
      gateway: g, getLanguage: async () => 'en', checkPage: blocked,
      pageScan: { observe: async () => ({ result: { snapshotId: 's', elements: [{ id: 1, name: 'Pay', role: 'button' }] }, map: '[1] button "Pay"' }), highlight: async () => ({ ok: true }) }
    });
    expect(await codeOf(find.find({ tabId: 7, query: 'pay' }, { windowId: 1 }))).toBe('PAGE_BLOCKED');
    expect(g.sent).toEqual([]);
  });

  it('skills: anything that uses the page is checked; a skill that doesn\'t need the page isn\'t', async () => {
    const [exam] = starterSkills(1);
    const haiku = { ...exam, id: 'h', prompt: 'Write a haiku about rain.', needs: [] };
    const checked = [];
    const g = gateway();
    const runner = createSkillRunner({
      gateway: g, getSkills: async () => [exam, haiku], getProfile: async () => ({}), getLanguage: async () => 'en',
      getTab: async () => ({ url: 'https://onlinesbi.sbi/', title: 'SBI' }), getPage: async () => ({ text: 'balance' }),
      getSelection: async () => ({ text: '' }), startAgent: async () => null,
      checkPage: async (tabId) => { checked.push(tabId); return blocked(); }
    });
    expect(await codeOf(runner.runAnswer({ skillId: exam.id, tabId: 7 }, io()))).toBe('PAGE_BLOCKED');
    expect(g.sent).toEqual([]);
    await runner.runAnswer({ skillId: 'h', tabId: 7 }, io());
    expect(checked).toEqual([7]);
    expect(JSON.stringify(g.sent)).not.toContain('SBI');
  });

  it('agent: a page-tier refusal at start explains itself (S1, EC-TIR-11)', async () => {
    const store = new Map();
    const runner = createAgentRunner({
      store: createAgentStore({ get: async (k) => store.get(k) ?? (k === 'agentTasks' ? {} : null), set: async (k, v) => { store.set(k, v); } }),
      getTabUrl: async () => 'https://hdfcbank.com/', getDefaults: async () => ({ maxSteps: 15, dryRun: false }),
      checkAllowed: async () => ({ allowed: false, reason: 'Sahayak is switched off on payment and banking pages to keep your money safe.', tier: true }),
      observe: async () => { throw new Error('must not observe'); }, think: async () => null, execute: async () => null,
      highlight: async () => {}, notify: () => {}
    });
    const err = await runner.start({ tabId: 7, goal: 'pay my bill' }, { windowId: 1 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'PAGE_BLOCKED', message: 'Sahayak is switched off on payment and banking pages to keep your money safe.' });
  });

  it('every feature\'s wiring uses the shared page guard', () => {
    const wiring = {
      'src/background/summaries.js': ["guard.assert(tabId, 'read')", "guard.assertUrl(url, 'read')"],
      'src/background/page-chat.js': ["guard.assert(tabId, 'read')"],
      'src/background/quick-actions.js': ["guard.assert(tabId, 'selection')"],
      'src/background/find.js': ["guard.assert(tabId, 'read')"],
      'src/background/skill-runner.js': ["guard.assert(tabId, 'read')"],
      'src/background/capture.js': ["guard.assert(tabId, 'screenshot')"],
      'src/background/agent/agent-controller.js': ["guard.assert(tabId, 'agent')", "guard.assertUrl(url, 'agent')"]
    };
    for (const [file, calls] of Object.entries(wiring)) {
      const src = readFileSync(file, 'utf8');
      for (const call of calls) expect(src, `${file} should call ${call}`).toContain(call);
    }
  });

  it('every model call goes through the gateway, which redacts (step 6)', () => {
    const gateway = readFileSync('src/background/llm/gateway.js', 'utf8');
    expect(gateway).toMatch(/async stream\(original\) \{\n\s+const req = await scrub\(original\);/);
    expect(gateway).toMatch(/async json\(original\) \{\n\s+const req = await scrub\(original\);/);
  });
});
