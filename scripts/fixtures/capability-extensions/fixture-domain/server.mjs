if (process.env.NODE_ENV !== 'test') throw new Error('synthetic capability fixture requires test mode');

export function register(ctx) {
  let seq = 0;
  ctx.capabilities.add({ name: 'fixture-domain.read', area: 'access-alpha', kind: 'read', skill: 'fixture-guide',
    description: '读一项合成领域信息。详情仅按需展示。', properties: { text: { type: 'string' } }, required: ['text'],
    run: ({ principal }, { text }) => ({ text, principal, ...(text === 'large' ? { data: 'x'.repeat(350000) } : {}) }) });
  ctx.capabilities.add({ name: 'fixture-domain.propose', area: 'access-alpha', kind: 'decide', skill: 'fixture-guide',
    description: '提出一项合成决定。', properties: {}, propose: () => ({ id: 'p-' + ++seq, status: 'pending' }) });
}
