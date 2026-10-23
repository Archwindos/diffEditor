import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import './TextOverview.css';

type CodeEditor = monaco.editor.IStandaloneCodeEditor;
export type TextOverviewProps = {
  diff?: monaco.editor.IStandaloneDiffEditor;
  editor?: CodeEditor;
  changes: monaco.editor.ILineChange[];
  originalText: string;
  modifiedText: string;
  retainedSide?: 'left' | 'right';
};
type Metrics = { height: number; mapHeight: number; scrollHeight: number; viewportHeight: number; thumbHeight: number; thumbTop: number };
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
const maxMapScale = .15;

export function TextOverview({ diff, editor, changes, originalText, modifiedText, retainedSide }: TextOverviewProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<CodeEditor | undefined>(undefined);
  const metricsRef = useRef<Metrics>({ height: 0, mapHeight: 0, scrollHeight: 0, viewportHeight: 0, thumbHeight: 0, thumbTop: 0 });
  const dragRef = useRef<{ id: number; offset: number } | undefined>(undefined);
  const redCount = diff ? changes.reduce((sum, change) => sum + (change.originalEndLineNumber ? change.originalEndLineNumber - change.originalStartLineNumber + 1 : 0), 0) : 0;
  const greenCount = diff ? changes.reduce((sum, change) => sum + (change.modifiedEndLineNumber ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1 : 0), 0) : 0;

  useEffect(() => {
    const track = trackRef.current, canvas = canvasRef.current, thumb = thumbRef.current;
    if (!track || !canvas || !thumb) return;
    const target = diff?.getModifiedEditor() ?? editor;
    targetRef.current = target;
    let frame = 0, needsPaint = true, disposed = false;

    const drawLane = (context: CanvasRenderingContext2D, source: CodeEditor | undefined, text: string, x: number, width: number, side?: 'left' | 'right') => {
      const model = source?.getModel();
      const lines = model ? undefined : text.split(/\r\n|\r|\n/);
      const lineCount = model?.getLineCount() ?? lines!.length;
      const scrollHeight = Math.max(source?.getScrollHeight() ?? lineCount * 20 + 12, metricsRef.current.viewportHeight, 1);
      const scale = Math.min(maxMapScale, metricsRef.current.height / scrollHeight);
      const topFor = (line: number) => source ? source.getTopForLineNumber(line, true) : (line - 1) * 20 + 6;
      const bottomFor = (line: number) => source ? source.getBottomForLineNumber(line) : line * 20 + 6;
      const changed = new Set<number>();
      if (side) for (const change of changes) {
        const start = side === 'left' ? change.originalStartLineNumber : change.modifiedStartLineNumber;
        const end = side === 'left' ? change.originalEndLineNumber : change.modifiedEndLineNumber;
        if (!end || start > lineCount) continue;
        const last = Math.min(end, lineCount);
        const top = topFor(start), bottom = bottomFor(last);
        context.fillStyle = side === 'left' ? '#f1d7d9' : '#d3e8d7';
        if (bottom > top) context.fillRect(x, top * scale, width, Math.max(1.5, (bottom - top) * scale));
        for (let line = start; line <= last; line++) changed.add(line);
      }
      // One short stroke per wrapped visual row preserves the shape of the text.
      for (let line = 1; line <= lineCount; line++) {
        const content = model?.getLineContent(line) ?? lines![line - 1];
        if (!content.trim()) continue;
        const top = topFor(line), bottom = bottomFor(line);
        if (bottom <= top) continue; // Folded lines have no visual height.
        const lineHeight = source?.getOption(monaco.editor.EditorOption.lineHeight) ?? 20;
        const rows = Math.max(1, Math.round((bottom - top) / lineHeight));
        const indent = Math.min(content.search(/\S/) * .13, width * .3);
        const length = Math.min(width - indent, Math.max(1.5, content.trimEnd().length * .13 / rows));
        context.fillStyle = changed.has(line) ? side === 'left' ? '#c9767c' : '#6b9f77' : '#a6b2bc';
        for (let row = 0; row < rows; row++) {
          const y = (top + row * lineHeight) * scale;
          context.fillRect(x + indent, y, length, Math.max(.7, Math.min(1.4, lineHeight * scale * .5)));
        }
      }
    };

    const update = () => {
      frame = 0;
      if (disposed) return;
      const { width, height } = track.getBoundingClientRect();
      const viewportHeight = target?.getLayoutInfo().height ?? height;
      const scrollHeight = Math.max(target?.getScrollHeight() ?? height, viewportHeight, 1);
      const mapHeight = Math.min(height, scrollHeight * maxMapScale);
      const thumbHeight = Math.min(mapHeight, Math.max(20, mapHeight * viewportHeight / scrollHeight));
      const scrollTop = target?.getScrollTop() ?? 0;
      const scrollMax = Math.max(0, scrollHeight - viewportHeight);
      const thumbTop = scrollMax ? clamp(scrollTop / scrollMax, 1) * (mapHeight - thumbHeight) : 0;
      metricsRef.current = { height, mapHeight, scrollHeight, viewportHeight, thumbHeight, thumbTop };
      thumb.style.display = scrollMax ? '' : 'none';
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${thumbTop}px)`;
      track.setAttribute('aria-valuemax', String(Math.round(scrollMax)));
      track.setAttribute('aria-valuenow', String(Math.round(scrollTop)));
      track.setAttribute('aria-disabled', String(!target || !scrollMax));
      if (!needsPaint || !width || !height) return;
      needsPaint = false;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (diff) {
        const laneWidth = (width - 9) / 2;
        drawLane(context, diff.getOriginalEditor(), originalText, 3, laneWidth, 'left');
        drawLane(context, target, modifiedText, 6 + laneWidth, laneWidth, 'right');
      } else drawLane(context, target, retainedSide === 'left' ? originalText : modifiedText, 4, width - 8);
    };
    const schedule = (paint = false) => {
      needsPaint ||= paint;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const repaint = () => schedule(true);
    const subscriptions: monaco.IDisposable[] = [];
    for (const source of diff ? [diff.getOriginalEditor(), diff.getModifiedEditor()] : target ? [target] : []) {
      subscriptions.push(
        source.onDidScrollChange(event => schedule(event.scrollHeightChanged)),
        source.onDidLayoutChange(repaint),
        source.onDidContentSizeChange(repaint),
        source.onDidChangeModelContent(repaint),
        source.onDidChangeModel(repaint),
        source.onDidChangeConfiguration(repaint),
        source.onDidChangeHiddenAreas(repaint),
      );
    }
    if (diff) subscriptions.push(diff.onDidUpdateDiff(repaint));
    const observer = new ResizeObserver(repaint);
    observer.observe(track);
    const wheel = (event: WheelEvent) => {
      if (!target || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? target.getLayoutInfo().height : 1;
      target.setScrollTop(target.getScrollTop() + event.deltaY * unit);
    };
    track.addEventListener('wheel', wheel, { passive: false });
    schedule(true);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      subscriptions.forEach(subscription => subscription.dispose());
      track.removeEventListener('wheel', wheel);
      targetRef.current = undefined;
      dragRef.current = undefined;
    };
  }, [diff, editor, changes, originalText, modifiedText, retainedSide]);

  const scrollToPointer = (clientY: number) => {
    const target = targetRef.current, track = trackRef.current, drag = dragRef.current;
    if (!target || !track || !drag) return;
    const { mapHeight, thumbHeight, scrollHeight, viewportHeight } = metricsRef.current;
    const travel = mapHeight - thumbHeight;
    const position = clientY - track.getBoundingClientRect().top - drag.offset;
    target.setScrollTop(travel > 0 ? clamp(position / travel, 1) * Math.max(0, scrollHeight - viewportHeight) : 0);
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.removeAttribute('data-dragging');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div className="text-overview" data-testid="text-overview" data-red-count={redCount} data-green-count={greenCount}
    ref={trackRef} role="scrollbar" tabIndex={0} aria-label="全文概览，拖动浏览文本" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={0} aria-valuenow={0}
    onPointerDown={event => {
      if (event.button !== 0 || !targetRef.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
      const { thumbTop, thumbHeight } = metricsRef.current;
      dragRef.current = { id: event.pointerId, offset: y >= thumbTop && y <= thumbTop + thumbHeight ? y - thumbTop : thumbHeight / 2 };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.setAttribute('data-dragging', 'true');
      scrollToPointer(event.clientY);
    }}
    onPointerMove={event => { if (dragRef.current?.id === event.pointerId) scrollToPointer(event.clientY); }}
    onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onKeyDown={event => {
      const target = targetRef.current;
      if (!target) return;
      const page = target.getLayoutInfo().height;
      const positions: Record<string, number> = {
        ArrowUp: target.getScrollTop() - 20, ArrowDown: target.getScrollTop() + 20,
        PageUp: target.getScrollTop() - page, PageDown: target.getScrollTop() + page,
        Home: 0, End: target.getScrollHeight(),
      };
      if (!(event.key in positions)) return;
      event.preventDefault();
      event.stopPropagation();
      target.setScrollTop(positions[event.key]);
    }}>
    <canvas ref={canvasRef} data-testid="overview-canvas" aria-hidden="true" />
    <div ref={thumbRef} className="overview-viewport" data-testid="overview-viewport" aria-hidden="true" />
  </div>;
}
