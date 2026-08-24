const express = require('express');
const cors = require('cors');
const { Redis } = require('@upstash/redis');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// --- CORS CONFIGURATION ---
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const isEmergent = /\.emergent\.sh$/.test(origin);
    const isLocal = /^http:\/\/localhost(:\d+)?$/.test(origin);
    if (isEmergent || isLocal) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// --- UTILS: URL SANITIZATION ---
function sanitizeSupabaseUrl(url) {
  if (!url || typeof url !== 'string') return null;
  
  // Strip spaces, surrounding quotes, and trailing slashes
  let sanitized = url.trim().replace(/['"]/g, '').replace(/\/+$/, '');
  
  if (!sanitized) return null;

  // Ensure protocol prefix
  if (!sanitized.startsWith('http')) {
    sanitized = `https://${sanitized}`;
  }
  
  return sanitized;
}

// --- LAZY INITIALIZATION CLIENTS ---
let redisClient = null;
let supabaseClient = null;

function getRedis() {
  if (!redisClient) {
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error("Redis configuration missing");
    }
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redisClient;
}

function getSupabase() {
  if (!supabaseClient) {
    const rawUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    const sanitizedUrl = sanitizeSupabaseUrl(rawUrl);

    if (!sanitizedUrl || !anonKey) {
      console.warn("Supabase credentials missing or invalid. Audit logging will be bypassed.");
      return null;
    }

    try {
      supabaseClient = createClient(sanitizedUrl, anonKey);
    } catch (err) {
      console.error("Supabase Initialization Error:", err.message);
      return null;
    }
  }
  return supabaseClient;
}

// --- ROUTES ---

/**
 * Health Check Path
 */
app.get('/', (req, res) => {
  res.status(200).json({
    status: "active",
    service: "TRU Double-Financing Prevention",
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /api/lock
 * Core logic for preventing double financing using Atomic Locking
 */
app.post('/api/lock', async (req, res) => {
  // 1. Payload Compatibility Mapping (Fallback logic)
  const nationalId = req.body.nationalId || req.body.hashedIdentity;
  const guaranteeId = req.body.guaranteeId || req.body.hashedGuarantee;
  const amount = req.body.amount || 0;
  const metadata = req.body.metadata || {};

  // 2. Strict Validation
  if (!nationalId || !guaranteeId) {
    return res.status(400).json({ 
      error: "National ID and Guarantee ID are required" 
    });
  }

  try {
    const redis = getRedis();
    const supabase = getSupabase();

    // 3. Define Atomic Lock Key
    const lockKey = `tru:lock:identity:${nationalId}`;

    // 4. Attempt Atomic SET with NX (Not Exists) and EX (Expire)
    // TTL: 900 seconds = 15 minutes
    const lockAcquired = await redis.set(lockKey, JSON.stringify({
      gid: guaranteeId,
      ts: Date.now()
    }), {
      nx: true,
      ex: 900
    });

    // 5. Check if Lock Failed (Double Financing Detected)
    if (!lockAcquired) {
      return res.status(409).json({ 
        error: "DOUBLE_FINANCING_ATTEMPT_BLOCKED" 
      });
    }

    // 6. Asynchronous Audit Logging
    // If Supabase client is null (failed sanitization), bypass logging without crashing.
    if (supabase) {
      supabase
        .from('verification_logs')
        .insert([
          {
            national_id: nationalId,
            guarantee_id: guaranteeId,
            amount: amount,
            status: 'LOCKED',
            metadata: metadata,
            created_at: new Date().toISOString()
          }
        ])
        .then(({ error }) => {
          if (error) console.error("Supabase Insert Failed:", error.message);
        })
        .catch(err => console.error("Supabase Async Exception:", err.message));
    }

    // 7. Success Response
    return res.status(200).json({
      success: true,
      message: "Lock secured. No double-financing detected.",
      identity: nationalId,
      expires_in: "900s"
    });

  } catch (error) {
    console.error("Critical System Error:", error);
    // Ensure the response is always JSON even on server failure
    return res.status(500).json({ 
      error: "INTERNAL_SERVER_ERROR",
      message: error.message 
    });
  }
});

// Export for Vercel Serverless
module.exports = app;
