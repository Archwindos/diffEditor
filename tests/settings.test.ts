import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SettingsStore } from '../src/main/settings';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SettingsStore(root); await store.init();
  return { root, store, filePath: path.join(root, 'settings.json') };
}

test('missing settings default to close to tray, and persisted choices survive reload', async t => {
  const { root, store, filePath } = await fixture(t);
  assert.deepEqual(store.get(), { closeToTray: true });
  const result = await store.set({ closeToTray: false });
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { closeToTray: false });
  result.closeToTray = true;
  assert.equal(store.get().closeToTray, false);
  const reloaded = new SettingsStore(root); await reloaded.init();
  assert.deepEqual(reloaded.get(), { closeToTray: false });
  await reloaded.set({ closeToTray: true });
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).closeToTray, true);
  assert.deepEqual(await fs.readdir(root), ['settings.json']);
});

test('settings reject malformed values without changing memory or the existing file', async t => {
  const { store, filePath } = await fixture(t);
  await store.set({ closeToTray: false });
  const before = await fs.readFile(filePath, 'utf8');
  for (const value of [null, [], {}, { closeToTray: 'false' }, { closeToTray: false, extra: true }]) {
    await assert.rejects(store.set(value), /设置格式无效/);
  }
  assert.deepEqual(store.get(), { closeToTray: false });
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
});

test('failed atomic replacement keeps memory intact, cleans its temporary file and permits retry', async t => {
  const { root, store, filePath } = await fixture(t);
  await store.set({ closeToTray: false });
  const previous = path.join(root, 'previous.json');
  await fs.rename(filePath, previous); await fs.mkdir(filePath);
  await assert.rejects(store.set({ closeToTray: true }), /无法保存设置/);
  assert.deepEqual(store.get(), { closeToTray: false });
  assert.equal(JSON.parse(await fs.readFile(previous, 'utf8')).closeToTray, false);
  assert.deepEqual((await fs.readdir(root)).sort(), ['previous.json', 'settings.json']);
  await fs.rmdir(filePath); await fs.rename(previous, filePath);
  assert.deepEqual(await store.set({ closeToTray: true }), { closeToTray: true });
});

test('serialized settings writes snapshot their input and corrupt persisted settings report an error', async t => {
  const { root, store, filePath } = await fixture(t);
  const input = { closeToTray: false }, first = store.set(input);
  input.closeToTray = true;
  const second = store.set({ closeToTray: true });
  assert.deepEqual(await first, { closeToTray: false }); await second;
  const reloaded = new SettingsStore(root); await reloaded.init();
  assert.deepEqual(reloaded.get(), { closeToTray: true });
  await fs.writeFile(filePath, '{bad JSON');
  await assert.rejects(new SettingsStore(root).init(), /无法读取设置/);
  await fs.writeFile(filePath, JSON.stringify({ closeToTray: 1 }));
  await assert.rejects(new SettingsStore(root).init(), /closeToTray 必须为布尔值/);
});
