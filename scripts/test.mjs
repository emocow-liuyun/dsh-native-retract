import assert from 'node:assert/strict';

const DSH_ROOT = process.env.DSH_ROOT || '/opt/DeepSeek Harness/resources/dsh';
const DSH_PKG = name => `${DSH_ROOT}/node_modules/@deepseek-ai/${name}`;
const { Session } = await import(DSH_PKG('dsh-session/lib/index.js'));
const { retract } = await import('../index.js');

function fixture() {
  const session = Session.create('session-native-retract-test');
  const user = (text, source = { kind: 'user' }) => session.append('user/message', {
    id: `m-${session.seq}`, role: 'user', source,
    content: [{ type: 'text', text }],
  }, { surfaceOp: 'append' });
  session.append('turn/start', { turn: 1 });
  const first = user('keep');
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  session.append('turn/start', { turn: 2 });
  const second = user('restore me\nwith two lines');
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  session.append('turn/start', { turn: 3 });
  const later = user('later');
  session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
  let cancelled = 0;
  let flushed = 0;
  const agent = {
    session,
    cancel(cause, options) { cancelled++; assert.equal(cause.kind, 'user'); assert.equal(options, undefined); },
    async whenIdle() {},
    async runMaintenance(task) { return task(new AbortController().signal); },
  };
  return {
    session, first, second, later, user, agent,
    ctx: { sessions: { async flush(target) { assert.equal(target, session); flushed++; } } },
    stats: () => ({ cancelled, flushed }),
  };
}

// Surface boundaries, model history, original log, exact draft text, and repeat operations.
{
  const { session, first, second, agent, ctx, stats } = fixture();
  const result = await retract(ctx, agent, second.seq);
  assert.deepEqual(stats(), { cancelled: 1, flushed: 1 });
  assert.equal(result.cut, second.seq);
  assert.equal(result.checkpointSeq, session.seq - 1);
  assert.equal(result.text, 'restore me\nwith two lines');
  assert.deepEqual(session.surface.nodes.filter(n => n >= second.seq), [result.checkpointSeq]);
  assert(session.surface.nodes.includes(first.seq));
  assert(!session.deriveMessages().some(m => m.content.some(b => b.text === 'later')));
  assert(session.snapshotEvents().some(e => e.seq === second.seq));
  await assert.rejects(() => retract(ctx, agent, second.seq), /已撤回/);
  const after = session.append('user/message', {
    id: 'after', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'new path' }],
  }, { surfaceOp: 'append' });
  assert(session.deriveMessages().some(m => m.id === after.data.id));
  // A different surviving user message may be retracted in a later operation.
  const secondResult = await retract(ctx, agent, first.seq);
  assert.equal(secondResult.cut, first.seq);
  assert.equal(secondResult.text, 'keep');
  assert.deepEqual(session.surface.nodes, [secondResult.checkpointSeq]);
  assert.deepEqual(stats(), { cancelled: 2, flushed: 2 });
}

// Invalid coordinates, replacement events, non-human messages and busy state.
{
  const { session, agent, ctx } = fixture();
  const first = session.surface.nodes[0];
  for (const value of [NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 99999]) {
    await assert.rejects(() => retract(ctx, agent, value), /请选择已发送的用户消息/);
  }
  const replacement = session.snapshotEvents().at(-1);
  await assert.rejects(() => retract(ctx, agent, replacement.seq), /请选择已发送的用户消息/);
  const injected = session.append('user/message', {
    id: 'injected', role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'context' }],
  }, { surfaceOp: 'append' });
  await assert.rejects(() => retract(ctx, agent, injected.seq), /请选择已发送的用户消息/);
  assert(first !== undefined);
}

// Concurrent operations serialize; only the first one commits against this prefix.
{
  const { session, second, agent, ctx, stats } = fixture();
  const results = await Promise.allSettled([
    retract(ctx, agent, second.seq),
    retract(ctx, agent, second.seq),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(stats(), { cancelled: 1, flushed: 1 });
}

// Cancel before maintenance, wait for idle, and do not swallow cancellation.
{
  const { session, second, ctx } = fixture();
  const calls = [];
  const agent = {
    session,
    cancel() { calls.push('cancel'); },
    async whenIdle() { calls.push('idle'); },
    async runMaintenance(task) { calls.push('maintenance'); return task(AbortSignal.abort()); },
  };
  await assert.rejects(() => retract(ctx, agent, second.seq), /撤回已取消/);
  assert.deepEqual(calls, ['cancel', 'idle', 'maintenance']);
}

// Browser bundle: official Factory content, native Slot override, hidden-only
// checkpoint/command definitions, and no DSH feature-module imports.
{
  let definition;
  globalThis.window = {
    __ModuleLoader__: { load(value) { definition = value; } },
  };
  await import('../client.js');
  assert.equal(definition.id, '@local/dsh-native-retract');
  const module = definition.factory(require => {
    assert.equal(require, 'react');
    return { createElement: (type, props, ...children) => ({ type, props, children }) };
  });
  assert.deepEqual(module.inject, ['slots', 'uiConversation', 'remote', 'remote.commands', 'locale']);

  const effects = [];
  const definitions = [];
  const injected = [];
  const ctx = {
    locale: { register: () => () => {} },
    uiConversation: { events: { register(value) { definitions.push(value); return () => {}; } } },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'conversation.chat.node');
        callback();
      },
      register(options, component) { injected.push({ options, component }); return () => {}; },
    },
    remote: { commands: {} },
    effect(callback) { effects.push(callback); return () => {}; },
  };
  globalThis.document = {
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
  };
  module.apply(ctx);
  for (const effect of effects) effect();

  assert.equal(injected.length, 2);
  assert.equal(injected[0].options.key, 'user');
  assert.equal(injected[0].options.priority, -1);
  assert.equal(injected[1].options.key, 'steering');
  assert.equal(injected[1].options.priority, -1);
  assert.equal(definitions.length, 2);
  for (const definition of definitions) {
    const match = definition.match;
    assert.equal(definition.target, 'chat');
    assert.equal(typeof definition.start, 'function');
    assert.equal(typeof definition.buildViewNode, 'function');
  }
  const [checkpoint] = definitions;
  const event = {
    type: 'user/message', seq: 9, time: 1000,
    data: { id: 'rewind-native:4:550e8400-e29b-41d4-a716-446655440000' },
    surfaceOp: { op: 'replace', startSeq: 4, endSeq: 8 },
    sourceEventSeqs: [4, 6, 8],
  };
  assert.equal(checkpoint.match(event).exclusive, true);
  assert.equal(checkpoint.match({ ...event, sourceEventSeqs: undefined }), null);
  assert.equal(checkpoint.match({ ...event, data: { id: 'rewind-native:4:550e8400-e29b-41d4-a716-446655440000' }, surfaceOp: undefined }), null);
  assert.equal(checkpoint.match({ ...event, sourceEventSeqs: undefined }), null);
  assert.equal(checkpoint.match({ ...event, surfaceOp: 'append' }), null);
  assert.equal(checkpoint.match({ ...event, data: { id: 'ordinary' } }), null);
  const start = checkpoint.start({}, { event });
  const hidden = checkpoint.buildViewNode({ key: 'key', id: 'id', state: start, start: { location: { kind: 'unresolved' } } });
  assert.equal(hidden.visibility, 'hidden');
  assert.equal(hidden.anchorSeq, 9);
  assert.equal(hidden.data.time, event.time);
  const [checkpointOnly, retractCommand] = definitions;
  assert.equal(retractCommand.kind, 'native-retract-command');
  assert.equal(retractCommand.target, 'chat');
  assert.equal(retractCommand.match({ type: 'command/run', data: { name: 'other', commandId: 'c1' } }), null);
  assert.equal(retractCommand.match({ type: 'command/done', data: { commandId: 'c1', text: 'plain error' } }), null);
  assert.equal(retractCommand.match({ type: 'command/done', data: { commandId: 'c1', text: '{"nativeRetract":false}' } }), null);
  assert.equal(retractCommand.match({ type: 'command/done', data: { commandId: 'c1', text: '{"cut":3,"checkpointSeq":9,"text":"x"}' } }).exclusive, true);
  assert.equal(retractCommand.match({ type: 'command/run', data: { name: 'native-retract', commandId: 'c1' } }).exclusive, true);
  const commandState = retractCommand.start({}, { event: { seq: 7, type: 'command/run', data: { name: 'native-retract', commandId: 'c1' } } });
  const commandHidden = retractCommand.buildViewNode({
    key: 'k', id: 'c1', state: commandState, start: { location: { kind: 'unresolved' } },
  });
  assert.equal(commandHidden.visibility, 'hidden');
  assert.equal(checkpointOnly.kind, 'native-retract-checkpoint');

  const retractMessage = injected[0].options.inject('session-1').retractMessage;
  const calls = [];
  ctx.remote.commands.execute = async (...args) => {
    calls.push(args);
    return { ok: true, value: { result: { kind: 'success', text: '{"text":"original"}' } } };
  };
  assert.deepEqual(await retractMessage('session-1', 3), { text: 'original' });
  assert.deepEqual(calls, [['session-1', '/native-retract 3', []]]);
  await assert.rejects(() => retractMessage('other-session', 3), /stale-session/);
  ctx.remote.commands.execute = async () => ({ ok: true, value: { result: { kind: 'error', text: 'busy' } } });
  await assert.rejects(() => retractMessage('session-1', 3), /busy/);
  ctx.remote.commands.execute = async () => ({ ok: false, error: { message: 'offline' } });
  await assert.rejects(() => retractMessage('session-1', 3), /offline/);
}

console.log('PASS: surface/model history, original log, exact draft text, cancellation, repeated retract, native Slot/Factory, hidden replay, command results');

// Adapter range contract: hide [startSeq, checkpointSeq - 1] so log-only tail
// events (turn/end, turn/start) cannot survive the retract, and keep the
// checkpoint plus everything after it.
{
  const entries = [
    { event: { seq: 2, type: 'user/message', data: { id: 'keep' }, surfaceOp: 'append' } },
    { event: { seq: 4, type: 'assistant/message', data: {} } },
    { event: { seq: 6, type: 'tool/result', data: {} } },
    { event: { seq: 7, type: 'user/message', data: { id: 'later' }, surfaceOp: 'append' } },
    { event: { seq: 8, type: 'turn/end', data: { turn: 1 } } },
    { event: { seq: 9, type: 'user/message', data: { id: 'rewind-native:4:550e8400-e29b-41d4-a716-446655440000' }, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 7 }, sourceEventSeqs: [4, 6, 7] } },
    { event: { seq: 10, type: 'user/message', data: { id: 'after' }, surfaceOp: 'append' } },
  ];
  const checkpoint = entries[5].event;
  const start = checkpoint.surfaceOp.startSeq;
  const end = checkpoint.seq - 1;
  const visible = entries.filter(row => row.event.seq < start || row.event.seq > end);
  assert.deepEqual(visible.map(row => row.event.seq), [2, 9, 10]);
  assert.deepEqual(
    entries.filter(row => row.event.seq >= start && row.event.seq <= end).map(row => row.event.seq),
    [4, 6, 7, 8],
    'turn/end at 8 is inside the hidden range, not left dangling',
  );
}
