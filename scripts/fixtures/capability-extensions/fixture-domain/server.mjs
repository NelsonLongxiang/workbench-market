if (process.env.NODE_ENV !== 'test') throw new Error('synthetic capability fixture requires test mode');

export function register(ctx) {
  let seq = 0;
  let reads = 0;
  ctx.capabilities.add({ name: 'fixture-domain.read', area: 'access-alpha', kind: 'read', skill: 'fixture-guide',
    description: '读一项合成领域信息。详情仅按需展示。',
    properties: { text: { type: 'string' }, count: { type: 'integer' }, enabled: { type: 'boolean' } }, required: ['text'],
    run: ({ principal }, { text, count, enabled }) => {
      if (text === 'calls') return { calls: reads };
      reads++;
      return { text, principal, ...(count === undefined ? {} : { count }), ...(enabled === undefined ? {} : { enabled }),
        ...(text === 'large' ? { data: 'x'.repeat(350000) } : {}) };
    } });
  ctx.capabilities.add({ name: 'fixture-domain.propose', area: 'access-alpha', kind: 'decide', skill: 'fixture-guide',
    description: '提出一项合成决定。', properties: { outcome: { type: 'string' } },
    propose: (_caller, { outcome }) => ({ id: 'p-' + ++seq, status: outcome === 'done' ? 'done' : 'pending',
      ...(outcome === 'extra' ? { fixture_internal: 'must-not-be-returned' } : {}) }) });
}
