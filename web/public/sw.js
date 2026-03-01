self.addEventListener('push', (event) => {
  let payload = { title: 'Fixer', body: '返答が完了しました', url: '/chat/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // noop
  }

  const title = String(payload.title || 'Fixer');
  const body = String(payload.body || '返答が完了しました');
  const url = String(payload.url || '/chat/');

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url },
      tag: payload.threadId ? `thread:${payload.threadId}` : 'fixer-reply'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = String(event.notification?.data?.url || '/chat/');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => {
        try {
          const u = new URL(client.url);
          return u.pathname === targetUrl;
        } catch {
          return false;
        }
      });
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
