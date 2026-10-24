// «چه کسی می‌تواند من را به گروه اضافه کند» (حریم خصوصی): everyone | contacts | nobody. منطق خالص و قابل تست.
// contacts = فقط کسانی که در «مخاطبین ذخیره‌شده‌ی خودِ من» هستند (مثل تلگرام). ربات‌ها مشمول نیستند (مالک اضافه‌شان می‌کند).
const MODES = ['everyone', 'contacts', 'nobody'];

function canAddToGroup(target, adderId) {
  if (!target) return false;
  if (target.isBot) return true;
  const mode = target.privacy?.groupAdd || 'everyone';
  if (mode === 'everyone') return true;
  if (mode === 'nobody') return false;
  if (mode === 'contacts') return (target.savedContacts || []).some((c) => String(c.contact) === String(adderId));
  return true;
}

// users: اسناد کاربرِ هدف (با privacy/savedContacts/isBot)؛ خروجی: شناسه‌های مجاز و ردشده‌ها به‌همراه دلیل
function partitionAddable(users, adderId) {
  const allowed = []; const skipped = [];
  for (const u of users) {
    if (canAddToGroup(u, adderId)) allowed.push(String(u._id));
    else skipped.push({ userId: String(u._id), reason: (u.privacy?.groupAdd) === 'contacts' ? 'contacts' : 'nobody' });
  }
  return { allowed, skipped };
}

module.exports = { MODES, canAddToGroup, partitionAddable };
