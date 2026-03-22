export type RequestId = string | number;

export type CollaborationMode = 'default' | 'plan';

export type CloneStatus = 'cloning' | 'failed' | 'cloned' | 'not_cloned';

export interface CloneState {
  status: CloneStatus;
  repoPath?: string;
  error?: string;
}

export interface RepoSummary {
  id: number | string;
  name?: string;
  fullName: string;
  private?: boolean;
  cloneUrl?: string;
  defaultBranch?: string;
  updatedAt?: string | null;
  cloneState?: CloneState | null;
}

export interface ModelOption {
  id: string;
  name: string;
  description: string;
}

export interface ImageAttachmentDraft {
  type: 'image';
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
}

export interface ImageAttachmentMeta {
  type: 'image';
  name: string;
  mime: string;
  size: number;
}

export interface BaseOutputItem {
  id: string;
  role: 'assistant' | 'user' | 'system';
  type: string;
  text: string;
}

export interface AssistantOutputItem extends BaseOutputItem {
  role: 'assistant';
  type: 'markdown' | 'plain' | 'diff';
  answer?: string;
  plan?: string;
  status?: string;
  reasoning?: string;
}

export interface UserOutputItem extends BaseOutputItem {
  role: 'user';
  type: 'plain';
  attachments?: ImageAttachmentMeta[];
}

export interface SystemOutputItem extends BaseOutputItem {
  role: 'system';
}

export type OutputItem = AssistantOutputItem | UserOutputItem | SystemOutputItem;

export interface AppErrorState {
  title: string;
  cause: string;
}

export interface PendingThreadReturn {
  repoFullName: string;
  fromThreadId: string;
  toThreadId: string;
}

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[];
}

export interface PendingUserInputRequest {
  requestId: RequestId;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  createdAt?: string;
}

export interface UserInputAnswer {
  answers: string[];
}

export type UserInputAnswerMap = Record<string, UserInputAnswer>;

export interface UserInputDraft {
  index: number;
  answers: UserInputAnswerMap;
}

export type UserInputDraftMap = Record<string, UserInputDraft>;

export type PendingBusyMap = Record<string, boolean>;

export interface StartedTurnStreamEvent {
  type: 'started';
  turnId?: string;
}

export interface AnswerDeltaTurnStreamEvent {
  type: 'answer_delta';
  delta: string;
  itemId?: string;
}

export interface ReasoningDeltaTurnStreamEvent {
  type: 'reasoning_delta';
  delta: string;
}

export interface PlanDeltaTurnStreamEvent {
  type: 'plan_delta';
  delta: string;
  itemId?: string;
}

export interface PlanSnapshotTurnStreamEvent {
  type: 'plan_snapshot';
  text: string;
  itemId?: string;
}

export interface RequestUserInputTurnStreamEvent {
  type: 'request_user_input';
  requestId: RequestId;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
}

export interface StatusTurnStreamEvent {
  type: 'status';
  phase: 'starting' | 'reconnecting';
  attempt?: number;
  message?: string;
}

export interface DoneTurnStreamEvent {
  type: 'done';
}

export interface ErrorTurnStreamEvent {
  type: 'error';
  message: string;
}

export type TurnStreamEvent =
  | StartedTurnStreamEvent
  | AnswerDeltaTurnStreamEvent
  | ReasoningDeltaTurnStreamEvent
  | PlanDeltaTurnStreamEvent
  | PlanSnapshotTurnStreamEvent
  | RequestUserInputTurnStreamEvent
  | StatusTurnStreamEvent
  | DoneTurnStreamEvent
  | ErrorTurnStreamEvent;

export interface ParsedV2TurnNotification {
  protocol: 'v2';
  method: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  delta: string | null;
  status: string | null;
  errorMessage: string | null;
  willRetry: boolean;
}

export interface ParsedLegacyTurnNotification {
  protocol: 'legacy';
  method: string;
  type: string;
  threadId: string | null;
  turnId: string | null;
  delta: string | null;
  message: string | null;
  reason: string | null;
}

export interface TurnTerminalNotification {
  threadId: string;
  turnId: string | null;
  kind: 'done' | 'error';
  message: string | null;
}

export interface SelectTurnStreamState {
  threadId: string | null;
  turnId: string | null;
  preferV2: boolean;
}

export interface SelectTurnStreamUpdateResult {
  matched: boolean;
  nextPreferV2: boolean;
  streamEvent?: Exclude<TurnStreamEvent, DoneTurnStreamEvent | ErrorTurnStreamEvent>;
  terminal?: {
    kind: 'done' | 'error';
    message?: string;
  };
}

export interface CollaborationModeSettings {
  model: string;
  reasoning_effort: null;
  developer_instructions: null;
}

export interface CollaborationModeOverride {
  mode: CollaborationMode;
  settings: CollaborationModeSettings;
}

export interface TurnStartOverrides {
  summary: 'concise';
  model?: string;
  collaborationMode?: CollaborationModeOverride;
}
