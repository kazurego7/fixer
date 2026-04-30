import { Fragment, useEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Page, PageContent } from 'framework7-react';
import type { UserInputDraft } from '../../../../shared/types';
import { renderAssistant } from '../assistantRender';
import { useAppCtx } from '../../../app/AppContext';
import { resolveRepoRelativeFilePath } from '../../../app/navigation';
import { formatFileSize, formatIssueStatus, outputItemTurnId } from '../../../lib/appUtils';

export function ChatPage() {
  const EXPANDED_COMPOSER_MAX_HEIGHT = 140;
  const {
    connected,
    busy,
    chatVisible,
    navigate,
    activeRepoFullName,
    activeThreadId,
    message,
    setMessage,
    pendingAttachments,
    addImageAttachments,
    removePendingAttachment,
    outputItems,
    outputRef,
    streaming,
    streamingAssistantId,
    liveReasoningText,
    compactionStatusPhase,
    compactionStatusMessage,
    awaitingFirstStreamChunk,
    hasReasoningStarted,
    hasAnswerStarted,
    sendTurn,
    cancelTurn,
    startNewThread,
    canReturnToPreviousThread,
    returnToPreviousThread,
    goBackToRepoList,
    canApplyLatestPlan,
    applyLatestPlanShortcut,
    chatSettingsOpen,
    openChatSettings,
    closeChatSettings,
    availableModels,
    modelsLoading,
    modelsError,
    loadAvailableModels,
    activeRepoModel,
    setActiveRepoModel,
    gitStatus,
    gitStatusLoading,
    gitStatusError,
    requestGitCommitPush,
    openRepoFile,
    activeCollaborationMode,
    setActiveCollaborationMode,
    pendingUserInputRequests,
    selectUserInputOption,
    pendingUserInputBusy,
    pendingUserInputDrafts,
    issueItems,
    issuePanelOpen,
    issueLoading,
    issueError,
    openIssuePanel,
    closeIssuePanel,
    markTurnBad,
    badMarkerBusy,
    markedBadTurnIds,
    useIssuePrompt,
    resolveIssue
  } = useAppCtx();
  const hasComposerInput = message.trim().length > 0 || pendingAttachments.length > 0;
  const canSend = hasComposerInput;
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const userInputCardRef = useRef<HTMLDivElement | null>(null);
  const swipeStartXRef = useRef<number | null>(null);
  const swipeStartYRef = useRef<number | null>(null);
  const displayItems = outputItems;
  const latestPlanItemId = useMemo(() => {
    for (let idx = displayItems.length - 1; idx >= 0; idx -= 1) {
      const item = displayItems[idx];
      if (!item || (item.role !== 'assistant' && item.role !== 'user')) continue;
      if (item.role !== 'assistant') return '';
      const planText = typeof item.plan === 'string' ? item.plan.trim() : '';
      return planText ? String(item.id || '') : '';
    }
    return '';
  }, [displayItems]);
  const thinkingText = typeof liveReasoningText === 'string' ? liveReasoningText : '';
  const activeUserInputRequest = pendingUserInputRequests.length > 0 ? pendingUserInputRequests[0] : null;
  const activeUserInputDraftState: UserInputDraft = activeUserInputRequest
    ? pendingUserInputDrafts[String(activeUserInputRequest.requestId)] || { index: 0, answers: {} }
    : { index: 0, answers: {} };
  const activeUserInputIndex = Number(activeUserInputDraftState.index || 0);
  const activeUserInputQuestion = activeUserInputRequest
    ? (activeUserInputRequest.questions || [])[activeUserInputIndex] || null
    : null;
  const answeredUserInputCount = activeUserInputRequest ? Math.min(activeUserInputIndex, (activeUserInputRequest.questions || []).length) : 0;
  const hideThinkingWhileUserInput = Boolean(activeUserInputRequest && activeUserInputQuestion);
  const showInitialLoading = streaming && awaitingFirstStreamChunk && !hideThinkingWhileUserInput;
  const showThinkingWorking = streaming && hasReasoningStarted && !hideThinkingWhileUserInput;
  const showCompactionStatus = streaming && Boolean(compactionStatusMessage) && !hideThinkingWhileUserInput;
  const previewAttachment =
    previewIndex !== null && previewIndex >= 0 && previewIndex < pendingAttachments.length
      ? pendingAttachments[previewIndex]
      : null;
  const canGoPrev = previewIndex !== null && previewIndex > 0;
  const canGoNext = previewIndex !== null && previewIndex < pendingAttachments.length - 1;
  const activeModelLabel = useMemo(() => {
    if (!activeRepoModel) return '未設定';
    const hit = availableModels.find((item) => item.id === activeRepoModel);
    return hit?.name || activeRepoModel;
  }, [availableModels, activeRepoModel]);
  const gitStatusSummary = gitStatusLoading
    ? 'Git 状態を確認中...'
    : gitStatusError
      ? `Git 状態取得失敗: ${gitStatusError}`
      : gitStatus?.summary || 'Git 状態を確認できません';
  const gitStatusTone = gitStatusError ? 'danger' : gitStatus?.tone || 'neutral';
  const canRequestGitCommitPush = Boolean(
    !busy &&
      !streaming &&
      !gitStatusLoading &&
      !gitStatusError &&
      gitStatus?.actionRecommended
  );
  const canOpenFiles = Boolean(activeRepoFullName);
  const openIssueCount = issueItems.filter((item) => item.status !== 'resolved').length;
  const isComposerExpanded = isInputFocused;
  const chatScrollPaddingBottom = Math.max(78, composerHeight + keyboardInset + 12);
  const composerInlineStyle = keyboardInset > 0 ? { bottom: `${keyboardInset}px` } : undefined;

  function handleChatContentClick(event: React.MouseEvent<HTMLElement>): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const rawHref = String(anchor.getAttribute('href') || '').trim();
    if (!rawHref) return;

    const repoPath = String(gitStatus?.repoPath || '').trim();
    if (repoPath) {
      const localFile = resolveRepoRelativeFilePath(rawHref, repoPath);
      if (localFile?.path) {
        event.preventDefault();
        void openRepoFile(localFile.path, localFile.line);
        return;
      }
    }

    if (/^(https?:|mailto:|tel:)/i.test(rawHref)) {
      event.preventDefault();
      window.open(anchor.href, '_blank', 'noopener,noreferrer');
    }
  }

  function syncComposerLayout(
    target: HTMLTextAreaElement | null = composerInputRef.current,
    options: { expanded?: boolean } = {}
  ): void {
    if (typeof window === 'undefined') return;
    if (!(target instanceof HTMLTextAreaElement)) return;
    const expanded = typeof options.expanded === 'boolean' ? options.expanded : isComposerExpanded;
    const viewportHeight = window.visualViewport?.height || window.innerHeight || 0;
    const minHeight = expanded ? 104 : 36;
    const composerStyles = window.getComputedStyle(target);
    const borderTop = Number.parseFloat(composerStyles.borderTopWidth || '0') || 0;
    const borderBottom = Number.parseFloat(composerStyles.borderBottomWidth || '0') || 0;
    const borderHeight = borderTop + borderBottom;
    const maxHeight = expanded ? EXPANDED_COMPOSER_MAX_HEIGHT : Math.max(120, Math.floor(viewportHeight * 0.18));
    target.style.height = 'auto';
    const nextHeight = Math.max(target.scrollHeight + borderHeight, minHeight);
    const appliedHeight = Math.min(nextHeight, maxHeight);
    target.style.height = `${appliedHeight}px`;
    target.style.overflowY = target.scrollHeight + borderHeight > appliedHeight ? 'auto' : 'hidden';
  }

  function syncComposerMetrics(): void {
    syncComposerLayout(undefined, { expanded: isComposerExpanded });
    const node = composerRef.current;
    if (!(node instanceof HTMLElement)) return;
    const nextHeight = Math.ceil(node.getBoundingClientRect().height);
    setComposerHeight((prev) => (Math.abs(prev - nextHeight) < 1 ? prev : nextHeight));
  }

  const keepComposerFocus = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('.fx-attachments-bar')) return;
    if (target.closest('textarea,button,input,select,a,[role="button"]')) return;
    event.preventDefault();
    composerInputRef.current?.focus();
  };
  const handleComposerInputBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    const next = event.relatedTarget;
    if (next instanceof HTMLElement && next.closest('.fx-mode-toggle')) return;
    setIsInputFocused(false);
  };
  const closePreview = () => setPreviewIndex(null);
  const openPreviewAt = (idx: number) => {
    if (idx < 0 || idx >= pendingAttachments.length) return;
    setPreviewIndex(idx);
  };
  const showPrevPreview = () => {
    setPreviewIndex((prev) => {
      if (prev === null || prev <= 0) return prev;
      return prev - 1;
    });
  };
  const showNextPreview = () => {
    setPreviewIndex((prev) => {
      if (prev === null || prev >= pendingAttachments.length - 1) return prev;
      return prev + 1;
    });
  };
  const onPreviewPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    swipeStartXRef.current = event.clientX;
    swipeStartYRef.current = event.clientY;
  };
  const onPreviewPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (swipeStartXRef.current === null || swipeStartYRef.current === null) return;
    const dx = event.clientX - swipeStartXRef.current;
    const dy = event.clientY - swipeStartYRef.current;
    swipeStartXRef.current = null;
    swipeStartYRef.current = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx < 0) showNextPreview();
    else showPrevPreview();
  };
  const onPreviewPointerCancel = () => {
    swipeStartXRef.current = null;
    swipeStartYRef.current = null;
  };

  useEffect(() => {
    if (connected && !chatVisible) navigate('/repos/', true);
  }, [connected, chatVisible, navigate]);

  useEffect(() => {
    if (previewIndex === null) return;
    if (pendingAttachments.length === 0) {
      setPreviewIndex(null);
      return;
    }
    if (previewIndex > pendingAttachments.length - 1) {
      setPreviewIndex(pendingAttachments.length - 1);
    }
  }, [previewIndex, pendingAttachments.length]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const rafId = window.requestAnimationFrame(syncComposerMetrics);
    return () => window.cancelAnimationFrame(rafId);
  }, [
    message,
    pendingAttachments.length,
    isInputFocused,
    streaming,
    activeUserInputRequest?.requestId,
    activeUserInputQuestion?.id
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const node = composerRef.current;
    if (!(node instanceof HTMLElement) || typeof ResizeObserver === 'undefined') {
      syncComposerMetrics();
      return;
    }
    const observer = new ResizeObserver(() => syncComposerMetrics());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const syncViewportInset = () => {
      // offsetTop は表示領域のパン量であり、キーボード高ではない。
      const nextInset = Math.max(0, Math.round(window.innerHeight - viewport.height));
      setKeyboardInset((prev) => (Math.abs(prev - nextInset) < 1 ? prev : nextInset));
    };
    syncViewportInset();
    viewport.addEventListener('resize', syncViewportInset);
    viewport.addEventListener('scroll', syncViewportInset);
    window.addEventListener('resize', syncViewportInset);
    return () => {
      viewport.removeEventListener('resize', syncViewportInset);
      viewport.removeEventListener('scroll', syncViewportInset);
      window.removeEventListener('resize', syncViewportInset);
    };
  }, []);

  useEffect(() => {
    if (previewIndex === null) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePreview();
        return;
      }
      if (event.key === 'ArrowLeft') {
        showPrevPreview();
        return;
      }
      if (event.key === 'ArrowRight') {
        showNextPreview();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewIndex, pendingAttachments.length]);

  useEffect(() => {
    if (!activeUserInputRequest || !activeUserInputQuestion) return;
    const node = userInputCardRef.current;
    if (!(node instanceof HTMLElement)) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeUserInputRequest?.requestId, activeUserInputQuestion?.id]);

  if (!chatVisible) {
    return (
      <Page noNavbar>
        <PageContent className="fx-page">
          <p className="fx-mini">接続を準備しています...</p>
        </PageContent>
      </Page>
    );
  }

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-chat">
        <div className="fx-chat-head">
          <button
            className="fx-back-icon"
            type="button"
            onClick={goBackToRepoList}
            data-testid="back-button"
          >
            ←
          </button>
          <button
            className="fx-repo-pill fx-repo-pill-btn"
            type="button"
            onClick={openChatSettings}
            data-testid="chat-settings-trigger"
            aria-label="チャット設定を開く"
            title="チャット設定"
          >
            <span className="fx-repo-pill-text">{activeRepoFullName}</span>
            <span className="fx-repo-pill-gear" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                <path
                  d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37c.996 -1.636 .04 -2.433 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1.636 .996 2.433 .04 2.572 -1.065z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" stroke="currentColor" strokeWidth="1.7" />
              </svg>
            </span>
          </button>
          <button
            className="fx-git-action-icon"
            type="button"
            onClick={requestGitCommitPush}
            disabled={!canRequestGitCommitPush}
            aria-label="Codex にコミットと push を依頼"
            title="Codex にコミットと push を依頼"
            data-testid="git-commit-push-button"
          >
            <svg
              className="fx-git-action-icon-svg"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M6 4.5H16.5L19.5 7.5V19.5H4.5V6A1.5 1.5 0 0 1 6 4.5Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M8 4.5V10H15V4.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M8 19.5V14.5A1 1 0 0 1 9 13.5H15A1 1 0 0 1 16 14.5V19.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M10 16.5H14"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="fx-git-action-icon fx-issue-nav-button"
            type="button"
            onClick={openIssuePanel}
            aria-label="課題一覧"
            title="課題一覧"
            data-testid="issues-open-button"
          >
            <span className="fx-issue-nav-mark" aria-hidden="true">!</span>
            {openIssueCount > 0 ? (
              <span className="fx-issue-nav-count" data-testid="issues-count">
                {openIssueCount}
              </span>
            ) : null}
          </button>
        </div>
        <button
          type="button"
          className={`fx-git-status-line is-${gitStatusTone}`}
          data-testid="git-status-line"
          title={gitStatusSummary}
          onClick={() => navigate('/files/')}
          disabled={!canOpenFiles}
        >
          <span className="fx-git-status-dot" aria-hidden="true" />
          <span className="fx-git-status-text">{gitStatusSummary}</span>
          {gitStatus?.branch ? <span className="fx-git-status-branch">{gitStatus.branch}</span> : null}
          <span className="fx-git-status-chevron" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M7.5 4.5L12.5 10L7.5 15.5"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>

        <article
          className="fx-chat-scroll"
          ref={outputRef}
          style={{ paddingBottom: `${chatScrollPaddingBottom}px` }}
          onClick={handleChatContentClick}
        >
          {displayItems.map((item) => {
            if (item.role !== 'assistant' && item.role !== 'user') {
              return (
                <div key={item.id} className="fx-msg fx-msg-system">
                  <div className="fx-msg-bubble">
                    <pre className="fx-system-line">{String(item.text || '')}</pre>
                  </div>
                </div>
              );
            }
            if (item.role === 'assistant' && streaming && item.id === streamingAssistantId) {
              const currentAnswer = typeof item.answer === 'string' ? item.answer : String(item.text || '');
              const currentPlan = typeof item.plan === 'string' ? item.plan.trim() : '';
              const currentStatus = !currentAnswer ? String(item.status || item.text || '').trim() : '';
              if (!currentAnswer.trim() && !currentStatus.trim() && !currentPlan) return null;
            }
            if (item.role === 'assistant') {
              const planText = typeof item.plan === 'string' ? item.plan.trim() : '';
              const assistantMain = renderAssistant(item, streaming && item.id === streamingAssistantId);
              const showPlanApply = Boolean(planText && canApplyLatestPlan && String(item.id || '') === latestPlanItemId);
              const assistantTurnId = outputItemTurnId(item);
              const isStreamingAssistant = Boolean(streaming && item.id === streamingAssistantId);
              const assistantMarkedBad = Boolean(assistantTurnId && markedBadTurnIds.includes(assistantTurnId));
              const showBadMarker = Boolean(assistantTurnId && !isStreamingAssistant);
              const showAssistantCard = Boolean(assistantMain || planText || showPlanApply);
              return (
                <Fragment key={item.id}>
                  {showAssistantCard ? (
                    <div className="fx-msg fx-msg-assistant">
                      <div className="fx-msg-bubble">
                        {assistantMain}
                        {planText ? (
                          <div className="fx-plan-inline-block" data-testid="plan-inline-block">
                            <div className="fx-plan-bubble-title">プラン</div>
                            <pre className="fx-plan-bubble-content">{planText}</pre>
                          </div>
                        ) : null}
                        {showPlanApply ? (
                          <>
                            <div className="fx-plan-apply-row">
                              <button
                                className="fx-plan-apply-inline-btn"
                                type="button"
                                onClick={applyLatestPlanShortcut}
                                disabled={busy}
                                data-testid="plan-apply-button"
                                aria-label="プランを実現"
                                title="プランを実現"
                              >
                                プランを実現
                              </button>
                            </div>
                            <div className="fx-plan-apply-help-note" data-testid="plan-edit-help">
                              ※ プランを修正する場合は、下の入力欄に修正内容や質問を入力して送信してください。
                            </div>
                          </>
                        ) : null}
                        {showBadMarker ? (
                          <div className="fx-message-action-row">
                            <button
                              type="button"
                              className={`fx-message-bad-button${assistantMarkedBad ? ' is-marked' : ''}`}
                              onClick={() => markTurnBad(assistantTurnId)}
                              disabled={assistantMarkedBad || badMarkerBusy}
                              aria-label={assistantMarkedBad ? 'Bad目印を保存済み' : 'Bad目印を付ける'}
                              title={assistantMarkedBad ? 'Bad目印を保存済み' : 'Bad目印を付ける'}
                              data-testid="bad-marker-button"
                            >
                              {assistantMarkedBad ? '保存済み' : 'Bad'}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </Fragment>
              );
            }
            return (
              <div
                key={item.id}
                className={`fx-msg fx-msg-${item.role}`}
                data-msg-id={String(item.id || '')}
                data-msg-role={item.role}
              >
                <div className="fx-msg-bubble">
                  {item.text ? <p className="fx-user-line">{item.text}</p> : null}
                  {Array.isArray(item.attachments) && item.attachments.length > 0 ? (
                    <div className="fx-user-attachments">
                      {item.attachments.map((att, idx) => (
                        <span key={`${item.id}:att:${idx}`} className="fx-user-attachment-chip">
                          画像: {String(att?.name || 'image')} ({formatFileSize(att?.size)})
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {showInitialLoading ? (
            <div className="fx-thinking-live-panel fx-working-panel" data-testid="stream-loading-indicator" aria-live="polite">
              <div className="fx-working-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : null}
          {showThinkingWorking ? (
            <div className="fx-thinking-live-panel fx-working-panel" data-testid="thinking-working-indicator" aria-live="polite">
              <div className="fx-working-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              {thinkingText ? <pre className="fx-thinking-live-text" data-testid="thinking-live-content">{thinkingText}</pre> : null}
            </div>
          ) : null}
          {showCompactionStatus ? (
            <div
              className={`fx-thinking-live-panel fx-compaction-panel${compactionStatusPhase === 'compacted' ? ' is-completed' : ''}`}
              data-testid="compaction-status-panel"
              aria-live="polite"
            >
              {compactionStatusPhase === 'compacting' ? (
                <div className="fx-working-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}
              <div className="fx-compaction-status-text" data-testid="compaction-status-text">
                {compactionStatusMessage}
              </div>
            </div>
          ) : null}
          {activeUserInputRequest && activeUserInputQuestion ? (
            <div className="fx-user-input-requests fx-user-input-requests-inline" data-testid="user-input-requests">
              <div
                key={`uir:${activeUserInputRequest.requestId}`}
                className="fx-user-input-card"
                ref={userInputCardRef}
              >
                <div className="fx-user-input-progress">
                  {answeredUserInputCount + 1}/{(activeUserInputRequest.questions || []).length}
                </div>
                <div key={`q:${activeUserInputRequest.requestId}:${activeUserInputQuestion.id}`} className="fx-user-input-question">
                  {activeUserInputQuestion.header ? <div className="fx-user-input-header">{activeUserInputQuestion.header}</div> : null}
                  <div className="fx-user-input-text">{activeUserInputQuestion.question}</div>
                  <div className="fx-user-input-options">
                    {(activeUserInputQuestion.options || []).map((opt) => (
                      <button
                        key={`opt:${activeUserInputRequest.requestId}:${activeUserInputQuestion.id}:${opt.label}`}
                        type="button"
                        className="fx-user-input-option-btn"
                        onClick={() => selectUserInputOption(activeUserInputRequest, activeUserInputIndex, activeUserInputQuestion.id, opt.label)}
                        disabled={Boolean(pendingUserInputBusy[String(activeUserInputRequest.requestId)])}
                        data-testid={`user-input-option-${activeUserInputQuestion.id}`}
                      >
                        <span className="fx-user-input-option-label">{opt.label}</span>
                        {opt.description ? <span className="fx-user-input-option-desc">{opt.description}</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </article>

        {chatSettingsOpen ? (
          <div className="fx-chat-settings-overlay" onClick={closeChatSettings} data-testid="chat-settings-modal">
            <section
              className="fx-chat-settings-panel"
              role="dialog"
              aria-modal="true"
              aria-label="チャット設定"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="fx-chat-settings-head">
                <h3>チャット設定</h3>
                <button
                  type="button"
                  className="fx-chat-settings-close"
                  onClick={closeChatSettings}
                  data-testid="chat-settings-close"
                  aria-label="設定を閉じる"
                >
                  ×
                </button>
              </header>
              <div className="fx-chat-settings-section">
                <div className="fx-chat-settings-label">スレッド</div>
                <div className="fx-chat-settings-current">
                  {canReturnToPreviousThread ? '新規スレッドから前の会話へ戻せます' : 'ここから新規スレッドを開始できます'}
                </div>
                {canReturnToPreviousThread ? (
                  <button
                    className="fx-thread-action-button"
                    type="button"
                    onClick={returnToPreviousThread}
                    disabled={busy}
                    data-testid="return-thread-button"
                  >
                    <svg
                      className="fx-thread-action-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden="true"
                    >
                      <path
                        d="M9 14L4 9L9 4"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M4 9H15C17.2091 9 19 10.7909 19 13V13C19 15.2091 17.2091 17 15 17H14"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>前のスレッドに戻る</span>
                  </button>
                ) : (
                  <button
                    className="fx-thread-action-button"
                    type="button"
                    onClick={startNewThread}
                    disabled={busy}
                    data-testid="new-thread-button"
                  >
                    <svg
                      className="fx-thread-action-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden="true"
                    >
                      <path
                        d="M16.8617 4.48667L18.5492 2.79917C19.2814 2.06694 20.4686 2.06694 21.2008 2.79917C21.9331 3.53141 21.9331 4.71859 21.2008 5.45083L10.5822 16.0695C10.0535 16.5981 9.40144 16.9868 8.68489 17.2002L6 18L6.79978 15.3151C7.01323 14.5986 7.40185 13.9465 7.93052 13.4178L16.8617 4.48667ZM16.8617 4.48667L19.5 7.12499M18 14V18.75C18 19.9926 16.9926 21 15.75 21H5.25C4.00736 21 3 19.9926 3 18.75V8.24999C3 7.00735 4.00736 5.99999 5.25 5.99999H10"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>新規スレッドを開始</span>
                  </button>
                )}
              </div>
              <div className="fx-chat-settings-section">
                <div className="fx-chat-settings-label">モデル</div>
                <div className="fx-chat-settings-current">現在: {activeModelLabel}</div>
                {modelsLoading ? <p className="fx-mini">モデル一覧を読み込み中...</p> : null}
                {modelsError ? (
                  <div className="fx-chat-settings-error">
                    <p className="fx-mini">読み込みに失敗しました</p>
                    <Button small tonal onClick={() => loadAvailableModels(true)} data-testid="model-reload-button">
                      再読み込み
                    </Button>
                  </div>
                ) : null}
                {!modelsLoading && availableModels.length > 0 ? (
                  <div className="fx-model-list" data-testid="model-list">
                    {availableModels.map((model) => {
                      const testIdModel = model.id.replace(/[^a-zA-Z0-9_-]/g, '_');
                      const selected = model.id === activeRepoModel;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          className={`fx-model-option${selected ? ' is-selected' : ''}`}
                          onClick={() => setActiveRepoModel(model.id)}
                          disabled={busy}
                          data-testid={`model-option-${testIdModel}`}
                        >
                          <div className="fx-model-option-title">{model.name}</div>
                          <div className="fx-model-option-id">{model.id}</div>
                          {model.description ? <div className="fx-model-option-desc">{model.description}</div> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {!modelsLoading && !modelsError && availableModels.length === 0 ? (
                  <p className="fx-mini">利用可能なモデルが見つかりませんでした。</p>
                ) : null}
              </div>
            </section>
          </div>
        ) : null}

        {issuePanelOpen ? (
          <div className="fx-issue-panel-overlay" onClick={closeIssuePanel} data-testid="issues-panel">
            <section
              className="fx-issue-panel"
              role="dialog"
              aria-modal="true"
              aria-label="課題一覧"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="fx-issue-panel-head">
                <h3>課題一覧</h3>
                <button
                  type="button"
                  className="fx-chat-settings-close"
                  onClick={closeIssuePanel}
                  aria-label="課題一覧を閉じる"
                  data-testid="issues-close-button"
                >
                  ×
                </button>
              </header>
              {issueLoading ? <div className="fx-issue-empty">読み込み中...</div> : null}
              {issueError ? <div className="fx-issue-error">{issueError}</div> : null}
              {!issueLoading && !issueError && issueItems.length === 0 ? (
                <div className="fx-issue-empty">課題はまだありません。</div>
              ) : null}
              {!issueLoading && !issueError && issueItems.length > 0 ? (
                <div className="fx-issue-list">
                  {issueItems.map((issue) => (
                    <article key={issue.id} className={`fx-issue-item is-${issue.status}`} data-testid="issue-item">
                      <div className="fx-issue-item-head">
                        <h4>{issue.title}</h4>
                        <span className="fx-issue-status">{formatIssueStatus(issue.status)}</span>
                      </div>
                      <p>{issue.summary}</p>
                      <div className="fx-issue-actions">
                        <button
                          type="button"
                          className="fx-issue-action"
                          onClick={() => useIssuePrompt(issue)}
                          disabled={!issue.nextPrompt || issue.status !== 'open'}
                          data-testid="issue-use-button"
                        >
                          対応する
                        </button>
                        <button
                          type="button"
                          className="fx-issue-action is-muted"
                          onClick={() => resolveIssue(issue)}
                          disabled={issue.status !== 'open'}
                          data-testid="issue-resolve-button"
                        >
                          解決済み
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        <div
          className="fx-composer"
          ref={composerRef}
          style={composerInlineStyle}
          onPointerDownCapture={keepComposerFocus}
          data-testid="composer"
        >
          {isInputFocused ? (
            <div className="fx-mode-toggle" data-testid="mode-toggle">
              <button
                type="button"
                className={`fx-mode-btn is-default${activeCollaborationMode === 'default' ? ' is-active' : ''}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setActiveCollaborationMode('default')}
                disabled={busy}
                data-testid="mode-default-button"
              >
                通常
              </button>
              <button
                type="button"
                className={`fx-mode-btn is-plan${activeCollaborationMode === 'plan' ? ' is-active' : ''}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setActiveCollaborationMode('plan')}
                disabled={busy}
                data-testid="mode-plan-button"
              >
                プラン
              </button>
            </div>
          ) : null}
          {pendingAttachments.length > 0 ? (
            <div className="fx-attachments-bar" data-testid="attachments-bar">
              <div className="fx-attachments-list" data-testid="attachments-list">
                {pendingAttachments.map((att, idx) => (
                  <div
                    key={`${att.name}:${att.size}:${idx}`}
                    className="fx-attachment-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => openPreviewAt(idx)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openPreviewAt(idx);
                      }
                    }}
                    aria-label={`プレビュー: ${att.name}`}
                    title="プレビュー"
                    data-testid={`attachment-item-${idx}`}
                  >
                    <img
                      src={att.dataUrl}
                      alt={att.name}
                      className="fx-attachment-thumb"
                      data-testid={`attachment-thumb-${idx}`}
                    />
                    <div className="fx-attachment-meta">
                      <span className="fx-attachment-name">{att.name}</span>
                      <span className="fx-attachment-size">{formatFileSize(att.size)}</span>
                    </div>
                    <button
                      type="button"
                      className="fx-attachment-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        removePendingAttachment(idx);
                      }}
                      aria-label={`添付解除: ${att.name}`}
                      title="添付解除"
                      data-testid={`attachment-remove-${idx}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="fx-composer-inner">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="fx-file-input"
              data-testid="attachment-input"
              onChange={async (e) => {
                await addImageAttachments(e.target.files);
                e.target.value = '';
                composerInputRef.current?.focus();
              }}
            />
            <Button
              tonal
              className="fx-icon-btn fx-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              aria-label="画像を添付"
              data-testid="attachment-add-button"
            >
              ＋
            </Button>
            <textarea
              className={isComposerExpanded ? 'is-expanded' : ''}
              ref={composerInputRef}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                syncComposerLayout(e.target, { expanded: true });
              }}
              rows={1}
              placeholder="指示を入力"
              onFocus={(e) => {
                setIsInputFocused(true);
                syncComposerLayout(e.currentTarget, { expanded: true });
              }}
              onBlur={(e) => {
                handleComposerInputBlur(e);
                const next = e.relatedTarget;
                const shouldStayExpanded = next instanceof HTMLElement && Boolean(next.closest('.fx-mode-toggle'));
                if (typeof window !== 'undefined') {
                  window.requestAnimationFrame(() =>
                    syncComposerLayout(e.currentTarget, { expanded: shouldStayExpanded })
                  );
                }
              }}
              data-testid="composer-textarea"
            />
            <div
              className={`fx-composer-actions${
                !isInputFocused && !streaming && message.trim().length === 0 && pendingAttachments.length === 0
                  ? ' is-hidden'
                  : ''
              }`}
            >
              {streaming ? (
                hasComposerInput ? (
                  <Button
                    tonal
                    className="fx-icon-btn fx-followup-btn"
                    onClick={sendTurn}
                    disabled={!canSend}
                    aria-label="追加指示"
                    data-testid="followup-button"
                  >
                  <svg
                    className="fx-followup-icon-svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                      <path d="M10 14l11 -11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      <path
                        d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                  </svg>
                </Button>
                ) : (
                  <Button
                    tonal
                    className="fx-icon-btn fx-stop-btn"
                    onClick={cancelTurn}
                    aria-label="停止"
                    data-testid="stop-button"
                  >
                    ■
                  </Button>
                )
              ) : (
                <Button
                  fill
                  className="fx-icon-btn"
                  onClick={sendTurn}
                  disabled={!canSend}
                  aria-label="送信"
                  data-testid="send-button"
                >
                <svg
                  className="fx-send-icon-svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    d="M4.698 4.034l16.302 7.966l-16.302 7.966a.503 .503 0 0 1 -.546 -.124a.555 .555 0 0 1 -.12 -.568l2.468 -7.274l-2.468 -7.274a.555 .555 0 0 1 .12 -.568a.503 .503 0 0 1 .546 -.124"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M6.5 12h14.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
              )}
            </div>
          </div>
        </div>
        {previewAttachment ? (
          <div
            className="fx-image-preview-overlay"
            role="dialog"
            aria-modal="true"
            onClick={closePreview}
            data-testid="image-preview-overlay"
          >
            <div
              className="fx-image-preview-panel"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={onPreviewPointerDown}
              onPointerUp={onPreviewPointerUp}
              onPointerCancel={onPreviewPointerCancel}
              data-testid="image-preview-panel"
            >
              <button
                type="button"
                className="fx-image-preview-close"
                onClick={closePreview}
                aria-label="プレビューを閉じる"
                title="閉じる"
                data-testid="image-preview-close"
              >
                ×
              </button>
              <button
                type="button"
                className="fx-image-preview-nav is-left"
                onClick={showPrevPreview}
                disabled={!canGoPrev}
                aria-label="前の画像"
                title="前の画像"
                data-testid="image-preview-prev"
              >
                ‹
              </button>
              <img
                src={previewAttachment.dataUrl}
                alt={previewAttachment.name}
                className="fx-image-preview-img"
                data-testid="image-preview-img"
              />
              <button
                type="button"
                className="fx-image-preview-nav is-right"
                onClick={showNextPreview}
                disabled={!canGoNext}
                aria-label="次の画像"
                title="次の画像"
                data-testid="image-preview-next"
              >
                ›
              </button>
              <div className="fx-image-preview-caption" data-testid="image-preview-caption">
                <span className="fx-image-preview-name">{previewAttachment.name}</span>
                <span className="fx-image-preview-index">
                  {(previewIndex ?? 0) + 1} / {pendingAttachments.length}
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </PageContent>
    </Page>
  );
}
