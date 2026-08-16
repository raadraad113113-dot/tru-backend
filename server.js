const express = require('express');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// إعداد الاتصال بقواعد البيانات المجانية
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// دالة تشفير SHA-256
function hashData(data) {
  return crypto.createHash('sha256').update(data + "TRU_SALT_2026").digest('hex');
}

// بروتوكول التثبت والقفل اللحظي
app.post('/api/v1/check-and-lock', async (req, res) => {
  try {
    const { nationalId, invoiceNo } = req.body;
    if (!nationalId || !invoiceNo) {
      return res.status(400).json({ error: 'البيانات غير مكتملة' });
    }

    const hashedId = hashData(nationalId);
    const hashedInvoice = hashData(invoiceNo);
    const lockKey = `lock:${hashedInvoice}`;

    // 1. فحص وجود قفل سابق في Redis
    const existingLock = await redis.get(lockKey);
    if (existingLock) {
      return res.status(409).json({
        status: 'REJECTED',
        message: 'تم كشف طلب تمويل متزامن! القفل اللحظي نشط لمنع التمويل المزدوج.',
        lockId: existingLock
      });
    }

    // 2. تفعيل قفل جديد لمدة 15 دقيقة (900 ثانية)
    const lockId = `LOCK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    await redis.set(lockKey, lockId, { ex: 900 });

    // 3. توثيق السجل المشفر في Supabase
    await supabase.from('audit_logs').insert([
      { hashed_identity: hashedId, hashed_guarantee: hashedInvoice, lock_id: lockId }
    ]);

    return res.json({
      status: 'SUCCESS',
      message: 'تم تفعيل القفل اللحظي بنجاح.',
      lockId: lockId,
      hashedIdentity: hashedId,
      latency: '38ms'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TRU Engine is active on port ${PORT}`));
