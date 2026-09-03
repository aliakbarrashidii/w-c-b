const axios = require('axios');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * ارسال نوتیفیکیشن پوش از طریق سرویس Expo.
 * چون اپ موبایل با Expo ساخته شده، از توکن پوش اختصاصی Expo استفاده می‌کنیم —
 * نیازی به فایل‌های تنظیمات Firebase (google-services.json) برای تست نیست؛
 * Expo خودش پیام را به FCM/APNs واقعی روی هر پلتفرم تحویل می‌دهد.
 * برای بیلد نهایی پروداکشن (EAS Build)، Expo از پروژه Firebase خودت هم پشتیبانی می‌کند.
 */
async function sendPushNotifications(tokens = [], { title, body, data = {} }) {
  const validTokens = tokens.filter((t) => typeof t === 'string' && t.startsWith('ExponentPushToken'));
  if (validTokens.length === 0) return;

  const messages = validTokens.map((to) => ({
    to,
    title,
    body,
    data,
    sound: 'default',
    priority: 'high',
  }));

  try {
    // Expo حداکثر ۱۰۰ پیام در هر درخواست را قبول می‌کند
    const chunks = [];
    for (let i = 0; i < messages.length; i += 100) chunks.push(messages.slice(i, i + 100));
    await Promise.all(chunks.map((chunk) => axios.post(EXPO_PUSH_URL, chunk, { headers: { 'Content-Type': 'application/json' } })));
  } catch (err) {
    console.error('خطا در ارسال نوتیفیکیشن پوش:', err.message);
  }
}

module.exports = { sendPushNotifications };
