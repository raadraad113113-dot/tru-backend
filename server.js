const express = require('express');
const cors = require('cors');
const { Redis } = require('@upstash/redis');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

// متغيرات عالمية للاحتفاظ بالعملاء بعد التهيئة (Caching)
let redisClient = null;
let supabaseClient = null;

/**
 * Lazy Initialization لعميل Redis
 */
function getRedis() {
    if (!redisClient) {
        redisClient = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
    }
    return redisClient;
}

/**
 * Lazy Initialization لعميل Supabase
 */
function getSupabase() {
    if (!supabaseClient) {
        supabaseClient = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY
        );
    }
    return supabaseClient;
}

/**
 * مسار الفحص GET /
 */
app.get('/', (req, res) => {
    res.status(200).json({
        status: "Online",
        service: "TRU Prevention System",
        timestamp: new Date().toISOString()
    });
});

/**
 * مسار القفل POST /api/lock
 * لمنع التمويل المزدوج باستخدام Atomic Locking
 */
app.post('/api/lock', async (req, res) => {
    const { nationalId, amount, requestId } = req.body;

    // 1. التحقق من البيانات المدخلة
    if (!nationalId) {
        return res.status(400).json({ error: "National ID is required" });
    }

    try {
        const redis = getRedis();
        const supabase = getSupabase();

        // مفتاح القفل الفريد (بناءً على رقم الهوية)
        const lockKey = `lock:finance:${nationalId}`;

        // 2. محاولة تفعيل القفل الذري (SET NX EX)
        // NX: لا تضع القيمة إذا كان المفتاح موجوداً مسبقاً
        // EX: تنتهي صلاحية القفل تلقائياً بعد 900 ثانية (15 دقيقة)
        const isLocked = await redis.set(lockKey, "LOCKED", {
            nx: true,
            ex: 900
        });

        if (!isLocked) {
            // إذا فشل القفل، فهذا يعني وجود عملية تمويل قائمة بالفعل
            return res.status(409).json({
                success: false,
                message: "Double Financing Detected: Request already in progress for this ID.",
                code: "DUPLICATE_FINANCE_ATTEMPT"
            });
        }

        // 3. تسجيل العملية في سجل التدقيق (Supabase) بعد نجاح القفل
        const { error: supabaseError } = await supabase
            .from('audit_logs')
            .insert([
                { 
                    national_id: nationalId, 
                    amount: amount || 0, 
                    request_id: requestId || 'N/A',
                    status: 'LOCKED',
                    created_at: new Date()
                }
            ]);

        if (supabaseError) {
            console.error("Supabase Audit Error:", supabaseError);
            // ملاحظة: لا نلغي العملية هنا لأن القفل في Redis نجح بالفعل
        }

        // 4. رد بالنجاح
        return res.status(200).json({
            success: true,
            message: "Lock acquired successfully. No double financing detected.",
            lockExpiresIn: "900s"
        });

    } catch (error) {
        console.error("Server Error:", error);
        // تجنب انهيار السيرفر (Zero 500 Errors strategy)
        return res.status(500).json({
            success: false,
            message: "Internal Server Error during verification",
            error: error.message
        });
    }
});

// تصدير التطبيق ليعمل كـ Vercel Serverless Function
module.exports = app;
