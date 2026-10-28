import { randomUUID } from 'node:crypto';

export const COMMAND_NAME = 'native-retract';
export const inject = ['commands', 'sessions'];

const retractTails = new WeakMap();

/**
 * Serialize retractions for one live Agent. The operation revalidates its
 * target after acquiring this queue, so a double click becomes a stable stale
 * message result instead of overlapping cancellation/maintenance.
 */
export function retract(ctx, agent, seq) {
  const previous = retractTails.get(agent) ?? Promise.resolve();
  const operation = previous.then(() => retractExclusive(ctx, agent, seq));
  retractTails.set(agent, operation.catch(() => {}));
  return operation;
}

/** Replace the active model-facing surface from one user message to its end.
 * The original events remain in the durable log for history, replay, and audit.
 *
 * @param ctx - Host context with the session persistence service.
 * @param agent - Session whose active surface is retracted.
 * @param seq - Exact event sequence of an append-surface human message.
 * @returns replacement coordinates and the text to restore into the composer.
 */
async function retractExclusive(ctx, agent, seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('请选择已发送的用户消息');
  const target = agent.session.eventAt(seq);
  if (target?.type !== 'user/message'
    || target.surfaceOp !== 'append'
    || target.data.source?.kind !== 'user') {
    throw new Error('请选择已发送的用户消息');
  }
  if (!agent.session.surface.nodes.includes(seq)) {
    throw new Error('这条消息已撤回或已被上下文压缩');
  }

  // DSH cancellation clears the pending queue by default, matching the
  // existing plugin behavior and preventing queued work beyond the boundary.
  agent.cancel({ kind: 'user' });
  await agent.whenIdle();

  return agent.runMaintenance(async (signal) => {
    if (signal?.aborted) throw new Error('撤回已取消');
    const session = agent.session;
    const nodes = session.surface.nodes.filter(node => node >= seq);
    if (nodes.length === 0 || nodes[0] !== seq) {
      throw new Error('消息状态已更新，请刷新后重试');
    }
    const checkpoint = session.append('user/message', {
      id: `rewind-native:${seq}:${randomUUID()}`,
      role: 'user',
      source: { kind: 'user' },
      content: [],
    }, {
      surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes.at(-1) },
      sourceEventSeqs: nodes,
    });
    await ctx.sessions.flush(session);
    // A retracted message may be image-only. The browser cannot rebuild a
    // composer attachment from a durable reference, so report the attachment
    // count and let the composer surface it instead of returning silently.
    const attachments = target.data.content
      .filter(block => (block.type === 'image' || block.type === 'file') && block.attachment !== undefined)
      .map(block => ({
        type: block.type,
        attachmentId: block.attachment?.attachmentId,
        name: block.attachment?.name,
      }))
      .filter(entry => typeof entry.attachmentId === 'string');
    return {
      cut: seq,
      checkpointSeq: checkpoint.seq,
      text: target.data.content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join(''),
      attachments,
    };
  });
}

export function apply(ctx) {
  ctx.effect(() => {
    const modules = ctx.get('clientModules');
    if (modules === undefined) return;
    modules.rebuilt('@local/dsh-native-retract');
  }, 'native-retract: client bundle revision');
  ctx.effect(() => ctx.commands.register({
    name: COMMAND_NAME,
    description: '撤回所选用户消息及后续对话，保留原始日志，不回滚文件。',
    input: { hint: '消息事件序号' },
    handler: async ({ agent, rawInput }) => {
      try {
        const result = await retract(ctx, agent, Number(rawInput.trim()));
        return { kind: 'success', text: JSON.stringify(result) };
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    },
  }), 'native-retract: command');
}
