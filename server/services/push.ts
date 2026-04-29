import fs from 'node:fs';
import webPush, { type PushSubscription, type VapidKeys } from 'web-push';
import { getErrorMessage } from '../errors';
import { asObject } from '../json';
import { pushRuntimeLog } from '../runtimeLogs';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  currentThreadId: string | null;
  userAgent: string;
  updatedAt: string;
}

export interface PushConfig {
  enabled: boolean;
  publicKey: string;
  hasVapidConfig: boolean;
  subscriptionCount: number;
}

export interface PushNotifyResult {
  sent: number;
  staleRemoved: number;
  skipped?: string;
}

export interface PushService {
  getConfig(): PushConfig;
  subscribe(input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    currentThreadId?: string | null;
    userAgent?: string;
  }): PushSubscriptionRecord;
  setContext(endpoint: string, currentThreadId?: string | null): PushSubscriptionRecord | null;
  unsubscribe(endpoint: string): boolean;
  notifyThreadSubscribers(threadId: string): Promise<PushNotifyResult>;
}

interface PushServiceOptions {
  subscriptionsPath: string;
  vapidPath: string;
  subject?: string;
  webPushModule?: {
    generateVAPIDKeys(): VapidKeys;
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
    sendNotification(subscription: PushSubscription, payload?: string, options?: { TTL?: number }): Promise<unknown>;
  };
}

const DEFAULT_PUSH_SUBJECT = 'mailto:fixer@example.com';

function loadPushSubscriptions(subscriptionsPath: string): PushSubscriptionRecord[] {
  try {
    if (!fs.existsSync(subscriptionsPath)) return [];
    const raw = fs.readFileSync(subscriptionsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.endpoint === 'string' &&
        item.endpoint &&
        item.keys &&
        typeof item.keys.p256dh === 'string' &&
        typeof item.keys.auth === 'string'
    );
  } catch {
    return [];
  }
}

function savePushSubscriptions(subscriptionsPath: string, subscriptions: PushSubscriptionRecord[]): void {
  const tmp = `${subscriptionsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(subscriptions, null, 2));
  fs.renameSync(tmp, subscriptionsPath);
}

function loadOrCreateVapidKeys(
  vapidPath: string,
  webPushModule: Pick<PushServiceOptions, 'webPushModule'>['webPushModule']
): { publicKey: string; privateKey: string } {
  try {
    if (fs.existsSync(vapidPath)) {
      const raw = fs.readFileSync(vapidPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.publicKey === 'string' &&
        typeof parsed.privateKey === 'string' &&
        parsed.publicKey &&
        parsed.privateKey
      ) {
        return {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey
        };
      }
    }
  } catch {
    // 読み込み失敗時は再生成する。
  }

  const generated = webPushModule!.generateVAPIDKeys();
  const payload = {
    publicKey: String(generated.publicKey),
    privateKey: String(generated.privateKey),
    createdAt: new Date().toISOString()
  };
  const tmp = `${vapidPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, vapidPath);
  return {
    publicKey: payload.publicKey,
    privateKey: payload.privateKey
  };
}

export function createPushService(options: PushServiceOptions): PushService {
  const webPushModule = options.webPushModule ?? webPush;
  const subject = options.subject ?? DEFAULT_PUSH_SUBJECT;
  let subscriptions = loadPushSubscriptions(options.subscriptionsPath);
  let publicKey = '';
  let privateKey = '';
  let enabled = false;

  try {
    const keys = loadOrCreateVapidKeys(options.vapidPath, webPushModule);
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    webPushModule.setVapidDetails(subject, publicKey, privateKey);
    enabled = true;
  } catch (error) {
    enabled = false;
    pushRuntimeLog({
      level: 'error',
      event: 'push_vapid_init_failed',
      message: getErrorMessage(error)
    });
  }

  function upsertSubscription(input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    currentThreadId?: string | null;
    userAgent?: string;
  }): PushSubscriptionRecord {
    const now = new Date().toISOString();
    const record: PushSubscriptionRecord = {
      endpoint: input.endpoint,
      keys: {
        p256dh: String(input.keys.p256dh),
        auth: String(input.keys.auth)
      },
      currentThreadId: input.currentThreadId ? String(input.currentThreadId) : null,
      userAgent: String(input.userAgent || ''),
      updatedAt: now
    };
    const idx = subscriptions.findIndex((item) => item.endpoint === input.endpoint);
    if (idx >= 0) subscriptions[idx] = { ...subscriptions[idx], ...record };
    else subscriptions.push(record);
    savePushSubscriptions(options.subscriptionsPath, subscriptions);
    return record;
  }

  function removeSubscription(endpoint: string): boolean {
    const before = subscriptions.length;
    subscriptions = subscriptions.filter((item) => item.endpoint !== endpoint);
    if (subscriptions.length !== before) savePushSubscriptions(options.subscriptionsPath, subscriptions);
    return before !== subscriptions.length;
  }

  return {
    getConfig(): PushConfig {
      return {
        enabled,
        publicKey: enabled ? publicKey : '',
        hasVapidConfig: enabled,
        subscriptionCount: subscriptions.length
      };
    },
    subscribe(input): PushSubscriptionRecord {
      return upsertSubscription(input);
    },
    setContext(endpoint: string, currentThreadId: string | null = null): PushSubscriptionRecord | null {
      const idx = subscriptions.findIndex((item) => item.endpoint === endpoint);
      if (idx < 0) return null;
      const current = subscriptions[idx];
      if (!current) return null;
      subscriptions[idx] = {
        ...current,
        currentThreadId: currentThreadId ? String(currentThreadId) : null,
        updatedAt: new Date().toISOString()
      };
      savePushSubscriptions(options.subscriptionsPath, subscriptions);
      return subscriptions[idx];
    },
    unsubscribe(endpoint: string): boolean {
      return removeSubscription(endpoint);
    },
    async notifyThreadSubscribers(threadId: string): Promise<PushNotifyResult> {
      if (!enabled) return { sent: 0, staleRemoved: 0, skipped: 'push_not_configured' };
      const targets = subscriptions.filter((sub) => sub.currentThreadId === threadId);
      if (targets.length === 0) return { sent: 0, staleRemoved: 0 };

      const payload = JSON.stringify({
        title: 'Fixer',
        body: '返答が完了しました',
        threadId,
        url: '/chat/'
      });

      let sent = 0;
      let staleRemoved = 0;

      for (const sub of targets) {
        try {
          await webPushModule.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.keys.p256dh,
                auth: sub.keys.auth
              }
            },
            payload,
            { TTL: 60 }
          );
          sent += 1;
        } catch (error) {
          const errorRecord = asObject(error);
          const statusCode = Number(errorRecord?.statusCode || 0);
          if (statusCode === 404 || statusCode === 410) {
            if (removeSubscription(sub.endpoint)) staleRemoved += 1;
          }
          pushRuntimeLog({
            level: 'error',
            event: 'push_send_failed',
            threadId,
            endpoint: sub.endpoint,
            statusCode: statusCode || null,
            message: getErrorMessage(error)
          });
        }
      }

      return { sent, staleRemoved };
    }
  };
}
