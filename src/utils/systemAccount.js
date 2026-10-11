const User = require('../models/User');
const Chat = require('../models/Chat');
const crypto = require('crypto');

const SYSTEM_USERNAME = 'wizchat';
let cachedSystemUserId = null;

// اولین باری که سرور بالا میاد (یا اولین باری که لازم بشه) یه اکانت سیستمی می‌سازه - رمز عبورش
// یه مقدار تصادفی و بی‌مصرفه چون هیچ‌وقت قرار نیست باهاش وارد بشه (isSystem این رو تضمین می‌کنه)
async function ensureSystemUser() {
  if (cachedSystemUserId) return cachedSystemUserId;
  let user = await User.findOne({ username: SYSTEM_USERNAME });
  if (!user) {
    user = await User.create({
      username: SYSTEM_USERNAME,
      displayName: 'WizChat',
      passwordHash: crypto.randomBytes(32).toString('hex'),
      isSystem: true,
      status: 'active',
      bio: 'اعلان‌های رسمی، بروزرسانی‌ها و هشدارهای امنیتیِ حساب شما',
    });
  } else if (!user.isSystem) {
    user.isSystem = true;
    await user.save();
  }
  cachedSystemUserId = user._id;
  return user._id;
}

// چتِ خصوصیِ بین کاربر و اکانتِ سیستمی - اگه نبود می‌سازتش (پیدا نمی‌شه رو مخاطبین چون خودِ
// کاربر اضافه‌ش نکرده، فقط یه چتِ عادیه که یه طرفش سیستمه)
async function getOrCreateSystemChat(userId) {
  const systemUserId = await ensureSystemUser();
  let chat = await Chat.findOne({
    type: 'private',
    'members.user': { $all: [userId, systemUserId] },
    $expr: { $eq: [{ $size: '$members' }, 2] },
  });
  if (!chat) {
    chat = await Chat.create({
      type: 'private',
      members: [{ user: userId, role: 'member' }, { user: systemUserId, role: 'member' }],
    });
  }
  return chat;
}

module.exports = { ensureSystemUser, getOrCreateSystemChat, SYSTEM_USERNAME };
