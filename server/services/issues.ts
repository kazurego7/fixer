import fs from 'node:fs';
import type { IssueItem, IssueMarker, IssueStatus } from '../../shared/types';
import { asObject, asString } from '../json';

interface IssueStore {
  markers: IssueMarker[];
  issues: IssueItem[];
  curatorThreadsByRepo: Record<string, string>;
}

export interface IssueSummaryDraft {
  title: string;
  summary: string;
  nextPrompt: string;
}

export interface IssueService {
  listIssues(repoFullName: string): IssueItem[];
  createIssueMarker(input: { repoFullName: string; sourceThreadId: string; sourceTurnId: string }): IssueMarker;
  updateIssueStatus(id: string, status: 'open' | 'resolved'): IssueItem | null;
  getCuratorThreadId(repoFullName: string): string | null;
  setCuratorThreadId(repoFullName: string, threadId: string): void;
  getPendingMarkersForTurn(sourceThreadId: string, sourceTurnId: string): IssueMarker[];
  markMarkersSummarizing(markers: IssueMarker[], updatedAt?: string): void;
  markMarkersFailed(markers: IssueMarker[], error: string, updatedAt?: string): void;
  createIssueFromDraft(input: {
    repoFullName: string;
    sourceThreadId: string;
    sourceTurnId: string;
    markerIds: string[];
    draft: IssueSummaryDraft;
    createdAt?: string;
  }): IssueItem;
}

interface IssueServiceOptions {
  issueStorePath: string;
}

function emptyIssueStore(): IssueStore {
  return { markers: [], issues: [], curatorThreadsByRepo: {} };
}

function normalizeIssueStatus(value: unknown): IssueStatus {
  const status = String(value || '').trim();
  if (status === 'pending' || status === 'summarizing' || status === 'open' || status === 'resolved' || status === 'failed') {
    return status;
  }
  return 'pending';
}

function loadIssueStore(issueStorePath: string): IssueStore {
  try {
    if (!fs.existsSync(issueStorePath)) return emptyIssueStore();
    const raw = fs.readFileSync(issueStorePath, 'utf8');
    const parsed = JSON.parse(raw);
    const record = asObject(parsed) || {};
    const markersRaw = Array.isArray(record.markers) ? record.markers : [];
    const issuesRaw = Array.isArray(record.issues) ? record.issues : [];
    const curatorRaw = asObject(record.curatorThreadsByRepo) || {};
    const curatorThreadsByRepo: Record<string, string> = {};
    for (const [repoFullName, threadId] of Object.entries(curatorRaw)) {
      if (typeof repoFullName === 'string' && typeof threadId === 'string' && repoFullName && threadId) {
        curatorThreadsByRepo[repoFullName] = threadId;
      }
    }
    return {
      markers: markersRaw
        .map((item): IssueMarker | null => {
          const marker = asObject(item);
          const id = asString(marker?.id);
          const repoFullName = asString(marker?.repoFullName);
          const sourceThreadId = asString(marker?.sourceThreadId);
          const sourceTurnId = asString(marker?.sourceTurnId);
          if (!id || !repoFullName || !sourceThreadId || !sourceTurnId) return null;
          return {
            id,
            repoFullName,
            sourceThreadId,
            sourceTurnId,
            status: normalizeIssueStatus(marker?.status),
            createdAt: asString(marker?.createdAt) || new Date().toISOString(),
            updatedAt: asString(marker?.updatedAt) || new Date().toISOString(),
            error: asString(marker?.error),
            issueId: asString(marker?.issueId)
          };
        })
        .filter((item): item is IssueMarker => Boolean(item)),
      issues: issuesRaw
        .map((item): IssueItem | null => {
          const issue = asObject(item);
          const id = asString(issue?.id);
          const repoFullName = asString(issue?.repoFullName);
          const title = asString(issue?.title);
          const summary = asString(issue?.summary);
          const nextPrompt = asString(issue?.nextPrompt);
          const sourceThreadId = asString(issue?.sourceThreadId);
          const sourceTurnId = asString(issue?.sourceTurnId);
          if (!id || !repoFullName || !title || !summary || !nextPrompt || !sourceThreadId || !sourceTurnId) return null;
          const markerIds = Array.isArray(issue?.markerIds)
            ? issue.markerIds.map((value: unknown) => String(value || '').trim()).filter(Boolean)
            : [];
          return {
            id,
            repoFullName,
            title,
            summary,
            nextPrompt,
            markerIds,
            sourceThreadId,
            sourceTurnId,
            status: normalizeIssueStatus(issue?.status),
            createdAt: asString(issue?.createdAt) || new Date().toISOString(),
            updatedAt: asString(issue?.updatedAt) || new Date().toISOString(),
            error: asString(issue?.error)
          };
        })
        .filter((item): item is IssueItem => Boolean(item)),
      curatorThreadsByRepo
    };
  } catch {
    return emptyIssueStore();
  }
}

function saveIssueStore(issueStorePath: string, store: IssueStore): void {
  const tmp = `${issueStorePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, issueStorePath);
}

function issueId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createIssueService(options: IssueServiceOptions): IssueService {
  let store = loadIssueStore(options.issueStorePath);

  function persist(): void {
    saveIssueStore(options.issueStorePath, store);
  }

  return {
    listIssues(repoFullName: string): IssueItem[] {
      const issues = store.issues
        .filter((issue) => issue.repoFullName === repoFullName && issue.status !== 'resolved')
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const issueMarkerIds = new Set(issues.flatMap((issue) => issue.markerIds));
      const markerItems: IssueItem[] = store.markers
        .filter(
          (marker) =>
            marker.repoFullName === repoFullName &&
            marker.status !== 'resolved' &&
            !issueMarkerIds.has(marker.id) &&
            !marker.issueId
        )
        .map((marker) => ({
          id: `marker:${marker.id}`,
          repoFullName: marker.repoFullName,
          title:
            marker.status === 'failed'
              ? '課題要約に失敗'
              : marker.status === 'summarizing'
                ? '課題を要約中'
                : '課題目印を保存済み',
          summary: marker.status === 'failed' ? marker.error || 'Codex の課題要約に失敗しました。' : 'Bad の目印から課題を作成しています。',
          nextPrompt: '',
          markerIds: [marker.id],
          sourceThreadId: marker.sourceThreadId,
          sourceTurnId: marker.sourceTurnId,
          status: marker.status,
          createdAt: marker.createdAt,
          updatedAt: marker.updatedAt,
          error: marker.error || null
        }));
      markerItems.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return [...issues, ...markerItems];
    },

    createIssueMarker(input): IssueMarker {
      const existing = store.markers.find(
        (marker) =>
          marker.repoFullName === input.repoFullName &&
          marker.sourceThreadId === input.sourceThreadId &&
          marker.sourceTurnId === input.sourceTurnId &&
          marker.status !== 'resolved'
      );
      if (existing) return existing;
      const now = new Date().toISOString();
      const marker: IssueMarker = {
        id: issueId('marker'),
        repoFullName: input.repoFullName,
        sourceThreadId: input.sourceThreadId,
        sourceTurnId: input.sourceTurnId,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        error: null,
        issueId: null
      };
      store.markers.push(marker);
      persist();
      return marker;
    },

    updateIssueStatus(id: string, status: 'open' | 'resolved'): IssueItem | null {
      const issue = store.issues.find((item) => item.id === id);
      if (!issue) return null;
      const now = new Date().toISOString();
      issue.status = status;
      issue.updatedAt = now;
      for (const marker of store.markers) {
        if (issue.markerIds.includes(marker.id)) {
          marker.status = status;
          marker.updatedAt = now;
        }
      }
      persist();
      return issue;
    },

    getCuratorThreadId(repoFullName: string): string | null {
      return store.curatorThreadsByRepo[repoFullName] || null;
    },

    setCuratorThreadId(repoFullName: string, threadId: string): void {
      store.curatorThreadsByRepo[repoFullName] = threadId;
      persist();
    },

    getPendingMarkersForTurn(sourceThreadId: string, sourceTurnId: string): IssueMarker[] {
      return store.markers.filter(
        (marker) =>
          marker.sourceThreadId === sourceThreadId &&
          marker.sourceTurnId === sourceTurnId &&
          marker.status === 'pending'
      );
    },

    markMarkersSummarizing(markers: IssueMarker[], updatedAt = new Date().toISOString()): void {
      for (const marker of markers) {
        marker.status = 'summarizing';
        marker.updatedAt = updatedAt;
        marker.error = null;
      }
      persist();
    },

    markMarkersFailed(markers: IssueMarker[], error: string, updatedAt = new Date().toISOString()): void {
      for (const marker of markers) {
        marker.status = 'failed';
        marker.error = error;
        marker.updatedAt = updatedAt;
      }
      persist();
    },

    createIssueFromDraft(input): IssueItem {
      const createdAt = input.createdAt || new Date().toISOString();
      const issue: IssueItem = {
        id: issueId('issue'),
        repoFullName: input.repoFullName,
        title: input.draft.title,
        summary: input.draft.summary,
        nextPrompt: input.draft.nextPrompt,
        markerIds: input.markerIds,
        sourceThreadId: input.sourceThreadId,
        sourceTurnId: input.sourceTurnId,
        status: 'open',
        createdAt,
        updatedAt: createdAt,
        error: null
      };
      store.issues.push(issue);
      for (const marker of store.markers) {
        if (input.markerIds.includes(marker.id)) {
          marker.status = 'open';
          marker.issueId = issue.id;
          marker.updatedAt = createdAt;
        }
      }
      persist();
      return issue;
    }
  };
}
