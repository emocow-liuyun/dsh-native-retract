#!/usr/bin/env node
/** Add or remove the narrow Session-surface transcript adapter. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.DSH_NODE_MODULES || '/opt/DeepSeek Harness/resources/dsh/node_modules/@deepseek-ai';
const PACKAGE = 'dsh-client-ui-conversation';
const MARK = '/* dsh-native-retract-adapter-v2 */\n';
const BACKUP = path.join(__dirname, '..', 'backups', `${PACKAGE}.adapter.json`);
const file = path.join(ROOT, PACKAGE, 'lib', 'client.js');
const dryRun = process.argv.includes('--dry-run');
const restoreOnly = process.argv.includes('--restore');

function fail(message) {
  console.error(`[native-retract] ${message}`);
  process.exitCode = 1;
}

function replaceOnce(source, anchor, replacement, name) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`${name}: expected exactly one anchor`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

function adapter(source) {
  if (source.startsWith(MARK)) return source;
  const classAnchor = 'var ConversationNodeAssembler = class {';
  const helper = `function dshNativeRetractRanges(entries) {
 const ranges=entries.flatMap(row=>{const event=row.event;const op=event.surfaceOp;if(event.type!=="user/message"||typeof op!=="object"||op?.op!=="replace"||!Array.isArray(event.sourceEventSeqs)||event.sourceEventSeqs.length===0||!/^rewind-native:[0-9]+:[0-9a-f-]+$/i.test(event.data?.id??""))return [];return [{start:op.startSeq,end:event.seq-1}];});
 return entries.filter(row=>!ranges.some(range=>row.event.seq>=range.start&&row.event.seq<=range.end));
}
`;
  let output = replaceOnce(source, classAnchor, helper + classAnchor, 'assembler');
  output = replaceOnce(output,
    'const sorted = [...entries].sort((left, right) => left.event.seq - right.event.seq);',
    'const sorted = dshNativeRetractRanges([...entries]).sort((left, right) => left.event.seq - right.event.seq);',
    'replaceWindow');

  const rc2 = 'const fresh = entries.filter((entry) => !this.inputs.has(entry.event.seq)).sort((left, right) => left.event.seq - right.event.seq);';
  const rc3 = 'const fresh = entries\n\t\t\t\t.filter(entry => !this.inputs.has(entry.event.seq))\n\t\t\t\t.sort((left, right) => left.event.seq - right.event.seq);';
  if (output.includes(rc2)) {
    output = replaceOnce(output, rc2,
      'const fresh = dshNativeRetractRanges([...this.inputs.values(), ...entries]).filter((entry) => !this.inputs.has(entry.event.seq)).sort((left, right) => left.event.seq - right.event.seq);',
      'prepend-rc2');
  } else if (output.includes(rc3)) {
    output = replaceOnce(output, rc3,
      'const fresh = dshNativeRetractRanges([...this.inputs.values(), ...entries])\n\t\t\t\t.filter(entry => !this.inputs.has(entry.event.seq))\n\t\t\t\t.sort((left, right) => left.event.seq - right.event.seq);',
      'prepend-rc3');
  } else {
    throw new Error('prepend anchor not found; no files written (unsupported DSH fork build)');
  }
  const append = 'append(record) {\n\t\t\t\tconst event = record.event;';
  const live = `${append}\n\t\t\t\tif (event.type === "user/message" && event.surfaceOp !== "append" && /^rewind-native:[0-9]+:[0-9a-f-]+$/i.test(event.data?.id ?? "")) return this.replaceWindow([...this.inputs.values(), record], this.hasMore);`;
  output = replaceOnce(output, append, live, 'live-checkpoint');
  return MARK + output;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function main() {
  if (!fs.existsSync(file)) throw new Error(`Conversation artifact not found: ${file}`);
  const current = fs.readFileSync(file, 'utf8');
  if (restoreOnly) {
    if (!current.startsWith(MARK)) {
      console.log('[native-retract] adapter marker not present; left file unchanged');
      return;
    }
    if (!fs.existsSync(BACKUP)) throw new Error(`Adapter backup missing: ${BACKUP}`);
    const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, PACKAGE, 'package.json'), 'utf8'));
    if (pkg.version !== backup.version) throw new Error(`DSH version changed (${backup.version} → ${pkg.version}); refusing to restore a stale whole-file backup`);
    const bytes = fs.readFileSync(backup.file);
    if (sha256(bytes) !== backup.sha256) throw new Error(`Adapter backup checksum mismatch: ${backup.file}`);
    fs.writeFileSync(file, bytes);
    console.log(`[native-retract] restored ${file}`);
    return;
  }
  const output = adapter(current);
  if (dryRun) {
    console.log(`[native-retract] ${file}: ${current.length} → ${output.length} characters; no files written`);
    return;
  }
  if (current.startsWith(MARK)) {
    console.log(`[native-retract] adapter already installed: ${file}`);
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, PACKAGE, 'package.json'), 'utf8'));
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  const snapshot = path.join(path.dirname(BACKUP), `${PACKAGE}-${pkg.version}-${Date.now()}.js`);
  fs.writeFileSync(snapshot, current);
  fs.writeFileSync(BACKUP, JSON.stringify({ file: snapshot, version: pkg.version, sha256: sha256(current) }, null, 2) + '\n');
  fs.writeFileSync(file, output);
  console.log(`[native-retract] installed for DSH ${pkg.version}: ${file}`);
  console.log(`[native-retract] byte-exact backup: ${snapshot}`);
}

try { main(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
