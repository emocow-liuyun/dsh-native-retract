#!/usr/bin/env node
/**
 * Remove only the v1 native-retract artifact injections. Unlike restoring a
 * whole-file backup, this preserves unrelated later edits in those bundles.
 * Always run with the same OS account used for the legacy patch installation.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.DSH_NODE_MODULES || '/opt/DeepSeek Harness/resources/dsh/node_modules/@deepseek-ai';
const BACKUP = path.join(__dirname, '..', '.migration-backup');
const packages = ['dsh-client-ui-chat', 'dsh-client-ui-conversation'];
const dryRun = process.argv.includes('--dry-run');

function sub(source, anchor, replacement) {
  if (!source.includes(anchor)) throw new Error(`Missing legacy anchor: ${anchor.slice(0, 100)}`);
  return source.replace(anchor, replacement);
}

function chat(source) {
  let s = sub(source, '/* native-retract-v1 */\n', '');
  s = sub(s, ' "remote.commands",\n', '');
  s = sub(s,
    'function MessageIconActions({ text, time, clock, onRetract, retracting = false, onBranch,',
    'function MessageIconActions({ text, time, clock, onBranch,');
  const button = s.indexOf('\t\t\t\t\tonRetract && ');
  const extra = s.indexOf('\t\t\t\t\textraActions,', button);
  if (button < 0 || extra < 0) throw new Error('Missing legacy retract button');
  s = s.slice(0, button) + s.slice(extra);
  const state = s.indexOf(' const [retracting,setRetracting]=');
  const data = s.indexOf('\n\t\t\tconst data = node.data;', state);
  if (state < 0 || data < 0) throw new Error('Missing legacy retract state');
  s = s.slice(0, state) + s.slice(data);
  s = sub(s,
    'function UserMessageNodeView({ node, renderFactorySlot, loadImage, t, sessionId, inputActions, retractMessage, useAccess }) {',
    'function UserMessageNodeView({ node, renderFactorySlot, loadImage, t }) {');
  s = sub(s, ' onRetract: allowed ? onRetract : undefined, retracting,\n', '');
  s = sub(s, ' inject:()=>({retractMessage:async(sessionId,seq)=>{const r=await ctx.remote.commands.execute(sessionId,"/native-retract "+seq,[]);if(!r.ok)throw new Error(r.error.message);const result=r.value?.result;if(result?.kind!=="success")throw new Error(result?.text??"撤回失败");return JSON.parse(result.text)}}),\n', '');
  s = sub(s, ' "message.retract":"撤回", "message.retracting":"撤回中…", "message.retractFailed":"撤回失败",\n', '');
  s = sub(s, ' "message.retract":"Retract", "message.retracting":"Retracting…", "message.retractFailed":"Retract failed",\n', '');
  return s;
}

function conversation(source) {
  let s = sub(source, '/* native-retract-v1 */\n', '');
  const filter = s.indexOf('function nativeRetractVisible(entries) {');
  const assembler = s.indexOf('var ConversationNodeAssembler = class {', filter);
  if (filter < 0 || assembler < 0) throw new Error('Missing legacy history filter');
  s = s.slice(0, filter) + s.slice(assembler);
  s = sub(s,
    'const sorted = nativeRetractVisible([...entries]).sort((left, right) => left.event.seq - right.event.seq);',
    'const sorted = [...entries].sort((left, right) => left.event.seq - right.event.seq);');
  s = sub(s,
    'const fresh = nativeRetractVisible([...this.inputs.values(),...entries]).filter((entry) => !this.inputs.has(entry.event.seq))',
    'const fresh = entries.filter((entry) => !this.inputs.has(entry.event.seq))');
  const done = s.indexOf('if(event.type==="command/done"');
  const next = s.indexOf('if (this.inputs.has(event.seq)) return "none";', done);
  if (done < 0 || next < 0) throw new Error('Missing legacy command filter');
  s = s.slice(0, done) + s.slice(next);
  return s;
}

fs.mkdirSync(BACKUP, { recursive: true });
const changes = [];
for (const pkg of packages) {
  const file = path.join(ROOT, pkg, 'lib', 'client.js');
  const original = fs.readFileSync(file, 'utf8');
  const transformed = pkg === 'dsh-client-ui-chat' ? chat(original) : conversation(original);
  if (/native-retract|nativeRetractVisible/.test(transformed)) throw new Error(`Retract marker remains in ${pkg}`);
  changes.push({ file, original, transformed });
}

for (const { file, original, transformed } of changes) {
  if (!dryRun) {
    fs.copyFileSync(file, path.join(BACKUP, `${path.basename(path.dirname(path.dirname(file)))}.client.js`));
    fs.writeFileSync(file, transformed);
  }
  console.log(`${dryRun ? '[dry-run]' : '[migrated]'} ${file}: ${original.length} → ${transformed.length} chars`);
}
console.log('Only legacy retract injections were removed; other artifact edits were preserved.');
