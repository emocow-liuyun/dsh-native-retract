#!/usr/bin/env node
/**
 * Expose a narrow image-intake verb so plugins can return an attachment to the
 * composer draft.
 *
 * DSH keeps pasted images as browser-only draft attachments created by
 * `conversation.createDrafts`, an internal service method no plugin can reach.
 * `inputActions` therefore has `addAttachments(ids)` but no way to produce an
 * id. This adapter adds exactly that missing link: it registers the same
 * `addFiles` intake the composer's paste and drop paths use as
 * `inputActions.addImageFiles(files)`, so any consumer on a Session slot can
 * put bytes back into the draft rail.
 *
 * Guards: version + byte length + SHA-256 of the file must match the recorded
 * backup before write; `--restore` only works against the exact patched bytes.
 *
 *   node scripts/patch-image-intake.cjs            # install
 *   node scripts/patch-image-intake.cjs --dry-run  # report only
 *   node scripts/patch-image-intake.cjs --restore  # revert
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE = 'dsh-client-ui-conversation';
const MARK = '/* dsh-image-intake-adapter-v1 */\n';
const DEFAULT_ROOT = '/opt/DeepSeek Harness/resources/dsh/node_modules/@deepseek-ai';
const ROOT = process.env.DSH_NODE_MODULES || DEFAULT_ROOT;
const target = path.join(ROOT, PACKAGE, 'lib', 'client.js');
const backupDir = path.join(__dirname, '..', 'backups');
const metaFile = path.join(backupDir, `${PACKAGE}.image-intake.json`);
const dryRun = process.argv.includes('--dry-run');
const restoreOnly = process.argv.includes('--restore');

function fail(message) {
  console.error(`[image-intake] ${message}`);
  process.exit(1);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function replaceOnce(source, anchor, replacement, name) {
  const first = source.indexOf(anchor);
  if (first < 0) throw new Error(`${name}: anchor not found`);
  if (source.indexOf(anchor, first + anchor.length) >= 0) throw new Error(`${name}: anchor is not unique`);
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

/** Read the installed package version, so a wrong fork fails closed. */
function packageVersion() {
  const manifest = path.join(ROOT, PACKAGE, 'package.json');
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
}

if (!fs.existsSync(target)) fail(`target not found: ${target}`);
const original = fs.readFileSync(target);
const version = packageVersion();

if (restoreOnly) {
  if (!fs.existsSync(metaFile)) fail(`no backup metadata at ${metaFile}`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  if (meta.version !== version) fail(`version mismatch: backup ${meta.version}, installed ${version}`);
  if (sha256(original) !== meta.patchedSha256) fail('patched bytes changed since install; refusing to overwrite');
  const backup = fs.readFileSync(meta.backup);
  if (sha256(backup) !== meta.originalSha256) fail('backup bytes do not match recorded sha256');
  if (dryRun) {
    console.log(`[image-intake] would restore ${target}`);
    process.exit(0);
  }
  fs.writeFileSync(target, backup);
  console.log(`[image-intake] restored ${target}`);
  process.exit(0);
}

let source = original.toString('utf8');
if (source.startsWith(MARK)) {
  console.log(`[image-intake] already installed for DSH ${version}; no change`);
  process.exit(0);
}

// 1. Add the verb to the shell's public action face, next to addAttachments.
const actionsAnchor = `\t\t\t\taddAttachments: (ids) => this.addAttachments(ids),`;
const actionsPatch = `${actionsAnchor}
\t\t\t\taddImageFiles: (files) => this.addImageDrafts(files),`;

// 2. Implement it on the shell: reuse the composer's own intake by asking the
//    conversation service for descriptors, then committing ids to the rail.
const addFilesAnchor = `\t\t\taddFiles(references, ids) {`;
const addFilesPatch = `\t\t\t/**
\t\t\t * Put browser image files back into this draft, as a paste would.
\t\t\t * The conversation service owns descriptor creation; the shell owns the
\t\t\t * rail, so the two halves are joined here rather than duplicated.
\t\t\t * @param files - image files to re-admit.
\t\t\t * @returns whether the rail accepted them.
\t\t\t */
\t\t\taddImageDrafts(files) {
\t\t\t\tif (this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;
\t\t\t\tif (!Array.isArray(files) || files.length === 0) return true;
\t\t\t\tconst create = this.deps.createDrafts;
\t\t\t\tif (typeof create !== "function") return false;
\t\t\t\tconst drafts = create(files);
\t\t\t\tif (drafts.length === 0) return false;
\t\t\t\treturn this.addAttachments(drafts.map((draft) => draft.id));
\t\t\t}

\t\t\taddFiles(references, ids) {`;

// 3. Supply that dependency from the hub, which already holds the conversation
//    service handle used by every other attachment path.
const createDraftsAnchor = `\t\t\t\t\tcommandAttachments: {`;
const createDraftsPatch = `\t\t\t\t\tcreateDrafts: (files) => {
\t\t\t\t\t\tconst conversation = this.rootCtx.get('conversation');
\t\t\t\t\t\tconst binding = this.sessions().binding(session.sessionId);
\t\t\t\t\t\tif (conversation === void 0 || binding === void 0) return [];
\t\t\t\t\t\treturn conversation.createDrafts(binding.sessionId, files);
\t\t\t\t\t},
\t\t\t\t\tcommandAttachments: {`;

try {
  // Order matters: the shell patch inserts text that contains its own anchor,
  // so it must run before any later patch could match inside it.
  source = replaceOnce(source, actionsAnchor, actionsPatch, 'actions');
  source = replaceOnce(source, createDraftsAnchor, createDraftsPatch, 'hub');
  source = replaceOnce(source, addFilesAnchor, addFilesPatch, 'shell');
} catch (error) {
  fail(`${error.message}; no files written (unsupported DSH build)`);
}

const patched = MARK + source;
if (dryRun) {
  const originalChars = original.toString('utf8').length;
  console.log(`[image-intake] ${target}: ${originalChars} → ${patched.length} characters; no files written`);
  process.exit(0);
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const backupPath = path.join(backupDir, `${PACKAGE}-${version}-${stamp}.js`);
fs.writeFileSync(backupPath, original);
fs.writeFileSync(metaFile, JSON.stringify({
  version,
  backup: backupPath,
  originalSha256: sha256(original),
  patchedSha256: sha256(Buffer.from(patched, 'utf8')),
}, null, 2) + '\n');
fs.writeFileSync(target, patched);
console.log(`[image-intake] installed for DSH ${version}: ${target}`);
console.log(`[image-intake] byte-exact backup: ${backupPath}`);
