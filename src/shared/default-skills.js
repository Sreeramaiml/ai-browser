// @ts-check
// The four starter skills (architecture §13.2), installed once on first run and editable like any
// other. Deleting one is final: they are never seeded again (EC-SKL-06).

/** @type {ReadonlyArray<Omit<import('./schemas.js').Skill, 'createdAt'|'updatedAt'>>} */
export const STARTER_SKILLS = Object.freeze([
  {
    id: 'starter-exam-notes',
    name: 'Exam notes',
    icon: '📝',
    mode: 'answer',
    prompt: 'Turn this page into revision notes for an exam:\n' +
      '1. Key definitions\n2. Key formulas, dates or facts\n3. Five likely exam questions, each with a short answer\n' +
      'Use headings and bullet points.\n\n{{page}}',
    needs: ['page'],
    language: 'inherit'
  },
  {
    id: 'starter-explain-hinglish',
    name: 'Explain in Hinglish',
    icon: '🗣️',
    mode: 'answer',
    prompt: 'Explain this simply, the way a friend would, with one everyday example:\n\n{{selection}}',
    needs: ['selection'],
    language: 'hinglish'
  },
  {
    id: 'starter-polite-reply',
    name: 'Reply to this email politely',
    icon: '✉️',
    mode: 'answer',
    prompt: 'Draft a polite reply to this email. Write as me, in the first person, and use [placeholders] for ' +
      'details only I know. Sign it as {{profile.name}} (if no name is given here, sign it as [Your name]).\n\n{{selection}}',
    needs: ['selection', 'profile'],
    language: 'inherit'
  },
  {
    id: 'starter-fill-form',
    name: 'Fill this form from my profile',
    icon: '🧾',
    mode: 'agent',
    prompt: 'Fill every field on this form that matches my profile. Do not submit.',
    needs: ['profile'],
    language: 'inherit'
  }
]);

/**
 * Fresh copies of the starter skills, stamped with `now`.
 * @param {number} now
 * @returns {import('./schemas.js').Skill[]}
 */
export function starterSkills(now) {
  return STARTER_SKILLS.map((s) => ({ ...s, needs: [...s.needs], createdAt: now, updatedAt: now }));
}
