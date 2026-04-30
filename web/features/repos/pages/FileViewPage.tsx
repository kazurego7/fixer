import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Page, PageContent } from 'framework7-react';
import { useAppCtx } from '../../../app/AppContext';
import { formatChangeKindLabel } from '../changeKindLabel';
import {
  FILE_VIEW_DIFF_JUMP_TOP_OFFSET_PX,
  FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX,
  FILE_VIEW_VIRTUAL_OVERSCAN,
  FILE_VIEW_VIRTUALIZE_THRESHOLD,
  buildFileRenderLines,
  findVirtualLineIndex
} from '../fileViewModel';
import { getCurrentFileParams } from '../../../app/navigation';

export function FileViewPage() {
  const { selectedFileView, selectedFileViewLoading, selectedFileViewError, fileListItems, openRepoFile, returnFromFileView } = useAppCtx();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastJumpKeyRef = useRef('');
  const pendingVirtualJumpIndexRef = useRef<number | null>(null);
  const pendingVirtualJumpKeyRef = useRef('');
  const pendingVirtualJumpAlignRef = useRef<'top' | 'center' | null>(null);
  const virtualLineHeightsRef = useRef<Record<number, number>>({});
  const virtualLineObserverCleanupRef = useRef<Map<number, () => void>>(new Map());
  const params = getCurrentFileParams();
  const diffItems = fileListItems.filter((item) => item.hasDiff);
  const currentPath = selectedFileView?.path || params.path;
  const currentDiffIndex = diffItems.findIndex((item) => item.path === currentPath);
  const previousDiffPath =
    currentDiffIndex >= 0
      ? diffItems[(currentDiffIndex - 1 + diffItems.length) % diffItems.length]?.path || null
      : diffItems[diffItems.length - 1]?.path || null;
  const nextDiffPath =
    currentDiffIndex >= 0 ? diffItems[(currentDiffIndex + 1) % diffItems.length]?.path || null : diffItems[0]?.path || null;
  const renderLines = useMemo(
    () => buildFileRenderLines(selectedFileView?.content || '', selectedFileView?.diff || ''),
    [selectedFileView?.content, selectedFileView?.diff]
  );
  const [contentScrollTop, setContentScrollTop] = useState(0);
  const [contentViewportHeight, setContentViewportHeight] = useState(0);
  const [virtualMetricsVersion, setVirtualMetricsVersion] = useState(0);
  const fileTitle = currentPath ? currentPath.split('/').filter(Boolean).pop() || currentPath : 'ファイル未選択';
  const canPreviewImage = Boolean(selectedFileView?.imageDataUrl && selectedFileView?.mimeType?.startsWith('image/'));
  const canVirtualizeLines = Boolean(
    selectedFileView &&
      !selectedFileView.isDeleted &&
      !canPreviewImage &&
      !selectedFileView.isBinary &&
      renderLines.length > FILE_VIEW_VIRTUALIZE_THRESHOLD
  );
  const setVirtualLineHeight = useCallback((index: number, nextHeight: number) => {
    if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
    const normalizedHeight = Math.max(FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX, Math.ceil(nextHeight));
    const currentHeight = virtualLineHeightsRef.current[index];
    if (currentHeight && Math.abs(currentHeight - normalizedHeight) < 1) return;
    virtualLineHeightsRef.current[index] = normalizedHeight;
    setVirtualMetricsVersion((value) => value + 1);
  }, []);
  const bindVirtualLineNode = useCallback(
    (index: number, node: HTMLDivElement | null) => {
      const cleanupMap = virtualLineObserverCleanupRef.current;
      cleanupMap.get(index)?.();
      cleanupMap.delete(index);
      if (!canVirtualizeLines || !node) return;
      const measure = () => setVirtualLineHeight(index, node.getBoundingClientRect().height);
      measure();
      if (typeof ResizeObserver !== 'function') return;
      const observer = new ResizeObserver(() => measure());
      observer.observe(node);
      cleanupMap.set(index, () => observer.disconnect());
    },
    [canVirtualizeLines, setVirtualLineHeight]
  );
  const virtualLineHeights = useMemo(() => {
    if (!canVirtualizeLines) return [] as number[];
    return renderLines.map((_, index) => virtualLineHeightsRef.current[index] || FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX);
  }, [canVirtualizeLines, renderLines, virtualMetricsVersion]);
  const virtualLineOffsets = useMemo(() => {
    if (!canVirtualizeLines) return [0];
    const offsets = [0];
    for (const height of virtualLineHeights) {
      offsets.push((offsets[offsets.length - 1] ?? 0) + height);
    }
    return offsets;
  }, [canVirtualizeLines, virtualLineHeights]);
  const virtualRange = useMemo(() => {
    if (!canVirtualizeLines) {
      return { start: 0, end: renderLines.length };
    }
    const pendingJumpIndex = pendingVirtualJumpIndexRef.current;
    if (pendingJumpIndex != null) {
      return {
        start: Math.max(0, pendingJumpIndex - FILE_VIEW_VIRTUAL_OVERSCAN),
        end: Math.min(renderLines.length, pendingJumpIndex + FILE_VIEW_VIRTUAL_OVERSCAN + 1)
      };
    }
    const viewportHeight = Math.max(contentViewportHeight, FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX);
    const overscanHeight = FILE_VIEW_VIRTUAL_OVERSCAN * FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX;
    const start = findVirtualLineIndex(virtualLineOffsets, Math.max(0, contentScrollTop - overscanHeight));
    const end = Math.min(
      renderLines.length,
      findVirtualLineIndex(virtualLineOffsets, contentScrollTop + viewportHeight + overscanHeight) + 1
    );
    return { start, end };
  }, [canVirtualizeLines, contentScrollTop, contentViewportHeight, renderLines.length, virtualLineOffsets]);
  const visibleRenderLines = useMemo(() => renderLines.slice(virtualRange.start, virtualRange.end), [renderLines, virtualRange.end, virtualRange.start]);
  const topSpacerHeight = canVirtualizeLines ? virtualLineOffsets[virtualRange.start] || 0 : 0;
  const bottomSpacerHeight = canVirtualizeLines
    ? Math.max(0, (virtualLineOffsets[renderLines.length] || 0) - (virtualLineOffsets[virtualRange.end] || 0))
    : 0;
  const diffJumpBottomSpacerHeight =
    params.jumpToFirstDiff || pendingVirtualJumpAlignRef.current === 'top'
      ? Math.max(0, contentViewportHeight - FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX)
      : 0;

  useLayoutEffect(() => {
    if (!contentRef.current) return;
    const measure = () => {
      if (!contentRef.current) return;
      setContentViewportHeight(contentRef.current.clientHeight);
      setContentScrollTop(contentRef.current.scrollTop);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(contentRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [selectedFileView?.path]);

  useEffect(() => {
    virtualLineObserverCleanupRef.current.forEach((cleanup) => cleanup());
    virtualLineObserverCleanupRef.current.clear();
    virtualLineHeightsRef.current = {};
    pendingVirtualJumpIndexRef.current = null;
    pendingVirtualJumpKeyRef.current = '';
    pendingVirtualJumpAlignRef.current = null;
    setVirtualMetricsVersion((value) => value + 1);
  }, [selectedFileView?.path]);

  useEffect(() => {
    if (!contentRef.current || !selectedFileView?.path) return;
    const shouldJumpToFirstDiff = !params.line && params.jumpToFirstDiff;
    const firstDiffIndex = shouldJumpToFirstDiff ? renderLines.findIndex((line) => line.kind !== 'context') : -1;
    const targetLineNumber = shouldJumpToFirstDiff
      ? firstDiffIndex >= 0
        ? renderLines[firstDiffIndex]?.newLine ?? renderLines[firstDiffIndex]?.oldLine ?? null
        : null
      : params.line;
    if (!targetLineNumber) return;
    const jumpKey = `${selectedFileView.path}:${shouldJumpToFirstDiff ? `first-diff:${firstDiffIndex}` : `line:${targetLineNumber}`}`;
    if (lastJumpKeyRef.current === jumpKey) return;
    const targetIndex = shouldJumpToFirstDiff
      ? firstDiffIndex
      : renderLines.findIndex((line) => line.newLine === targetLineNumber || line.oldLine === targetLineNumber);
    if (targetIndex < 0) return;
    const container = contentRef.current;
    if (!canVirtualizeLines) {
      pendingVirtualJumpIndexRef.current = null;
      pendingVirtualJumpKeyRef.current = '';
      pendingVirtualJumpAlignRef.current = null;
      let rafId = 0;
      const applyNonVirtualJump = () => {
        const targetNode = shouldJumpToFirstDiff
          ? container.querySelector('.fx-file-line.is-removed, .fx-file-line.is-added')
          : container.querySelector(`[data-file-render-index="${targetIndex}"]`);
        if (!(targetNode instanceof HTMLElement)) return false;
        const containerRect = container.getBoundingClientRect();
        const targetRect = targetNode.getBoundingClientRect();
        const targetAbsoluteTop = container.scrollTop + (targetRect.top - containerRect.top);
        const targetTop = shouldJumpToFirstDiff
          ? Math.max(0, targetAbsoluteTop - FILE_VIEW_DIFF_JUMP_TOP_OFFSET_PX)
          : Math.max(0, targetAbsoluteTop - Math.max(0, Math.floor((container.clientHeight - targetNode.offsetHeight) / 2)));
        container.scrollTop = targetTop;
        setContentScrollTop(targetTop);
        return true;
      };
      if (applyNonVirtualJump()) {
        lastJumpKeyRef.current = jumpKey;
        rafId = window.requestAnimationFrame(() => {
          applyNonVirtualJump();
        });
      }
      return () => {
        if (rafId) window.cancelAnimationFrame(rafId);
      };
    }
    if (canVirtualizeLines) {
      const targetHeight = virtualLineHeights[targetIndex] || FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX;
      const targetOffset = virtualLineOffsets[targetIndex] || 0;
      const targetTop = shouldJumpToFirstDiff
        ? Math.max(0, targetOffset - FILE_VIEW_DIFF_JUMP_TOP_OFFSET_PX)
        : Math.max(0, targetOffset - Math.max(0, Math.floor((container.clientHeight - targetHeight) / 2)));
      container.scrollTop = targetTop;
      setContentScrollTop(targetTop);
      pendingVirtualJumpIndexRef.current = targetIndex;
      pendingVirtualJumpKeyRef.current = jumpKey;
      pendingVirtualJumpAlignRef.current = shouldJumpToFirstDiff ? 'top' : 'center';
      lastJumpKeyRef.current = jumpKey;
      return;
    }
  }, [canVirtualizeLines, params.jumpToFirstDiff, params.line, renderLines, selectedFileView?.path, virtualLineHeights, virtualLineOffsets]);

  useLayoutEffect(() => {
    if (!canVirtualizeLines || !contentRef.current) return;
    const targetIndex = pendingVirtualJumpIndexRef.current;
    const targetKey = pendingVirtualJumpKeyRef.current;
    const jumpAlign = pendingVirtualJumpAlignRef.current;
    if (targetIndex == null || !targetKey || targetKey !== lastJumpKeyRef.current) return;
    if (targetIndex < virtualRange.start || targetIndex >= virtualRange.end) return;
    const targetNode = contentRef.current.querySelector(`[data-file-render-index="${targetIndex}"]`);
    if (!(targetNode instanceof HTMLElement)) return;
    const container = contentRef.current;
    const containerRect = container.getBoundingClientRect();
    const targetRect = targetNode.getBoundingClientRect();
    const targetAbsoluteTop = container.scrollTop + (targetRect.top - containerRect.top);
    const correctedTop =
      jumpAlign === 'top'
        ? Math.max(0, targetAbsoluteTop - FILE_VIEW_DIFF_JUMP_TOP_OFFSET_PX)
        : Math.max(0, targetAbsoluteTop - Math.max(0, Math.floor((container.clientHeight - targetNode.offsetHeight) / 2)));
    if (Math.abs(container.scrollTop - correctedTop) > 1) {
      container.scrollTop = correctedTop;
      setContentScrollTop(correctedTop);
    }
    pendingVirtualJumpIndexRef.current = null;
    pendingVirtualJumpKeyRef.current = '';
    pendingVirtualJumpAlignRef.current = null;
  }, [canVirtualizeLines, virtualRange.end, virtualRange.start, virtualMetricsVersion]);

  useEffect(() => {
    if (params.line || params.jumpToFirstDiff) return;
    lastJumpKeyRef.current = '';
    pendingVirtualJumpIndexRef.current = null;
    pendingVirtualJumpKeyRef.current = '';
    pendingVirtualJumpAlignRef.current = null;
  }, [params.jumpToFirstDiff, params.line, selectedFileView?.path]);

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-file-view">
        <div className="fx-chat-head">
          <button
            className="fx-back-icon"
            type="button"
            onClick={returnFromFileView}
            data-testid="file-view-back-button"
          >
            ←
          </button>
          <div className="fx-files-title" data-testid="file-view-path">{fileTitle}</div>
        </div>
        <div className="fx-file-view-toolbar">
          <div className="fx-file-view-actions">
            <button
              type="button"
              className="fx-file-nav-btn"
              onClick={() => previousDiffPath && openRepoFile(previousDiffPath, null, false, true)}
              disabled={!previousDiffPath}
              data-testid="file-prev-diff-button"
            >
              前の diff
            </button>
            <button
              type="button"
              className="fx-file-nav-btn"
              onClick={() => nextDiffPath && openRepoFile(nextDiffPath, null, false, true)}
              disabled={!nextDiffPath}
              data-testid="file-next-diff-button"
            >
              次の diff
            </button>
          </div>
        </div>
        <div className="fx-file-view-body">
          {selectedFileViewLoading ? <p className="fx-mini">ファイルを読み込み中...</p> : null}
          {selectedFileViewError ? <p className="fx-mini">読み込み失敗: {selectedFileViewError}</p> : null}
          {!selectedFileViewLoading && !selectedFileViewError && selectedFileView ? (
            <section className={`fx-file-panel${canPreviewImage ? ' is-image-preview' : ''}`} data-testid="file-content-panel">
              <div className="fx-file-panel-head">
                {canPreviewImage ? (
                  <>
                    <span>画像</span>
                    <span className={`fx-file-row-chip is-${selectedFileView.changeKind}`}>
                      {formatChangeKindLabel(selectedFileView.changeKind)}
                    </span>
                  </>
                ) : (
                  <>
                    <span>テキスト</span>
                    <span className={`fx-file-row-chip is-${selectedFileView.changeKind}`}>
                      {formatChangeKindLabel(selectedFileView.changeKind)}
                    </span>
                  </>
                )}
              </div>
              {selectedFileView.isDeleted ? (
                <div className="fx-file-empty">このファイルは削除されています。</div>
              ) : canPreviewImage ? (
                <div className="fx-file-image-wrap" data-testid="file-image-panel">
                  <img
                    src={selectedFileView.imageDataUrl}
                    alt={selectedFileView.path}
                    className="fx-file-image"
                    data-testid="file-image-preview"
                  />
                </div>
              ) : selectedFileView.isBinary ? (
                <div className="fx-file-empty">バイナリファイルの本文表示には未対応です。</div>
              ) : (
                <div
                  className={`fx-file-content is-diff-inline${selectedFileView.hasDiff ? '' : ' is-plain'}`}
                  ref={contentRef}
                  data-testid="file-content"
                  onScroll={(event) => setContentScrollTop(event.currentTarget.scrollTop)}
                >
                  {renderLines.length === 0 ? (
                    <div className="fx-file-empty">内容は空です。</div>
                  ) : (
                    <>
                      {topSpacerHeight > 0 ? <div style={{ height: `${topSpacerHeight}px` }} aria-hidden="true" /> : null}
                      {visibleRenderLines.map((line, visibleIndex) => {
                        const actualIndex = virtualRange.start + visibleIndex;
                        const itemKey = `${selectedFileView.path}:${line.key}:${actualIndex}`;
                        const targetLine = params.line ? line.newLine === params.line || line.oldLine === params.line : false;
                        const displayLine = line.newLine || line.oldLine || undefined;
                        if (!selectedFileView.hasDiff) {
                          return (
                            <div
                              key={itemKey}
                              ref={(node) => bindVirtualLineNode(actualIndex, node)}
                              className={`fx-file-line is-${line.kind}${targetLine ? ' is-target' : ''}`}
                              data-file-line={displayLine}
                              data-file-render-index={actualIndex}
                            >
                              <span className="fx-file-line-no">{displayLine ?? ''}</span>
                              <span className="fx-file-line-text">{line.text || ' '}</span>
                            </div>
                          );
                        }
                        return (
                          <div
                            key={itemKey}
                            ref={(node) => bindVirtualLineNode(actualIndex, node)}
                            className={`fx-file-line is-${line.kind}${targetLine ? ' is-target' : ''}`}
                            data-file-line={displayLine}
                            data-file-render-index={actualIndex}
                          >
                            <span className="fx-file-line-no">{line.oldLine ?? ''}</span>
                            <span className="fx-file-line-no">{line.newLine ?? ''}</span>
                            <span className="fx-file-line-text">{line.text || ' '}</span>
                          </div>
                        );
                      })}
                      {bottomSpacerHeight + diffJumpBottomSpacerHeight > 0 ? (
                        <div style={{ height: `${bottomSpacerHeight + diffJumpBottomSpacerHeight}px` }} aria-hidden="true" />
                      ) : null}
                    </>
                  )}
                </div>
              )}
            </section>
          ) : null}
        </div>
      </PageContent>
    </Page>
  );
}
