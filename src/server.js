require('dotenv').config();
const dns = require('dns');
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chats');
const userRoutes = require('./routes/users');
const searchRoutes = require('./routes/search');
const callRoutes = require('./routes/calls');
const mediaRoutes = require('./routes/media');
const folderRoutes = require('./routes/folders');
const wallpaperRoutes = require('./routes/wallpapers');
const activityRoutes = require('./routes/activity');
const reportRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');
const deviceRoutes = require('./routes/devices');
const moderationRoutes = require('./routes/moderation');
const initSocket = require('./socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: { error: 'تعداد درخواست‌ها بیش از حد مجاز است' },
  })
);

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/users', userRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/wallpapers', wallpaperRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/moderation', moderationRoutes);
app.use('/wallpapers', express.static(path.join(__dirname, '..', 'wallpapers')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'خطای داخلی سرور' });
});

initSocket(io);

const PORT = process.env.PORT || 4000;

// رفع مشکل رایج «querySrv ECONNREFUSED» هنگام اتصال به MongoDB Atlas:
// معمولاً یعنی DNS Resolver سیستم‌عامل/شبکه نمی‌تواند رکوردهای SRV را resolve کند
// (خیلی روی ISPهای ایران و بعضی تنظیمات WSL/روتر دیده می‌شود)، در حالی که nslookup دستی کار می‌کند
// چون از سرور DNS دیگری استفاده می‌کند. اینجا به‌صورت صریح DNS عمومی گوگل/کلادفلر را ست می‌کنیم.
if (process.env.MONGODB_DNS_SERVERS) {
  dns.setServers(process.env.MONGODB_DNS_SERVERS.split(','));
} else if (process.env.MONGODB_URI?.startsWith('mongodb+srv://')) {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB متصل شد');
    server.listen(PORT, () => console.log(`سرور روی پورت ${PORT} اجرا شد`));
  })
  .catch((err) => {
    console.error('خطا در اتصال به MongoDB:', err.message);
    if (err.message?.includes('querySrv') || err.message?.includes('ENOTFOUND')) {
      console.error(
        '💡 اگر خطا مربوط به SRV/DNS است: یا MONGODB_DNS_SERVERS=8.8.8.8,1.1.1.1 را در .env تنظیم کن، ' +
          'یا از پنل Atlas یک connection string غیر-SRV (mongodb:// با هاست‌های صریح) بگیر و در MONGODB_URI بگذار.'
      );
    }
    process.exit(1);
  });
