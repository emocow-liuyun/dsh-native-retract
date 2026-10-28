/** Native-retract browser plugin; no DSH installation files are modified. */
window.__ModuleLoader__.load({
  id: '@local/dsh-native-retract',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'native-retract';
    const COMMAND = 'native-retract';
    const CHECKPOINT = /^rewind-native:(\d+):[0-9a-f-]+$/;

    const zh = {
      copy: '复制', copied: '已复制', copyFailed: '复制失败', retract: '撤回',
      retracting: '撤回中…', failed: '撤回失败', dismiss: '关闭错误提示',
      draftChanged: '输入框在撤回期间已变化，原文已复制到剪贴板。',
      draftChangedCopyFailed: '输入框已变化，原文未复制；请从撤回历史重新复制。',
      'clock.md': '{m}月{d}日', 'clock.ymd': '{y}年{m}月{d}日',
    };
    const en = {
      copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed', retract: 'Retract',
      retracting: 'Retracting…', failed: 'Retract failed', dismiss: 'Dismiss error',
      draftChanged: 'The draft changed while retracting. The original message was copied to the clipboard.',
      draftChangedCopyFailed: 'The draft changed and copying the original message failed. Copy it from the retracted history.',
      'clock.md': '{m}/{d}', 'clock.ymd': '{y}-{m}-{d}',
    };

    const css = `
.native-retract-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:0}
.native-retract-actions{display:flex;align-items:center;gap:8px;height:calc(28px + var(--dsh-content-font-delta,0px));margin-left:-6px}
.native-retract-time{padding-right:12px;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap}
.native-retract-action{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.native-retract-action svg{display:block;width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.native-retract-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.native-retract-action:disabled{cursor:default;opacity:.4}
.native-retract-action:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
@media (hover:hover){
:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])) .native-retract-actions{opacity:0;transition:opacity 80ms ease}
:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):hover .native-retract-actions,
:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):focus-within .native-retract-actions{opacity:1}}
.native-retract-error{display:flex;align-items:center;gap:8px;max-width:100%;color:var(--dsw-alias-state-error-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;overflow-wrap:anywhere}
.native-retract-error button{flex:none;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;text-decoration:underline;cursor:pointer}
@media (prefers-reduced-motion:reduce){.native-retract-actions{transition:none!important}}
`;

    function icon(kind) {
      const paths = kind === 'copy'
        ? ['M9 9h10v12H9z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1']
        : kind === 'check' ? ['m5 12 4 4L19 6'] : ['M9 4 3 10l6 6', 'M3 10h11a7 7 0 0 1 0 14'];
      return h('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, ...paths.map(d => h('path', { key: d, d })));
    }

    function Action({ label, disabled = false, onClick, children }) {
      // The label is the tooltip; the action row follows the host's native aria pattern.
      return h('button', {
        type: 'button', className: 'native-retract-action', 'aria-label': label,
        title: label, disabled, onClick,
      }, children);
    }

    function contentParts(content) {
      const texts = [];
      const attachments = [];
      const rest = [];
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block?.type === 'image' && block.attachment !== undefined) {
          attachments.push({ type: 'image', image: { attachment: block.attachment } });
        } else if (block?.type === 'file' && block.attachment !== undefined) {
          attachments.push({ type: 'file', file: block.attachment });
        } else rest.push(block);
      }
      return { texts, attachments, rest };
    }

    function formatClock(time, t) {
      const date = new Date(time);
      const now = new Date();
      const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      if (date.toDateString() === now.toDateString()) return clock;
      const params = { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
      return `${t(date.getFullYear() === now.getFullYear() ? 'clock.md' : 'clock.ymd', params)} ${clock}`;
    }

    async function copyText(text) {
      if (!navigator.clipboard?.writeText) return false;
      try { await navigator.clipboard.writeText(text); return true; }
      catch { return false; }
    }

    function UserMessageNodeView(props) {
      const { node } = props;
      const data = node.data;
      const { sessionId, useInput, inputActions, retractMessage, t } = props;
      const [pending, setPending] = React.useState(false);
      const [copied, setCopied] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const epoch = React.useRef(0);
      const copyTimer = React.useRef(null);
      const copyPending = React.useRef(false);
      const mounted = React.useRef(true);
      const currentDraft = React.useRef(null);
      const draft = useInput(s => s.draft);
      const draftRev = useInput(s => s.draftRev);
      // Keep the latest framework snapshot available to the asynchronous click handler.
      currentDraft.current = { draft, draftRev };
      const parts = React.useMemo(() => contentParts(data.content), [data.content]);
      const text = React.useMemo(() => parts.texts.join(''), [parts]);
      const content = React.useMemo(() => ({
        text, attachments: parts.attachments, extraBlocks: parts.rest,
        ...(data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
      }), [text, parts, data.referenceLabels]);
      const facts = React.useMemo(() => ({
        ...(data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }),
        ...(data.skillNames === undefined ? {} : { skillNames: data.skillNames }),
      }), [data.referenceLabels, data.skillNames]);
      React.useEffect(() => () => {
        mounted.current = false;
        epoch.current += 1;
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      }, []);

      const onCopy = () => {
        if (copyPending.current) return;
        const id = epoch.current;
        copyPending.current = true;
        copyText(text).then((ok) => {
          copyPending.current = false;
          if (!mounted.current || id !== epoch.current) return;
          if (!ok) { setFailure('copy-failed'); return; }
          setFailure(null);
          setCopied(true);
          copyTimer.current = setTimeout(() => setCopied(false), 1000);
        }, () => { copyPending.current = false; });
      };

      const onRetract = async () => {
        if (pending) return;
        const id = ++epoch.current;
        const baselineDraft = currentDraft.current;
        setPending(true);
        setFailure(null);
        try {
          const result = await retractMessage(sessionId, data.seq);
          // The Host already replaced the surface: restore the draft even when
          // this node unmounted, otherwise the message silently disappears.
          const live = mounted.current && id === epoch.current;
          const latestDraft = currentDraft.current;
          if (latestDraft.draftRev !== baselineDraft.draftRev || latestDraft.draft !== baselineDraft.draft) {
            const copiedToClipboard = await copyText(result.text);
            if (!live) return;
            if (!copiedToClipboard) {
              setFailure('draft-changed-copy-failed');
              return;
            }
            setFailure('draft-changed');
            return;
          }
          inputActions.setDraft(result.text);
          inputActions.persistDraft();
        } catch (error) {
          if (mounted.current && id === epoch.current) setFailure(error?.message || String(error));
        } finally {
          if (mounted.current && id === epoch.current) setPending(false);
        }
      };

      const errorText = failure === 'draft-changed' ? t('draftChanged')
        : failure === 'draft-changed-copy-failed' ? t('draftChangedCopyFailed')
          : failure === 'copy-failed' ? t('copyFailed') : failure;
      return h('div', {
        className: 'native-retract-row',
        'data-chat-steering-batch': node.kind === 'steering' && data.batchStart === true ? 'start' : undefined,
      },
        props.renderFactorySlot('conversation.chat.user.content', { content, loadImage: props.loadImage, facts, interactive: true }),
        h('div', { className: 'native-retract-actions' },
          h('span', { className: 'native-retract-time' }, formatClock(data.time, t)),
          h(Action, { label: copied ? t('copied') : t('copy'), onClick: onCopy }, icon(copied ? 'check' : 'copy')),
          h(Action, {
            label: pending ? t('retracting') : t('retract'), disabled: pending, onClick: onRetract,
          }, icon('retract'))),
        failure === null ? null : h('div', { className: 'native-retract-error', role: 'status' },
          failure === 'draft-changed' ? errorText : `${t('failed')}: ${errorText}`,
          h('button', { type: 'button', 'aria-label': t('dismiss'), onClick: () => setFailure(null) }, '×')),
      );
    }

    /** A replacement event is a checkpoint, not a context/user bubble. */
    const checkpointDefinition = {
      kind: 'native-retract-checkpoint', target: 'chat',
      match: (event) => {
        if (event.type !== 'user/message' || event.surfaceOp?.op !== 'replace') return null;
        if (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0) return null;
        if (!CHECKPOINT.test(event.data?.id ?? '')) return null;
        return { id: event.data.id, role: 'start', exclusive: true };
      },
      start: (_context, match) => ({ seq: match.event.seq, time: match.event.time }),
      update: (context) => context.state,
      buildViewNode: (context) => context.state === undefined ? null : {
        key: context.key, kind: 'unknown', id: context.id, target: 'chat',
        anchorSeq: context.state.seq, location: context.start?.location ?? { kind: 'unresolved' },
        visibility: 'hidden', data: { kind: 'unknown', seq: context.state.seq, time: context.state.time, type: 'native-retract', data: {} },
      },
    };

    /**
     * The retract action runs an internal /native-retract command. Its JSON
     * result is an implementation detail, so this definition claims that exact
     * command lifecycle and builds a hidden node instead of a command card.
     */
    const commandDefinition = {
      kind: 'native-retract-command', target: 'chat',
      match: (event) => {
        if (event.type === 'command/run') {
          if (event.data?.name !== COMMAND) return null;
          return { id: String(event.data.commandId), role: 'start', exclusive: true };
        }
        if (event.type !== 'command/done') return null;
        let parsed;
        try { parsed = JSON.parse(event.data?.text ?? ''); } catch { return null; }
        if (parsed === null || typeof parsed !== 'object'
          || !Number.isSafeInteger(parsed.cut) || !Number.isSafeInteger(parsed.checkpointSeq)) return null;
        return { id: String(event.data.commandId), role: 'update', exclusive: true };
      },
      start: (_context, match) => ({ seq: match.event.seq }),
      update: (context) => context.state,
      buildViewNode: (context) => context.state === undefined ? null : {
        key: context.key, kind: 'unknown', id: context.id, target: 'chat',
        anchorSeq: context.state.seq, location: context.start?.location ?? { kind: 'unresolved' },
        visibility: 'hidden', data: { kind: 'unknown', seq: context.state.seq, time: context.state.time, type: 'native-retract-command', data: {} },
      },
    };

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'native-retract: locale');
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = '@local/dsh-native-retract';
        style.textContent = css;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'native-retract: styles');
      ctx.effect(() => ctx.uiConversation.events.register(checkpointDefinition), 'native-retract: checkpoint');
      ctx.effect(() => ctx.uiConversation.events.register(commandDefinition), 'native-retract: command');
      for (const key of ['user', 'steering']) {
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node', key, priority: -1, locale: NS,
          inject: (sessionId) => ({
            retractMessage: async (id, seq) => {
              if (id !== sessionId) throw new Error('stale-session');
              const carried = await ctx.remote.commands.execute(id, `/${COMMAND} ${seq}`, []);
              if (!carried?.ok) throw new Error(carried?.error?.message ?? 'command-failed');
              const result = carried.value?.result;
              if (result?.kind !== 'success') throw new Error(result?.text ?? 'retract-failed');
              return JSON.parse(result.text);
            },
          }),
        }, UserMessageNodeView));
      }
    }

    return { inject: ['slots', 'uiConversation', 'remote', 'remote.commands', 'locale'], apply };
  },
});
