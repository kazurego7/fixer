import { createContext, useContext, type RefObject } from 'react';
import type {
  AppErrorState,
  CollaborationMode,
  GitRepoStatus,
  ImageAttachmentDraft,
  IssueItem,
  ModelOption,
  OutputItem,
  PendingBusyMap,
  PendingUserInputRequest,
  RepoFileListItem,
  RepoFileViewResponse,
  RepoSummary,
  UserInputDraftMap
} from '../../shared/types';

export type RepoFilter = 'all' | 'cloned' | 'not_cloned';

export interface AppContextValue {
  connected: boolean;
  error: AppErrorState | null;
  busy: boolean;
  query: string;
  setQuery: (value: string) => void;
  repos: RepoSummary[];
  repoFilter: RepoFilter;
  setRepoFilter: (value: RepoFilter) => void;
  selectedRepo: RepoSummary | null;
  setSelectedRepo: (value: RepoSummary | null) => void;
  clonedRepos: RepoSummary[];
  notClonedRepos: RepoSummary[];
  filteredRepos: RepoSummary[];
  activeRepoFullName: string | null;
  activeThreadId: string | null;
  chatVisible: boolean;
  outputItems: OutputItem[];
  outputRef: RefObject<HTMLElement | null>;
  message: string;
  setMessage: (value: string) => void;
  pendingAttachments: ImageAttachmentDraft[];
  addImageAttachments: (fileList: FileList | null) => Promise<void>;
  removePendingAttachment: (index: number) => void;
  streaming: boolean;
  streamingAssistantId: string | null;
  liveReasoningText: string;
  compactionStatusPhase: '' | 'compacting' | 'compacted';
  compactionStatusMessage: string;
  awaitingFirstStreamChunk: boolean;
  hasReasoningStarted: boolean;
  hasAnswerStarted: boolean;
  navigate: (path: string, replace?: boolean) => void;
  bootstrapConnection: () => Promise<void>;
  fetchRepos: (nextQuery?: string) => Promise<void>;
  createRepo: (name: string, visibility: 'public' | 'private') => Promise<RepoSummary>;
  startWithRepo: (repo: RepoSummary) => Promise<boolean>;
  sendTurn: () => Promise<void>;
  cancelTurn: () => Promise<void>;
  startNewThread: () => Promise<void>;
  canReturnToPreviousThread: boolean;
  returnToPreviousThread: () => void;
  goBackToRepoList: () => void;
  canApplyLatestPlan: boolean;
  applyLatestPlanShortcut: () => Promise<void>;
  chatSettingsOpen: boolean;
  openChatSettings: () => void;
  closeChatSettings: () => void;
  availableModels: ModelOption[];
  modelsLoading: boolean;
  modelsError: string;
  loadAvailableModels: (force?: boolean) => Promise<void>;
  activeRepoModel: string;
  setActiveRepoModel: (modelId: string) => void;
  gitStatus: GitRepoStatus | null;
  gitStatusLoading: boolean;
  gitStatusError: string;
  refreshGitStatus: () => Promise<void>;
  requestGitCommitPush: () => Promise<void>;
  fileListItems: RepoFileListItem[];
  fileListLoading: boolean;
  fileListError: string;
  fileListIncludeUnchanged: boolean;
  setFileListIncludeUnchanged: (value: boolean) => void;
  refreshFileList: (includeUnchanged?: boolean) => Promise<void>;
  selectedFileView: RepoFileViewResponse | null;
  selectedFileViewLoading: boolean;
  selectedFileViewError: string;
  openRepoFile: (filePath: string, line?: number | null, replace?: boolean, jumpToFirstDiff?: boolean) => Promise<void>;
  returnFromFileView: () => void;
  activeCollaborationMode: CollaborationMode;
  setActiveCollaborationMode: (mode: CollaborationMode) => void;
  pendingUserInputRequests: PendingUserInputRequest[];
  selectUserInputOption: (
    request: PendingUserInputRequest,
    questionIndex: number,
    questionId: string,
    optionLabel: string
  ) => Promise<void>;
  pendingUserInputBusy: PendingBusyMap;
  pendingUserInputDrafts: UserInputDraftMap;
  issueItems: IssueItem[];
  issuePanelOpen: boolean;
  issueLoading: boolean;
  issueError: string;
  openIssuePanel: () => void;
  closeIssuePanel: () => void;
  markTurnBad: (turnId: string) => Promise<void>;
  badMarkerBusy: boolean;
  markedBadTurnIds: string[];
  useIssuePrompt: (issue: IssueItem) => void;
  resolveIssue: (issue: IssueItem) => Promise<void>;
}

export const AppCtx = createContext<AppContextValue | null>(null);

export function useAppCtx(): AppContextValue {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('AppCtx missing');
  return ctx;
}
