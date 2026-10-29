// The A/B tests a release starts with. Added once; after that the owner's
// dashboard (and the optimizer) change them, so editing this list later does
// not reset a running test. Event names: see docs/OPTIMIZATION.md.
export const EXPERIMENTS = [
  {
    key: 'premium_pitch',
    description: 'How Premium is offered under your initials: about safety (backups) or about the family.',
    variants: [
      { key: 'backups', weight: 50 }, // "Never lose a note: daily backups, kept 30 days"
      { key: 'family', weight: 50 }, // "Your family's lists, safe every day"
    ],
    metric: 'upgrade_click',
    guardrails: ['note_created'],
    auto: true,
    minSubjects: 200,
  },
];
