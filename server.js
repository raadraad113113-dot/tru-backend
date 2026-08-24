const express = require('express');
const cors = require('cors');
const { Redis } = require('@upstash/redis');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// --- CORS CONFIGURATION ---
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
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

// --- LAZY INITIALIZATION CLIENTS ---
let redisClient = null;
let supabaseClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redisClient;
}

function getSupabase() {
  if (!supabaseClient) {
    supabaseClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
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
  // 1. Payload Compatibility Mapping
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

    // 3. Define Atomic Lock Key (Scoped to the Identity)
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

    // 5. Check if Lock Failed
    if (!lockAcquired) {
      return res.status(409).json({ 
        error: "DOUBLE_FINANCING_ATTEMPT_BLOCKED" 
      });
    }

    // 6. Asynchronous Audit Logging (verification_logs)
    // We do not 'await' this to keep the response time near-instant, 
    // ensuring the lock is the priority.
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
        if (error) console.error("Supabase Audit Error:", error.message);
      });

    // 7. Success Response
    return res.status(200).json({
      success: true,
      message: "Lock secured. Proceed with financing.",
      identity: nationalId,
      expires_in: "900s"
    });

  } catch (error) {
    console.error("Critical System Error:", error);
    // Return 500 but keep it structured to avoid serverless crash
    return res.status(500).json({ 
      error: "INTERNAL_SERVER_ERROR",
      message: error.message 
    });
  }
});

// Export for Vercel Serverless
module.exports = app;
