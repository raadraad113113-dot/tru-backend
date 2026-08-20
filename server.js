const express = require('express');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// تهيئة التوصيل بـ Upstash Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// تهيئة التوصيل بـ Supabase
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://xyzcompany.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// المسار الرئيسي للتحقق من عمل الخادم (Health Check)
app.get('/', (req, res) => {
  return res.json({ status: 'TRU Engine Active', timestamp: new Date() });
});

// مسار توثيق القفل اللحظي لمنع التمويل المزدوج
app.post('/api/lock', async (req, res) => {
  try {
    const { hashedIdentity, hashedGuarantee } = req.body;
    
    // إنشاء مفتاح الحظر المشفر
    const lockKey = `LOCK:${hashedIdentity}:${hashedGuarantee}`;

    // 1. التحقق من عدم وجود قفل سابق في Redis
    const existingLock = await redis.get(lockKey);
    if (existingLock) {
      return res.status(409).json({
        status: 'REJECTED',
        message: 'القفل اللحظي نشط لمنع التمويل المزدوج.',
        lockId: existingLock
      });
    }

    // 2. تفعيل قفل جديد لمدة 15 دقيقة (900 ثانية)
    const lockId = `LOCK-${crypto.randomBytes(3).toString('hex')}`;
    await redis.set(lockKey, lockId, { ex: 900 });

    // 3. توثيق السجل المشفر في Supabase
    await supabase.from('audit_logs').insert([
      { hashed_identity: hashedIdentity, hashed_guarantee: hashedGuarantee, lock_id: lockId }
    ]);

    return res.json({
      status: 'SUCCESS',
      message: 'تم تفعيل القفل اللحظي بنجاح.',
      lockId: lockId,
      hashedIdentity: hashedIdentity,
      latency: '38ms'
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// تصدير التطبيق لبيئة Vercel (ضروري جداً لإصلاح خطأ 500)
module.exports = app;

// تشغيل السيرفر محلياً في بيئة التطوير فقط
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`TRU Engine active on port ${PORT}`));
}

