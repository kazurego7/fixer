import type { CollaborationMode } from '../../shared/types';

export const LAST_THREAD_ID_KEY = 'fx:lastThreadId';
export const LAST_REPO_FULLNAME_KEY = 'fx:lastRepoFullName';
export const THREAD_BY_REPO_KEY = 'fx:threadByRepo';
export const COLLABORATION_MODE_BY_REPO_KEY = 'fx:collaborationModeByRepo';
export const MODEL_BY_REPO_KEY = 'fx:modelByRepo';
export const PUSH_ENDPOINT_KEY = 'fx:pushEndpoint';
export const DEFAULT_COLLABORATION_MODE: CollaborationMode = 'default';

export type ThreadByRepoMap = Record<string, string>;
export type CollaborationModeByRepoMap = Record<string, CollaborationMode>;
export type ModelByRepoMap = Record<string, string>;
