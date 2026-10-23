import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { ReviewStore } from '../src/core/store';
import { createPipeServer } from '../src/main/server';

test('AI skill helper submits through the real pipe without approving, writing, or resurrecting deleted reviews', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const repo = path.resolve('.'), python = process.env.DIFFEDITOR_TEST_PYTHON || 'python';
  const helper = path.join(repo, 'skills', 'diffeditor', 'scripts', 'invoke_diffeditor.py');
  await fs.access(helper);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-ai-interface-'));
  const store = new ReviewStore({ dataDir: path.join(root, 'cache') }); await store.init();
  const pipe = `\\\\.\\pipe\\diffeditor-ai-interface-${randomUUID()}`;
  let submissions = 0, connections = 0;
  const sockets = new Set<net.Socket>();
  const server = createPipeServer(store, () => submissions++);
  server.on('connection', socket => { connections++; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('diffeditor-ai-interface-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const installation = path.join(root, 'installation');
  await fs.mkdir(installation);
  await fs.writeFile(path.join(installation, 'diffeditor.cmd'), '@echo off\r\n', { flag: 'wx' });
  await build({ entryPoints: [path.join(repo, 'src', 'cli', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: path.join(installation, 'dist-electron', 'cli.cjs') });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  const env = { ...process.env, DIFFEDITOR_PIPE: pipe, DIFFEDITOR_HOME: installation, DIFFEDITOR_TIMEOUT_MS: '1500', PYTHONIOENCODING: 'utf-8' };
  delete (env as NodeJS.ProcessEnv).DIFFEDITOR_EXE;
  async function invoke(args: string[]) {
    return new Promise<{ code: number | null; value: any; stderr: string }>((resolve, reject) => {
      const child = spawn(python, [helper, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`DiffEditor helper timed out: ${args[0]}`)); }, 8000);
      child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
      child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        try { resolve({ code, value: JSON.parse(stdout), stderr }); }
        catch (error) { reject(new Error(`Invalid helper JSON: ${stdout}; ${stderr}`, { cause: error })); }
      });
    });
  }
  const target = path.join(root, '论文 草稿.tex');
  const original = Buffer.from('\\section{原稿}\r\n保留 $x^2$ 与中文。\r\n', 'utf8');
  await fs.writeFile(target, original, { flag: 'wx' });
  const baseline = await invoke(['baseline', target]);
  assert.equal(baseline.code, 0); assert.equal(baseline.stderr, '');
  assert.equal(baseline.value.files[0].text, '\\section{原稿}\n保留 $x^2$ 与中文。\n');
  const candidate = { requestId: randomUUID(), title: 'AI 候选 🧪', files: [{ baselineId: baseline.value.files[0].id, text: '\\section{候选}\n\\textbf{中文} 与 $x^3$；` $() & < > "\n' }] };
  const candidatePath = path.join(root, '候选 提交.json'), candidateBytes = Buffer.from(JSON.stringify(candidate), 'utf8');
  await fs.writeFile(candidatePath, candidateBytes, { flag: 'wx' });
  const submission = await invoke(['submit', '--file', candidatePath]);
  assert.equal(submission.code, 0); assert.equal(submission.value.duplicate, false);
  const reviewId = submission.value.reviewIds[0]; assert.equal(typeof reviewId, 'string');
  const pending = await invoke(['status', reviewId]);
  assert.equal(pending.code, 0); assert.equal(pending.value.reviews[0].lifecycle, 'open');
  assert.equal(pending.value.reviews[0].targets[0].status, 'pending');
  assert.equal(store.list().reviews[0].right.text, candidate.files[0].text);
  assert.deepEqual(await fs.readFile(target), original);
  // Direct store lifecycle operations stand in for a user's choices, isolated from the real app.
  await store.setReviewClosed(reviewId, true);
  const closed = await invoke(['status', reviewId]);
  assert.equal(closed.code, 0); assert.equal(closed.value.reviews[0].lifecycle, 'closed');
  assert.equal(store.list().reviews[0].right.text, candidate.files[0].text);
  await store.deleteReview(reviewId);
  const deleted = await invoke(['status', reviewId]);
  assert.equal(deleted.code, 0); assert.equal(deleted.value.reviews[0].lifecycle, 'deleted');
  const duplicate = await invoke(['submit', '--file', candidatePath]);
  assert.equal(duplicate.code, 0); assert.deepEqual(duplicate.value, { reviewIds: [reviewId], duplicate: true });
  assert.equal(store.list().reviews.length, 0); assert.equal(store.status(reviewId).reviews[0].lifecycle, 'deleted');
  const connectionsBeforeSave = connections;
  const refused = await invoke(['save', reviewId]);
  assert.equal(refused.code, 1); assert.equal(refused.value.code, 'CLI_HELPER_ERROR');
  assert.match(refused.value.error, /no CLI save or approval/); assert.equal(connections, connectionsBeforeSave);
  assert.equal(submissions, 2); assert.deepEqual(await fs.readFile(target), original);
  assert.deepEqual(await fs.readFile(candidatePath), candidateBytes);
  await assert.rejects(fs.stat(path.join(root, '.diffeditor-backups')), { code: 'ENOENT' });
});
