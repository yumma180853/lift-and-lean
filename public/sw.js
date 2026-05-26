// 24時間眠らないお留守番プログラム（Web Push通知の受け皿）
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'LIFT & LEAN', body: '今日の体重を記録しましょう！' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon.ico',
      badge: '/favicon.ico'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
