require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  const username = process.env.SEED_ADMIN_USERNAME || 'admin';
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';

  const exists = await User.findOne({ username });
  if (exists) {
    console.log('ادمین از قبل وجود دارد:', username);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await User.create({
    username,
    displayName: 'مدیر سیستم',
    passwordHash,
    role: 'admin',
    status: 'active',
    createdByAdmin: true,
  });

  console.log(`ادمین ساخته شد -> username: ${username} | password: ${password}`);
  console.log('توصیه می‌شود بلافاصله رمز را تغییر دهید.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
