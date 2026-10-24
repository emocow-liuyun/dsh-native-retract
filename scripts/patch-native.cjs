#!/usr/bin/env node
/**
 * 给已安装的 DSH 原生客户端产物打撤回按钮补丁。
 *
 * 用法：
 *   node scripts/patch-native.cjs              # 从备份还原后再打补丁
 *   node scripts/patch-native.cjs --restore    # 只还原，不打补丁
 *   DSH_NODE_MODULES=/path/to/node_modules node scripts/patch-native.cjs
 *
 * 修改对象（安装包内编译后的 client.js，没有源码构建入口）：
 *   - dsh-client-ui-chat        消息操作栏加「撤回」按钮，用户消息节点接上撤回动作
 *   - dsh-client-ui-conversation 历史重放时隐藏被撤回区间的记录与 command 记录
 *
 * 首次修改前把原文件备份到 <repo>/backups/，重复执行不会叠加补丁。
 */
const fs = require('fs');
const path = require('path');

const base = process.env.DSH_NODE_MODULES
  || '/opt/DeepSeek Harness/resources/dsh/node_modules/@deepseek-ai';
const backups = path.join(__dirname, '..', 'backups');
const MARK = '/* native-retract-v1 */';

function targetPath(pkg) {
  return path.join(base, pkg, 'lib/client.js');
}

function backupPath(pkg) {
  return path.join(backups, pkg + '.client.js');
}

function read(pkg) {
  const file = targetPath(pkg);
  if (!fs.existsSync(file)) throw new Error('找不到客户端产物: ' + file);
  return fs.readFileSync(file, 'utf8');
}

function restore(pkg) {
  const saved = backupPath(pkg);
  if (!fs.existsSync(saved)) {
    console.log('[skip] 无备份，未改动: ' + pkg);
    return;
  }
  fs.writeFileSync(targetPath(pkg), fs.readFileSync(saved, 'utf8'));
  console.log('[restore] ' + pkg);
}

function sub(source, anchor, replacement) {
  if (!source.includes(anchor)) throw new Error('缺少锚点: ' + anchor.slice(0, 120));
  return source.replace(anchor, replacement);
}

function patchChat(source) {
  let s = source;
  s = sub(s, '"remote.session",', '"remote.session",\n "remote.commands",');

  s = sub(s,
    'function MessageIconActions({ text, time, clock, onBranch,',
    'function MessageIconActions({ text, time, clock, onRetract, retracting = false, onBranch,');

  s = sub(s, '\t\t\t\t\textraActions,', `\t\t\t\t\tonRetract && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
 label: retracting ? t("message.retracting") : t("message.retract"), side:"bottom",
 children:(0,react_jsx_runtime.jsx)("button", {type:"button", className:MessageIconActions_module_css_default.action, "aria-label":t("message.retract"), disabled:retracting, onClick:onRetract,
 children:(0,react_jsx_runtime.jsx)("svg",{viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.7,"aria-hidden":true,children:(0,react_jsx_runtime.jsx)("path",{d:"M9 4 3 10l6 6M3 10h11a7 7 0 0 1 0 14"})})})}),
\t\t\t\t\textraActions,`);

  s = sub(s,
    'function UserMessageNodeView({ node, renderFactorySlot, loadImage, t }) {',
    'function UserMessageNodeView({ node, renderFactorySlot, loadImage, t, sessionId, inputActions, retractMessage, useAccess }) {\n const [retracting,setRetracting]=(0,react.useState)(false);\n const allowed=useAccess("commands/execute");\n const onRetract=async()=>{if(retracting)return;setRetracting(true);try {const result=await retractMessage(sessionId,node.data.seq);inputActions.setDraft(result.text);inputActions.persistDraft();}catch(e){window.alert(t("message.retractFailed")+": "+e.message)}finally{setRetracting(false)}};');

  s = sub(s,
    'time: data.time,\n\t\t\t\t\tclock: "start",',
    'time: data.time,\n onRetract: allowed ? onRetract : undefined, retracting,\n\t\t\t\t\tclock: "start",');

  s = sub(s,
    'key: "user",\n\t\t\t\tlocale: NS',
    'key: "user",\n inject:()=>({retractMessage:async(sessionId,seq)=>{const r=await ctx.remote.commands.execute(sessionId,"/native-retract "+seq,[]);if(!r.ok)throw new Error(r.error.message);const result=r.value?.result;if(result?.kind!=="success")throw new Error(result?.text??"撤回失败");return JSON.parse(result.text)}}),\n\t\t\t\tlocale: NS');

  s = sub(s, 'const zh = {',
    'const zh = {\n "message.retract":"撤回", "message.retracting":"撤回中…", "message.retractFailed":"撤回失败",');
  s = sub(s, 'const en = {',
    'const en = {\n "message.retract":"Retract", "message.retracting":"Retracting…", "message.retractFailed":"Retract failed",');
  return s;
}

function patchConversation(source) {
  let s = source;
  s = sub(s, 'var ConversationNodeAssembler = class {', `function nativeRetractVisible(entries) {
 const cuts=entries.flatMap(r=>{const e=r.event;const m=e.type==="user/message"&&/^rewind-native:(\\d+):/.exec(e.data?.id??"");return m?[[Number(m[1]),e.seq]]:[]});
 const commands=new Set(entries.filter(r=>r.event.type==="command/run"&&r.event.data.name==="native-retract").map(r=>r.event.data.commandId));
 return entries.filter(r=>!commands.has(r.event.data?.commandId)&&!cuts.some(([from,to])=>r.event.seq>=from&&r.event.seq<to));
 }
 var ConversationNodeAssembler = class {`);

  s = sub(s,
    'const sorted = [...entries].sort((left, right) => left.event.seq - right.event.seq);',
    'const sorted = nativeRetractVisible([...entries]).sort((left, right) => left.event.seq - right.event.seq);');

  s = sub(s,
    'append(record) {\n\t\t\t\tconst event = record.event;',
    'append(record) {\n\t\t\t\tconst event = record.event;\n if(event.type==="command/done"&&event.data?.text?.startsWith("{\\"cut\\":"))return "none";\n if(event.type==="user/message"&&event.data?.id?.startsWith("rewind-native:"))return this.replaceWindow([...this.inputs.values(),record],this.hasMore);');

  s = sub(s,
    'const fresh = entries.filter((entry) => !this.inputs.has(entry.event.seq))',
    'const fresh = nativeRetractVisible([...this.inputs.values(),...entries]).filter((entry) => !this.inputs.has(entry.event.seq))');
  return s;
}

function apply(pkg, transform) {
  const current = read(pkg);
  if (current.startsWith(MARK)) {
    console.log('[skip] 已打过补丁: ' + pkg);
    return;
  }
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(backupPath(pkg), current);
  fs.writeFileSync(targetPath(pkg), MARK + '\n' + transform(current));
  console.log('[patch] ' + pkg + '  (备份: backups/' + pkg + '.client.js)');
}

const restoreOnly = process.argv.includes('--restore');

if (restoreOnly) {
  restore('dsh-client-ui-chat');
  restore('dsh-client-ui-conversation');
} else {
  restore('dsh-client-ui-chat');
  restore('dsh-client-ui-conversation');
  apply('dsh-client-ui-chat', patchChat);
  apply('dsh-client-ui-conversation', patchConversation);
  console.log('完成：重启或刷新 DSH 页面后生效。');
}
