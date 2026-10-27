import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import type { ReviewView, Side, SavePreview, TextEncoding, TargetView } from '../shared/contracts';
import { replaceChunk } from './chunks';
import { hasOtherUnfinishedFile, retainedReceiptFor } from './retained';
import { Settings } from './Settings';
import { TextOverview } from './TextOverview';
import './styles.css';

(self as typeof self & { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme('review-light', {
  base: 'vs', inherit: true, rules: [], colors: {
    'editor.background': '#ffffff', 'editor.foreground': '#25303a',
    'editorLineNumber.foreground': '#a0a7ae', 'editorLineNumber.activeForeground': '#4c5966',
    'editor.lineHighlightBackground': '#f7f9fa', 'editor.selectionBackground': '#4b9be866',
    'editor.inactiveSelectionBackground': '#4b9be84d',
    'diffEditor.insertedTextBackground': '#a9dfb762', 'diffEditor.removedTextBackground': '#f3b5b75c',
    'diffEditor.insertedLineBackground': '#eff8f0', 'diffEditor.removedLineBackground': '#fff0f0',
    'diffEditor.diagonalFill': '#eef1f3', 'editorGutter.background': '#ffffff',
  },
});

type Draft = { text: string; persisted: string; revision: number; state: 'cached' | 'caching' | 'error'; error?: string; queue: Promise<void>; timer?: ReturnType<typeof setTimeout>; inFlight: boolean };
type FrozenPreview = { preview: SavePreview; text: string };
const sides: Side[] = ['left', 'right'];
const labels: Record<Side, string> = { left: '原稿（左）', right: '新稿（右）' };
const versionNames: Record<Side, string> = { left: '原稿', right: '新稿' };
const encodings: Record<TextEncoding, string> = { utf8: 'UTF-8', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', gb18030: 'GB18030' };
const statusLabels: Record<string, string> = { pending: '待审核', saving: '正在保存', saved: '已正式保存', conflict: '文件有冲突', error: '保存失败', rejected: '已退回' };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const basename = (path: string) => path.split(/[\\/]/).pop() || path;
const keyFor = (id: string, side: Side) => `${id}:${side}`;
const targetFor = (review: ReviewView, side: Side) => review.targets.find(t => t.id === review[side].targetId);
const locked = (target?: TargetView) => !!target && ['saved', 'saving', 'rejected'].includes(target.status);
const canSave = (target?: TargetView) => !target || target.status === 'pending';
const isUncreatedText = (review: ReviewView, target?: TargetView) => review.mode === 'text' && (!target || (!target.exists && target.status === 'pending'));
monaco.languages.register({ id: 'latex' });
monaco.languages.setMonarchTokensProvider('latex', { tokenizer: { root: [[/%.*$/, 'comment'], [/\\[a-zA-Z@]+|\\./, 'keyword'], [/[{}\[\]]/, 'delimiter'], [/\$\$?|\\\(|\\\)/, 'string']] } });
monaco.languages.register({ id: 'json' });
monaco.languages.setMonarchTokensProvider('json', { tokenizer: { root: [[/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type.identifier'], [/"(?:[^"\\]|\\.)*"/, 'string'], [/\b(?:true|false|null)\b/, 'keyword'], [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'], [/[{}\[\]:,]/, 'delimiter']] } });
const languageFor = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return ({ md: 'markdown', markdown: 'markdown', tex: 'latex', sty: 'latex', cls: 'latex', json: 'json', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', css: 'css', html: 'html', htm: 'html', xml: 'xml', yaml: 'yaml', yml: 'yaml', sh: 'shell' } as Record<string, string>)[ext] || 'plaintext';
};

function trackScrollActivity(editor: monaco.editor.IStandaloneCodeEditor) {
  const node = editor.getDomNode();
  if (!node) return { dispose() {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draggingScrollbar = false;
  const reveal = () => {
    clearTimeout(timer);
    node.classList.add('scroll-active');
    if (!draggingScrollbar) timer = setTimeout(() => node.classList.remove('scroll-active'), 700);
  };
  const pointerDown = (event: PointerEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest('.scrollbar')) return;
    draggingScrollbar = true; reveal();
  };
  const pointerUp = () => {
    if (!draggingScrollbar) return;
    draggingScrollbar = false; reveal();
  };
  const scroll = editor.onDidScrollChange(event => { if (event.scrollTopChanged || event.scrollLeftChanged) reveal(); });
  node.addEventListener('wheel', reveal, { passive: true });
  node.addEventListener('pointerdown', pointerDown, true);
  document.addEventListener('pointerup', pointerUp);
  document.addEventListener('pointercancel', pointerUp);
  window.addEventListener('blur', pointerUp);
  return { dispose() {
    clearTimeout(timer); scroll.dispose();
    node.removeEventListener('wheel', reveal);
    node.removeEventListener('pointerdown', pointerDown, true);
    document.removeEventListener('pointerup', pointerUp);
    document.removeEventListener('pointercancel', pointerUp);
    window.removeEventListener('blur', pointerUp);
    node.classList.remove('scroll-active');
  } };
}

function App() {
  const [reviews, setReviews] = useState<ReviewView[]>([]);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [, redraw] = useState(0);
  const [focusSide, setFocusSide] = useState<Side>('right');
  const [openEncoding, setOpenEncoding] = useState<'auto' | 'gb18030'>('auto');
  const [saveEncoding, setSaveEncoding] = useState<Partial<Record<Side, TextEncoding>>>({});
  const [wrap, setWrap] = useState(true);
  const [comparisonOverrides, setComparisonOverrides] = useState<Record<string, string>>({});
  const [fold, setFold] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<FrozenPreview>();
  const [changes, setChanges] = useState<monaco.editor.ILineChange[]>([]);
  const [chunkPositions, setChunkPositions] = useState<{ top: number; bottom: number }[]>([]);
  const [hoveredChunk, setHoveredChunk] = useState<{ index: number; to: Side }>();
  const [currentChunk, setCurrentChunk] = useState(-1);
  const [dragging, setDragging] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState<{ reviews: ReviewView[]; closedOnly: boolean }>();
  const [showClosed, setShowClosed] = useState(false);
  const deletingIds = useRef(new Set<string>());
  const removedIds = useRef(new Set<string>());
  const modalRef = useRef(false); modalRef.current = !!preview || !!deletePrompt || rejecting;
  const blocked = busy || !!preview || !!deletePrompt || rejecting;
  const drafts = useRef(new Map<string, Draft>());
  const reviewsRef = useRef(reviews); reviewsRef.current = reviews;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const editorHost = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined);
  const retainedEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const models = useRef<{ left: monaco.editor.ITextModel; right: monaco.editor.ITextModel } | undefined>(undefined);
  const suppress = useRef(false);
  const focusRef = useRef(focusSide); focusRef.current = focusSide;
  const previewRef = useRef(preview); previewRef.current = preview;
  const busyRef = useRef(false);
  const refreshGeneration = useRef(0);
  const bump = () => redraw(n => n + 1);
  const review = reviews.find(r => r.id === selected && !r.closedAt);
  const retainedReceipt = review && retainedReceiptFor(review);
  const retainedSide = retainedReceipt && comparisonOverrides[review!.id] !== retainedReceipt.operationId ? retainedReceipt.side : undefined;
  const openReviews = reviews.filter(r => !r.closedAt);
  const closedReviews = reviews.filter(r => r.closedAt);

  const merge = useCallback((incoming: ReviewView[]) => {
    incoming = incoming.filter(r => !removedIds.current.has(r.id));
    for (const r of incoming) for (const side of sides) {
      const key = keyFor(r.id, side), existing = drafts.current.get(key), pane = r[side];
      if (!existing) drafts.current.set(key, { text: pane.text, persisted: pane.text, revision: pane.revision, state: 'cached', queue: Promise.resolve(), inFlight: false });
      else if (!existing.inFlight && existing.text === existing.persisted && pane.revision >= existing.revision) {
        existing.text = pane.text; existing.persisted = pane.text; existing.revision = pane.revision;
      } else if (!existing.inFlight && pane.revision > existing.revision) {
        existing.state = 'error'; existing.error = '草稿版本已变化。当前编辑已保留，请先处理其他窗口或外部更新。';
      }
    }
    reviewsRef.current = incoming;
    setReviews(incoming);
    setSelected(current => current && incoming.some(r => r.id === current && !r.closedAt) ? current : incoming.find(r => !r.closedAt)?.id);
    bump();
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const result = await window.diffEditor.list();
    if (generation === refreshGeneration.current) merge(result.reviews);
  }, [merge]);
  const applyReview = (incoming: ReviewView) => {
    if (removedIds.current.has(incoming.id) || deletingIds.current.has(incoming.id)) return;
    merge(reviewsRef.current.some(r => r.id === incoming.id)
      ? reviewsRef.current.map(r => r.id === incoming.id ? incoming : r) : [...reviewsRef.current, incoming]);
  };

  const flushPane = async (id: string, side: Side) => {
    const draft = drafts.current.get(keyFor(id, side));
    if (!draft || deletingIds.current.has(id) || removedIds.current.has(id)) return;
    clearTimeout(draft.timer);
    const job = draft.queue.catch(() => {}).then(async () => {
      while (draft.text !== draft.persisted && !deletingIds.current.has(id) && !removedIds.current.has(id)) {
        const text = draft.text;
        draft.state = 'caching'; draft.inFlight = true; draft.error = undefined; bump();
        try {
          const updated = await window.diffEditor.updateDraft({ reviewId: id, side, text, expectedRevision: draft.revision });
          draft.revision = updated[side].revision; draft.persisted = text;
          draft.state = draft.text === text ? 'cached' : 'caching';
          applyReview(updated);
        } catch (e) {
          draft.state = 'error'; draft.error = errorText(e); throw e;
        } finally { draft.inFlight = false; bump(); }
      }
    });
    draft.queue = job;
    return job;
  };
  const flushReview = async (id: string) => {
    const results = await Promise.allSettled(sides.map(side => flushPane(id, side)));
    const failure = results.find(r => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };
  const flushAll = async () => {
    for (const r of reviewsRef.current) await flushReview(r.id);
  };
  const edit = (side: Side, text: string) => {
    const id = selectedRef.current;
    if (!id || suppress.current || deletingIds.current.has(id) || removedIds.current.has(id)) return;
    const draft = drafts.current.get(keyFor(id, side));
    if (!draft) return;
    draft.text = text; draft.state = text === draft.persisted ? 'cached' : 'caching'; draft.error = undefined;
    clearTimeout(draft.timer);
    if (text !== draft.persisted) draft.timer = setTimeout(() => void flushPane(id, side).catch(() => {}), 450);
    bump();
  };
  const action = async (task: () => Promise<void>, fromModal = false) => {
    if (busyRef.current || (modalRef.current && !fromModal)) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await task(); } catch (e) { setError(errorText(e)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const open = (mode: 'single' | 'pair') => void action(async () => {
    await flushAll();
    const before = new Set(reviewsRef.current.map(r => r.id));
    const result = await window.diffEditor.pickFiles(mode, openEncoding === 'auto' ? undefined : openEncoding);
    merge(result.reviews);
    const added = result.reviews.find(r => !before.has(r.id)); if (added) setSelected(added.id);
  });
  const createText = () => void action(async () => {
    await flushAll();
    const next = await window.diffEditor.createTextReview();
    applyReview(next); setSelected(next.id);
  });
  const closeReview = (id: string) => void action(async () => {
    await flushReview(id);
    await window.diffEditor.setReviewClosed(id, true);
    setComparisonOverrides(current => { const next = { ...current }; delete next[id]; return next; });
    await refresh();
  });
  const reopenReview = (id: string) => void action(async () => {
    if (selectedRef.current) await flushReview(selectedRef.current);
    await window.diffEditor.setReviewClosed(id, false);
    await refresh(); setSelected(id);
  });
  const requestDelete = (current: ReviewView) => {
    if (blocked) return;
    setError(''); setDeletePrompt({ reviews: [current], closedOnly: false });
  };
  const requestDeleteClosed = () => {
    if (blocked) return;
    const closed = reviewsRef.current.filter(r => r.closedAt);
    if (closed.length) { setError(''); setDeletePrompt({ reviews: closed, closedOnly: true }); }
  };
  const confirmDelete = () => {
    if (!deletePrompt) return;
    const ids = deletePrompt.reviews.map(r => r.id), closedOnly = deletePrompt.closedOnly;
    void action(async () => {
      ++refreshGeneration.current;
      for (const id of ids) {
        deletingIds.current.add(id);
        for (const side of sides) clearTimeout(drafts.current.get(keyFor(id, side))?.timer);
      }
      await Promise.allSettled(ids.flatMap(id => sides.map(side => drafts.current.get(keyFor(id, side))?.queue)));
      try {
        const deleted = closedOnly ? await window.diffEditor.deleteClosedReviews(ids) : (await window.diffEditor.deleteReview(ids[0]), ids);
        for (const id of deleted) {
          removedIds.current.add(id);
          for (const side of sides) drafts.current.delete(keyFor(id, side));
        }
        merge(reviewsRef.current.filter(r => !removedIds.current.has(r.id)));
        setDeletePrompt(undefined);
      } finally {
        for (const id of ids) {
          deletingIds.current.delete(id);
          if (!removedIds.current.has(id)) for (const side of sides) {
            const draft = drafts.current.get(keyFor(id, side));
            if (draft && draft.text !== draft.persisted) draft.timer = setTimeout(() => void flushPane(id, side).catch(() => {}), 450);
          }
        }
      }
      await refresh();
    }, true);
  };
  const saveSide = async (side: Side) => {
    if (modalRef.current) return;
    const current = reviewsRef.current.find(r => r.id === selectedRef.current);
    if (!current || !canSave(targetFor(current, side))) return;
    await action(async () => {
      await flushReview(current.id);
      const draft = drafts.current.get(keyFor(current.id, side))!;
      const frozenText = draft.text;
      const frozen = await window.diffEditor.prepareSave({ reviewId: current.id, side, expectedRevision: draft.revision, encoding: saveEncoding[side] });
      if (frozen) setPreview({ preview: frozen, text: frozenText });
    });
  };
  const saveRef = useRef(saveSide); saveRef.current = saveSide;
  const flushRef = useRef(flushAll); flushRef.current = flushAll;

  useEffect(() => {
    void refresh().catch(e => setError(errorText(e)));
    const offChanged = window.diffEditor.onChanged(() => void refresh().catch(e => setError(errorText(e))));
    const offSave = window.diffEditor.onSaveShortcut(() => void saveRef.current(focusRef.current));
    const offClose = window.diffEditor.onBeforeClose(() => {
      void flushRef.current().then(() => window.diffEditor.readyToClose()).catch(e => setError(`无法关闭：草稿尚未缓存。${errorText(e)}。请重试缓存后再关闭。`));
    });
    return () => { offChanged(); offSave(); offClose(); };
  }, [refresh]);

  useEffect(() => {
    if (!editorHost.current || !selected || !reviewsRef.current.some(r => r.id === selected && !r.closedAt)) return;
    const currentReview = reviewsRef.current.find(r => r.id === selected)!;
    const left = monaco.editor.createModel(drafts.current.get(keyFor(selected, 'left'))?.text || '', languageFor(targetFor(currentReview, 'left')?.path || ''));
    const right = monaco.editor.createModel(drafts.current.get(keyFor(selected, 'right'))?.text || '', languageFor(targetFor(currentReview, 'right')?.path || ''));
    left.setEOL(monaco.editor.EndOfLineSequence.LF); right.setEOL(monaco.editor.EndOfLineSequence.LF);
    models.current = { left, right };
    const options: monaco.editor.IStandaloneEditorConstructionOptions = {
      theme: 'review-light', automaticLayout: true, roundedSelection: false,
      fontFamily: "'Cascadia Code', Consolas, 'Microsoft YaHei UI', monospace", fontSize: 13, lineHeight: 22,
      minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: wrap ? 'on' : 'off',
      padding: { top: 14, bottom: 16 }, lineNumbersMinChars: 4, glyphMargin: false,
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, verticalSliderSize: 6, horizontalSliderSize: 6, useShadows: false },
    };
    const disposables = [left.onDidChangeContent(() => edit('left', left.getValue())), right.onDidChangeContent(() => edit('right', right.getValue()))];
    setCurrentChunk(-1); setChanges([]); setChunkPositions([]); setHoveredChunk(undefined); setSaveEncoding({}); setRejecting(false);
    if (retainedSide) {
      const editor = monaco.editor.create(editorHost.current, { ...options, model: models.current[retainedSide], readOnly: true, scrollbar: { ...options.scrollbar, vertical: 'hidden', verticalScrollbarSize: 0 } });
      retainedEditorRef.current = editor;
      editor.getDomNode()?.setAttribute('data-testid', 'editor-retained');
      editor.getDomNode()?.setAttribute('data-side', retainedSide);
      setFocusSide(retainedSide);
      disposables.push(trackScrollActivity(editor));
      return () => { disposables.forEach(d => d.dispose()); editor.setModel(null); editor.dispose(); left.dispose(); right.dispose(); models.current = undefined; retainedEditorRef.current = undefined; };
    }
    const diff = monaco.editor.createDiffEditor(editorHost.current, {
      ...options, originalEditable: true, readOnly: false,
      renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false, ignoreTrimWhitespace: false,
      renderIndicators: true, renderMarginRevertIcon: false, renderGutterMenu: false, enableSplitViewResizing: false,
      hideUnchangedRegions: { enabled: fold, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 10 },
      diffAlgorithm: 'advanced', maxComputationTime: 0, renderOverviewRuler: false, diffWordWrap: wrap ? 'on' : 'off',
    });
    diff.setModel({ original: left, modified: right }); diffRef.current = diff;
    diff.getModifiedEditor().updateOptions({ scrollbar: { vertical: 'hidden', verticalScrollbarSize: 0 } });
    diff.getOriginalEditor().getDomNode()?.setAttribute('data-testid', 'editor-left');
    diff.getModifiedEditor().getDomNode()?.setAttribute('data-testid', 'editor-right');
    const positionChunks = () => {
      const next = diff.getLineChanges() || [];
      const original = diff.getOriginalEditor(), modified = diff.getModifiedEditor();
      setChunkPositions(next.map(c => {
        const source = c.originalEndLineNumber ? original : modified;
        const start = c.originalEndLineNumber ? c.originalStartLineNumber : c.modifiedStartLineNumber;
        const end = c.originalEndLineNumber ? c.originalEndLineNumber : c.modifiedEndLineNumber;
        const top = source.getTopForLineNumber(Math.max(1, start)) - source.getScrollTop();
        const bottom = source.getBottomForLineNumber(Math.max(1, end)) - source.getScrollTop();
        const modifiedBottom = c.modifiedEndLineNumber ? modified.getBottomForLineNumber(c.modifiedEndLineNumber) - modified.getScrollTop() : bottom;
        return { top, bottom: Math.max(bottom, modifiedBottom, top + 22) };
      }));
    };
    disposables.push(
      trackScrollActivity(diff.getOriginalEditor()),
      trackScrollActivity(diff.getModifiedEditor()),
      diff.getOriginalEditor().onDidFocusEditorText(() => setFocusSide('left')),
      diff.getModifiedEditor().onDidFocusEditorText(() => setFocusSide('right')),
      diff.onDidUpdateDiff(() => { const next = diff.getLineChanges() || []; setChanges(next); setHoveredChunk(undefined); setCurrentChunk(i => Math.min(i, next.length - 1)); positionChunks(); }),
      diff.getOriginalEditor().onDidScrollChange(positionChunks),
      diff.getModifiedEditor().onDidScrollChange(positionChunks),
      diff.getModifiedEditor().onDidLayoutChange(positionChunks),
    );
    const saveCommand = () => { void saveRef.current(focusRef.current); };
    for (const ed of [diff.getOriginalEditor(), diff.getModifiedEditor()]) ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCommand);
    return () => { disposables.forEach(d => d.dispose()); diff.setModel(null); diff.dispose(); left.dispose(); right.dispose(); models.current = undefined; diffRef.current = undefined; };
  }, [selected, retainedSide]);

  useEffect(() => {
    if (!review || !models.current) return;
    suppress.current = true;
    for (const side of sides) {
      const text = drafts.current.get(keyFor(review.id, side))?.text;
      if (text !== undefined && models.current[side].getValue() !== text) models.current[side].setValue(text);
    }
    suppress.current = false;
  });
  useEffect(() => {
    if (!review) return;
    diffRef.current?.updateOptions({ originalEditable: !locked(targetFor(review, 'left')) && !blocked, readOnly: locked(targetFor(review, 'right')) || blocked, wordWrap: wrap ? 'on' : 'off', diffWordWrap: wrap ? 'on' : 'off', hideUnchangedRegions: { enabled: fold, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 10 } });
    retainedEditorRef.current?.updateOptions({ readOnly: true, wordWrap: wrap ? 'on' : 'off' });
  }, [wrap, fold, review, blocked, retainedSide]);

  const navigate = (step: number) => {
    if (!changes.length) return;
    const index = currentChunk < 0 ? (step < 0 ? changes.length - 1 : 0) : (currentChunk + step + changes.length) % changes.length;
    setCurrentChunk(index);
    const c = changes[index];
    diffRef.current?.getModifiedEditor().revealLineInCenter(Math.max(1, c.modifiedStartLineNumber));
    diffRef.current?.getOriginalEditor().revealLineInCenter(Math.max(1, c.originalStartLineNumber));
  };
  const transfer = (index: number, from: Side) => {
    if (!review || !models.current || blocked || retainedSide || !changes[index]) return;
    const to: Side = from === 'left' ? 'right' : 'left';
    if (locked(targetFor(review, to))) return;
    const model = models.current[to];
    const text = replaceChunk(models.current[from].getValue(), model.getValue(), changes[index], from);
    const ed = to === 'left' ? diffRef.current!.getOriginalEditor() : diffRef.current!.getModifiedEditor();
    ed.pushUndoStop(); ed.executeEdits('replace-diff-chunk', [{ range: model.getFullModelRange(), text }]); ed.pushUndoStop();
    ed.focus(); setFocusSide(to);
  };
  const editorAction = (id: string) => {
    if (blocked) return;
    const ed = retainedEditorRef.current || (focusSide === 'left' ? diffRef.current?.getOriginalEditor() : diffRef.current?.getModifiedEditor());
    ed?.focus();
    if (id === 'undo' || id === 'redo') ed?.trigger('toolbar', id, null);
    else void ed?.getAction(id)?.run();
  };
  const hoverChunk = (event: React.PointerEvent<HTMLDivElement>) => {
    // Text selection owns the pointer while dragging; don't flash transfer controls over it.
    if (retainedSide || blocked || event.buttons !== 0 || !diffRef.current) { setHoveredChunk(undefined); return; }
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-chunk-index]') : null;
    if (target) {
      const next = { index: Number(target.dataset.chunkIndex), to: target.dataset.to as Side };
      setHoveredChunk(current => current?.index === next.index && current.to === next.to ? current : next);
      return;
    }
    const stage = event.currentTarget.getBoundingClientRect();
    if (event.clientX >= stage.right - 40) { setHoveredChunk(undefined); return; }
    const y = event.clientY - stage.top;
    const index = chunkPositions.findIndex(chunk => y >= chunk.top && y < chunk.bottom);
    if (index < 0) { setHoveredChunk(undefined); return; }
    const to: Side = event.clientX < stage.left + (stage.width - 40) / 2 ? 'left' : 'right';
    setHoveredChunk(current => current?.index === index && current.to === to ? current : { index, to });
  };
  const drop = (event: React.DragEvent, mode: 'single' | 'pair') => {
    event.preventDefault(); event.stopPropagation(); setDragging(false);
    const paths = Array.from(event.dataTransfer.files).map(f => window.diffEditor.getFilePath(f)).filter(Boolean);
    void action(async () => {
      if (!paths.length) throw new Error('请从文件资源管理器拖入本地文本文件。');
      if (mode === 'pair' && paths.length !== 2) throw new Error('双文件比较需要一次拖入两个文件。');
      await flushAll();
      const before = new Set(reviewsRef.current.map(r => r.id));
      const result = await window.diffEditor.openFiles({ paths, mode, encoding: openEncoding === 'auto' ? undefined : openEncoding });
      merge(result.reviews); const added = result.reviews.find(r => !before.has(r.id)); if (added) setSelected(added.id);
    });
  };

  return <div className="app" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon">⇄</span><strong>DiffEditor</strong><span className="local-tag">本地</span></div>
      <div className="open-controls"><button data-testid="open-single" className="primary" disabled={blocked} onClick={() => open('single')}>打开文件</button><button data-testid="open-pair" disabled={blocked} onClick={() => open('pair')}>双文件比较</button></div>
      <button data-testid="new-text" className="new-text-button" disabled={blocked} onClick={createText}>新建文本比较</button>
      <label className="open-encoding">读取编码<select aria-label="打开文件编码" value={openEncoding} onChange={e => setOpenEncoding(e.target.value as 'auto' | 'gb18030')}><option value="auto">自动识别（UTF 优先）</option><option value="gb18030">GB18030</option></select></label>
      <div className="queue-heading"><span>比较列表</span><span>{openReviews.length}</span></div>
      <nav className="review-list" aria-label="比较列表">{openReviews.map(r => {
        const statuses = r.targets.map(t => t.status);
        const state = statuses.length && statuses.every(s => s === 'saved') ? 'saved' : statuses.length && statuses.every(s => s === 'rejected') ? 'rejected' : statuses.includes('conflict') ? 'conflict' : statuses.includes('error') ? 'error' : 'pending';
        return <div key={r.id} className={`review-row ${selected === r.id ? 'selected' : ''}`}><button data-testid={`review-${r.id}`} className="review-item" disabled={blocked} onClick={() => void action(async () => { if (selected) await flushReview(selected); setSelected(r.id); })} title={r.targets.map(t => t.path).join('\n') || r.title}><span className="review-title">{r.title}</span><span className="review-detail"><i className={`status-dot ${state}`} />{r.mode === 'text' && !r.targets.length ? '文本草稿' : statusLabels[state]}<span>{r.mode === 'single' ? '单文件' : r.mode === 'pair' ? '双文件' : r.mode === 'text' ? '文本' : '修改提案'}</span></span></button><div className="review-row-actions"><button data-testid={`close-${r.id}`} disabled={blocked} onClick={() => closeReview(r.id)} aria-label={`关闭比较 ${r.title}`}>关闭</button><button data-testid={`delete-${r.id}`} disabled={blocked} onClick={() => requestDelete(r)} aria-label={`删除比较 ${r.title}`}>删除</button></div></div>;
      })}
      {!!closedReviews.length && <><div className="closed-controls"><button className="closed-heading" data-testid="toggle-closed" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>已关闭 <span>{closedReviews.length}</span></button><button className="delete-closed" data-testid="delete-closed" disabled={blocked} onClick={requestDeleteClosed} aria-label="删除全部已关闭比较">删除全部</button></div>{showClosed && closedReviews.map(r => <div key={r.id} className="review-row closed-review" data-testid={`closed-${r.id}`}><span className="review-title" title={r.title}>{r.title}</span><div className="review-row-actions"><button data-testid={`reopen-${r.id}`} disabled={blocked} onClick={() => reopenReview(r.id)}>重新打开</button><button data-testid={`delete-${r.id}`} disabled={blocked} onClick={() => requestDelete(r)} aria-label={`删除比较 ${r.title}`}>删除</button></div></div>)}</>}
      </nav>
      <Settings disabled={blocked} />
      <div className="sidebar-foot"><span className="privacy-dot" />文件始终保存在本机</div>
    </aside>
    <main className="workspace">
      <header className="toolbar"><div className="toolbar-title">{review?.title || '文本比较'}</div><div className="toolbar-actions"><button title="撤销（Ctrl+Z）" disabled={!review || !!retainedSide} onClick={() => editorAction('undo')}>撤销</button><button title="重做（Ctrl+Y）" disabled={!review || !!retainedSide} onClick={() => editorAction('redo')}>重做</button><span className="separator" /><button title="查找（Ctrl+F）" disabled={!review} onClick={() => editorAction('actions.find')}>查找</button><button data-testid="toggle-wrap" className={wrap ? 'active' : ''} onClick={() => setWrap(!wrap)}>自动换行</button>{!retainedSide && <><button data-testid="toggle-fold" className={fold ? 'active' : ''} onClick={() => setFold(!fold)}>折叠相同</button><span className="separator" /><button aria-label="上一处差异" disabled={!changes.length} onClick={() => navigate(-1)}>↑</button><span className="diff-count" data-testid="diff-count">{changes.length ? `${currentChunk < 0 ? '—' : currentChunk + 1} / ${changes.length}` : '0 处差异'}</span><button aria-label="下一处差异" disabled={!changes.length} onClick={() => navigate(1)}>↓</button></>}</div></header>
      {error && !deletePrompt && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
      {review ? <>
        <div className={`pane-headers ${retainedSide ? 'retained-view' : ''}`} data-testid={retainedSide ? 'retained-view' : 'comparison-view'}>{(retainedSide ? [retainedSide] : sides).map(side => {
          const target = targetFor(review, side), draft = drafts.current.get(keyFor(review.id, side));
          const aiDraft = review.mode === 'proposal' && side === 'right' && target?.status !== 'saved';
          const pathText = target ? (aiDraft ? `AI 提供的草稿，确认后保存至：${target.path}` : target.path) : '保存时选择文件位置';
          const lineCount = models.current?.[side].getLineCount() ?? draft?.text.split('\n').length ?? 0;
          const changedLines = changes.reduce((total, change) => {
            const start = side === 'left' ? change.originalStartLineNumber : change.modifiedStartLineNumber;
            const end = side === 'left' ? change.originalEndLineNumber : change.modifiedEndLineNumber;
            return total + (end === 0 ? 0 : end - start + 1);
          }, 0);
          return <section key={side} className={`pane-header ${focusSide === side ? 'focused' : ''}`}><div className="pane-heading"><span className="side-label">{labels[side]}</span><strong title={target?.path}>{target ? basename(target.path) : `${versionNames[side]}文本`}</strong><span className={`formal-state ${target?.status || 'pending'}`}>{target ? statusLabels[target.status] : '未关联文件'}</span></div><div className={`pane-path ${aiDraft ? 'ai-draft-path' : ''}`} data-testid={`pane-path-${side}`} title={pathText}>{pathText}</div><div className="pane-controls"><span data-testid={`draft-status-${side}`} className={`draft-status ${draft?.state}`}>{draft?.state === 'caching' ? '草稿缓存中…' : draft?.state === 'error' ? '草稿缓存失败' : '草稿已缓存'}</span><span className="pane-metrics"><span data-testid={`line-count-${side}`}>{lineCount.toLocaleString()} 行</span><span data-testid={`change-count-${side}`} className={side === 'left' ? 'deleted' : 'added'}>{side === 'left' ? '−' : '+'}{changedLines.toLocaleString()} 行</span></span>{draft?.state === 'error' && <button className="text-button" onClick={() => void action(() => flushPane(review.id, side))}>重试</button>}<div className="pane-save"><select data-testid={`save-encoding-${side}`} aria-label={`${labels[side]}保存编码`} disabled={blocked || !canSave(target)} value={saveEncoding[side] || target?.encoding || 'utf8'} onChange={e => setSaveEncoding(current => ({ ...current, [side]: e.target.value as TextEncoding }))}>{Object.entries(encodings).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button data-testid={`save-${side}`} className="save-button" disabled={blocked || !canSave(target)} onClick={() => void saveSide(side)}>{isUncreatedText(review, target) ? '另存为…' : `保存${versionNames[side]}`}</button></div></div>{(draft?.error || target?.error) && <div className="pane-error" role="alert">{draft?.error || target?.error}</div>}{target?.receipt && <div className="receipt">已保存 {new Date(target.receipt.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}{target.receipt.backupPath && <button className="text-button" onClick={() => void action(async () => { await window.diffEditor.showInFolder(target.receipt!.backupPath!); })}>查看备份</button>}<button data-testid={`continue-${side}`} className="text-button" disabled={blocked} onClick={() => void action(async () => { await flushReview(review.id); const next = await window.diffEditor.continueTarget(review.id, target.id); await refresh(); setSelected(next.id); })}>继续编辑</button></div>}{(target?.status === 'conflict' || target?.status === 'error') && <div className="recovery"><span>当前草稿已保留，重新读取磁盘文件后继续审核。</span><button data-testid={`continue-${side}`} className="text-button" disabled={blocked} onClick={() => void action(async () => { await flushReview(review.id); const next = await window.diffEditor.continueTarget(review.id, target.id); await refresh(); setSelected(next.id); })}>基于磁盘继续</button></div>}</section>;
        })}</div>
        <div className="editor-stage" data-testid="editor-stage" onPointerMove={hoverChunk} onPointerDown={e => { if (!(e.target instanceof Element) || !e.target.closest('[data-chunk-index]')) setHoveredChunk(undefined); }} onPointerLeave={() => setHoveredChunk(undefined)} onWheel={() => setHoveredChunk(undefined)}>
          <div className="editor-host" data-testid={retainedSide ? 'retained-editor' : 'diff-editor'} ref={editorHost} />
          {!retainedSide && <div className="chunk-rail" aria-label="逐块替换">{changes.map((_, index) => <div key={index} className="chunk-actions" style={{ top: (chunkPositions[index]?.bottom ?? 0) > 0 ? Math.max(0, chunkPositions[index].top) : -1000 }}>
            {sides.map(to => <button key={to} className={`chunk-action to-${to} ${hoveredChunk?.index === index && hoveredChunk.to === to ? 'is-visible' : ''}`} data-testid={`chunk-to-${to}-${index}`} data-chunk-index={index} data-to={to} aria-label={`第 ${index + 1} 处${to === 'left' ? '用新稿替换原稿' : '用原稿替换新稿'}`} title={to === 'left' ? '用新稿替换原稿此处' : '用原稿替换新稿此处'} disabled={locked(targetFor(review, to)) || blocked} onClick={() => transfer(index, to === 'left' ? 'right' : 'left')}><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={to === 'left' ? 'M19 12H5m5-5-5 5 5 5' : 'M5 12h14m-5-5 5 5-5 5'} /></svg></button>)}
          </div>)}</div>}
          <TextOverview diff={diffRef.current} editor={retainedEditorRef.current} changes={changes} originalText={drafts.current.get(keyFor(review.id, 'left'))?.text || ''} modifiedText={drafts.current.get(keyFor(review.id, 'right'))?.text || ''} retainedSide={retainedSide} />
        </div>
        <footer className="statusbar"><span>{retainedSide ? '已保存内容' : <><i className="diff-key removed" />删除<i className="diff-key added" />新增<span className="status-note">实时比较 · 包含空白差异</span></>}</span><div>{retainedSide && retainedReceipt && hasOtherUnfinishedFile(review, retainedReceipt) && <button data-testid="resume-comparison" disabled={blocked} onClick={() => setComparisonOverrides(current => ({ ...current, [review.id]: retainedReceipt.operationId }))}>继续审阅另一文件</button>}{!retainedSide && (rejecting ? <><span>退回后保留审核历史</span><button data-testid="confirm-reject" disabled={busy} onClick={() => void action(async () => { await flushReview(review.id); await window.diffEditor.rejectReview(review.id); setRejecting(false); await refresh(); }, true)}>确认退回</button><button disabled={busy} onClick={() => setRejecting(false)}>取消</button></> : review.mode !== 'text' && <button data-testid="reject-review" disabled={blocked || review.targets.every(t => locked(t))} onClick={() => setRejecting(true)}>退回审核</button>)}<span>{labels[retainedSide || focusSide]}{retainedSide || locked(targetFor(review, focusSide)) ? '已锁定' : '正在编辑'}</span></div></footer>
      </> : <div className="empty-state"><div className="empty-symbol">⇄</div><h1>逐处比较和编辑文本</h1><p>两侧都可以编辑。草稿自动缓存，文件由你确认后保存。</p><div className="empty-buttons"><button data-testid="empty-new-text" className="primary" disabled={blocked} onClick={createText}>新建文本比较</button><button disabled={blocked} onClick={() => open('single')}>打开文件</button><button disabled={blocked} onClick={() => open('pair')}>比较两个文件</button></div><div className="empty-drop"><span>也可以将文本文件拖到这里</span></div><div className="cli-hint"><strong>接收 Agent 修改</strong><p>使用随附的 diffeditor 命令提交修改提案，在这里审核并保存。</p><code>diffeditor baseline paper.tex</code></div></div>}
    </main>
    {dragging && <div className="drop-overlay" onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); setDragging(false); }}><div className="drop-choice" data-testid="drop-single" onDrop={e => drop(e, 'single')}><strong>单文件编辑</strong><span>每个文件各开一项审核，两侧从相同内容开始</span></div><div className="drop-choice" data-testid="drop-pair" onDrop={e => drop(e, 'pair')}><strong>双文件比较</strong><span>拖入两个文件，原稿与新稿分别保存</span></div></div>}
    {deletePrompt && <div className="modal-backdrop"><section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" data-testid="delete-dialog"><h2 id="delete-dialog-title">{deletePrompt.closedOnly ? `删除全部 ${deletePrompt.reviews.length} 项已关闭比较？` : '删除比较？'}</h2>{deletePrompt.closedOnly ? <ul className="delete-review-list">{deletePrompt.reviews.map(r => <li key={r.id}>{r.title}</li>)}</ul> : <p className="delete-title">{deletePrompt.reviews[0].title}</p>}<p>这将删除应用中的{deletePrompt.closedOnly ? '这些比较' : '这项比较'}和两侧缓存草稿，无法恢复。真实文件及备份文件不会删除。</p>{error && <p role="alert" className="pane-error">{error}</p>}<footer><button data-testid="cancel-delete" autoFocus disabled={busy} onClick={() => setDeletePrompt(undefined)}>取消</button><button data-testid="confirm-delete" disabled={busy} onClick={confirmDelete}>{busy ? '正在删除…' : deletePrompt.closedOnly ? `删除这 ${deletePrompt.reviews.length} 项` : '删除比较'}</button></footer></section></div>}
    {preview && <div className="modal-backdrop"><section className="save-dialog" role="dialog" aria-modal="true" aria-labelledby="save-dialog-title" data-testid="save-dialog"><header><h2 id="save-dialog-title">确认保存{labels[preview.preview.side]}</h2><button data-testid="cancel-save" aria-label="取消保存" disabled={busy} onClick={() => setPreview(undefined)}>×</button></header><dl className="save-details"><dt>目标文件</dt><dd data-testid="preview-target">{preview.preview.targetPath}</dd><dt>备份文件</dt><dd data-testid="preview-backup">{preview.preview.backupPath || (preview.preview.isNew ? '新建文件，无旧文件需要备份' : '没有备份路径')}</dd><dt>文件编码</dt><dd>{encodings[preview.preview.encoding]}</dd></dl><div className="preview-caption">本次将写入的完整内容<span>{preview.text.length.toLocaleString()} 个字符</span></div><pre data-testid="preview-text" className="frozen-text">{preview.text || <span className="muted">（空文件）</span>}</pre><footer><span>确认后写入目标文件；已有内容先备份。</span><button disabled={busy} onClick={() => setPreview(undefined)}>取消</button><button data-testid="confirm-save" className="primary" disabled={busy} onClick={() => void action(async () => { try { await window.diffEditor.commitSave(preview.preview.token); } catch (e) { setPreview(undefined); await refresh(); throw e; } setPreview(undefined); await refresh(); }, true)}>{busy ? '正在保存…' : '确认并保存'}</button></footer></section></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
