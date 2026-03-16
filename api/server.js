// api/server.js — sXLM Protocol Analytics API
// Real SQL queries against protocol_events. No mocks. Redis caching.

require('dotenv').config({ path: '../backend/.env' });
const express   = require('express');
const { Pool }  = require('pg');
const cors      = require('cors');
const redis     = require('redis');
const rateLimit = require('express-rate-limit');

const app       = express();
const PORT      = process.env.ANALYTICS_PORT || 3002;
const DB_URL    = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── DB Pool ─────────────────────────────────────────────────────────────────
const db = new Pool({ connectionString: DB_URL });

// ─── Redis Client ─────────────────────────────────────────────────────────────
let redisClient = null;

async function connectRedis() {
  try {
    redisClient = redis.createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.warn('[Redis] Error:', err.message));
    await redisClient.connect();
    console.log('[Redis] Connected');
  } catch (err) {
    console.warn('[Redis] Not available, caching disabled:', err.message);
    redisClient = null;
  }
}

async function cached(key, ttlSeconds, fn) {
  if (redisClient) {
    try {
      const hit = await redisClient.get(key);
      if (hit) return JSON.parse(hit);
    } catch (_) {}
  }
  const result = await fn();
  if (redisClient) {
    try {
      await redisClient.setEx(key, ttlSeconds, JSON.stringify(result));
    } catch (_) {}
  }
  return result;
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── TVL History ──────────────────────────────────────────────────────────────
// Returns daily cumulative staked XLM (as USD) — proxy for TVL
app.get('/api/analytics/tvl-history', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '90', 10), 365);
  try {
    const data = await cached(`tvl-history:${days}`, 60, async () => {
      const { rows } = await db.query(`
        SELECT
          DATE(timestamp)                           AS date,
          SUM(CASE WHEN event_type = 'stake'
               THEN amount_usd ELSE 0 END)          AS staked_usd,
          SUM(CASE WHEN event_type = 'unstake'
               THEN amount_usd ELSE 0 END)          AS unstaked_usd,
          SUM(amount_usd)                           AS total_volume_usd,
          COUNT(DISTINCT user_address)              AS unique_users
        FROM protocol_events
        WHERE timestamp >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY DATE(timestamp)
        ORDER BY date ASC
      `, [days]);

      // Compute running TVL (staked - unstaked cumulative)
      let runningTvl = 0;
      return rows.map(r => {
        runningTvl += parseFloat(r.staked_usd || 0) - parseFloat(r.unstaked_usd || 0);
        return {
          date:          r.date,
          tvl:           Math.max(0, runningTvl),
          staked_usd:    parseFloat(r.staked_usd || 0),
          unstaked_usd:  parseFloat(r.unstaked_usd || 0),
          total_volume:  parseFloat(r.total_volume_usd || 0),
          unique_users:  parseInt(r.unique_users || 0),
        };
      });
    });
    res.json({ data, count: data.length });
  } catch (err) {
    console.error('/tvl-history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Utilization Curves ────────────────────────────────────────────────────────
app.get('/api/analytics/utilization-curves', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10), 180);
  try {
    const data = await cached(`utilization:${days}`, 60, async () => {
      const { rows } = await db.query(`
        SELECT
          DATE(timestamp)                                            AS date,
          SUM(CASE WHEN event_type = 'stake'   THEN amount ELSE 0 END) AS total_staked,
          SUM(CASE WHEN event_type = 'borrow'  THEN amount ELSE 0 END) AS total_borrowed,
          SUM(CASE WHEN event_type = 'lp_deposit' THEN amount ELSE 0 END) AS lp_supplied,
          COUNT(CASE WHEN event_type = 'borrow' THEN 1 END)          AS borrow_count,
          COUNT(CASE WHEN event_type = 'stake'  THEN 1 END)          AS stake_count
        FROM protocol_events
        WHERE timestamp >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY DATE(timestamp)
        ORDER BY date ASC
      `, [days]);

      return rows.map(r => {
        const staked   = parseFloat(r.total_staked  || 0);
        const borrowed = parseFloat(r.total_borrowed || 0);
        const util     = staked > 0 ? Math.min(borrowed / staked, 1) : 0;
        return {
          date:           r.date,
          total_staked:   staked,
          total_borrowed: borrowed,
          lp_supplied:    parseFloat(r.lp_supplied || 0),
          utilization:    parseFloat((util * 100).toFixed(2)),
          borrow_count:   parseInt(r.borrow_count || 0),
          stake_count:    parseInt(r.stake_count  || 0),
        };
      });
    });
    res.json({ data, count: data.length });
  } catch (err) {
    console.error('/utilization-curves error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Revenue Breakdown ────────────────────────────────────────────────────────
app.get('/api/analytics/revenue-breakdown', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10), 180);
  try {
    const data = await cached(`revenue:${days}`, 60, async () => {
      const { rows } = await db.query(`
        SELECT
          DATE(timestamp)                  AS date,
          event_type,
          SUM(revenue_usd)                 AS revenue,
          SUM(amount_usd)                  AS volume,
          COUNT(*)                         AS event_count
        FROM protocol_events
        WHERE timestamp >= NOW() - ($1 || ' days')::INTERVAL
          AND revenue_usd > 0
        GROUP BY DATE(timestamp), event_type
        ORDER BY date ASC, revenue DESC
      `, [days]);

      // Pivot into daily rows with revenue per event type
      const byDate = {};
      for (const r of rows) {
        const d = r.date;
        if (!byDate[d]) byDate[d] = { date: d, total: 0 };
        byDate[d][r.event_type + '_revenue']  = parseFloat(r.revenue || 0);
        byDate[d][r.event_type + '_volume']   = parseFloat(r.volume  || 0);
        byDate[d][r.event_type + '_count']    = parseInt(r.event_count || 0);
        byDate[d].total += parseFloat(r.revenue || 0);
      }
      return Object.values(byDate).sort((a, b) => a.date > b.date ? 1 : -1);
    });
    res.json({ data, count: data.length });
  } catch (err) {
    console.error('/revenue-breakdown error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── User Cohort Analysis ──────────────────────────────────────────────────────
app.get('/api/analytics/user-cohorts', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  try {
    const data = await cached(`cohorts:${limit}`, 120, async () => {
      const { rows } = await db.query(`
        SELECT
          user_address,
          COUNT(*)                          AS tx_count,
          SUM(amount_usd)                   AS total_volume_usd,
          AVG(amount)                       AS avg_position_xlm,
          AVG(amount_usd)                   AS avg_position_usd,
          MIN(timestamp)                    AS first_seen,
          MAX(timestamp)                    AS last_seen,
          COUNT(DISTINCT DATE(timestamp))   AS active_days,
          EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 86400.0
                                            AS lifespan_days,
          array_agg(DISTINCT event_type ORDER BY event_type) AS event_types
        FROM protocol_events
        WHERE user_address != ''
        GROUP BY user_address
        ORDER BY tx_count DESC
        LIMIT $1
      `, [limit]);

      return rows.map(r => ({
        user_address:      r.user_address,
        tx_count:          parseInt(r.tx_count),
        total_volume_usd:  parseFloat(r.total_volume_usd  || 0).toFixed(2),
        avg_position_xlm:  parseFloat(r.avg_position_xlm  || 0).toFixed(4),
        avg_position_usd:  parseFloat(r.avg_position_usd  || 0).toFixed(2),
        first_seen:        r.first_seen,
        last_seen:         r.last_seen,
        active_days:       parseInt(r.active_days),
        lifespan_days:     parseFloat(r.lifespan_days      || 0).toFixed(1),
        event_types:       r.event_types,
        retention_score:   r.lifespan_days > 0
          ? parseFloat((parseInt(r.active_days) / Math.max(parseFloat(r.lifespan_days), 1) * 100).toFixed(1))
          : 0,
      }));
    });
    res.json({ data, count: data.length });
  } catch (err) {
    console.error('/user-cohorts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Paginated Event Feed ─────────────────────────────────────────────────────
app.get('/api/analytics/events', async (req, res) => {
  const type  = req.query.type;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const page  = Math.max(parseInt(req.query.page  || '1', 10), 1);
  const offset = (page - 1) * limit;

  try {
    let query = `
      SELECT id, ledger, timestamp, event_type, user_address, contract_id,
             asset, amount, amount_usd, revenue_usd, tx_hash
      FROM protocol_events
    `;
    const params = [];
    if (type) {
      params.push(type);
      query += ` WHERE event_type = $${params.length}`;
    }
    query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows }    = await db.query(query, params);
    const countQ      = type
      ? `SELECT COUNT(*) FROM protocol_events WHERE event_type = $1`
      : `SELECT COUNT(*) FROM protocol_events`;
    const countRes    = await db.query(countQ, type ? [type] : []);
    const totalCount  = parseInt(countRes.rows[0].count);

    res.json({
      data:       rows,
      total:      totalCount,
      page,
      limit,
      pages:      Math.ceil(totalCount / limit),
    });
  } catch (err) {
    console.error('/events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Realtime 24h Metrics ─────────────────────────────────────────────────────
app.get('/api/analytics/realtime-metrics', async (req, res) => {
  try {
    const data = await cached('realtime', 10, async () => {
      const { rows: [r] } = await db.query(`
        SELECT
          COUNT(*)                                                              AS total_events_24h,
          COUNT(DISTINCT user_address)                                          AS active_users_24h,
          SUM(amount_usd)                                                       AS total_volume_24h,
          SUM(revenue_usd)                                                      AS total_revenue_24h,
          SUM(CASE WHEN event_type = 'stake'       THEN amount_usd ELSE 0 END) AS staked_24h,
          SUM(CASE WHEN event_type = 'borrow'      THEN amount_usd ELSE 0 END) AS borrowed_24h,
          SUM(CASE WHEN event_type = 'liquidation' THEN amount_usd ELSE 0 END) AS liquidated_24h,
          SUM(CASE WHEN event_type = 'flash_loan'  THEN amount_usd ELSE 0 END) AS flash_loan_24h,
          COUNT(CASE WHEN event_type = 'stake'      THEN 1 END)               AS stake_count_24h,
          COUNT(CASE WHEN event_type = 'borrow'     THEN 1 END)               AS borrow_count_24h,
          COUNT(CASE WHEN event_type = 'liquidation' THEN 1 END)              AS liquidation_count_24h,
          COUNT(CASE WHEN event_type = 'flash_loan'  THEN 1 END)              AS flash_loan_count_24h
        FROM protocol_events
        WHERE timestamp >= NOW() - INTERVAL '24 hours'
      `);

      const totalSinceStart = await db.query(`
        SELECT
          COUNT(DISTINCT user_address) AS total_users,
          SUM(amount_usd)              AS total_volume_all_time,
          SUM(revenue_usd)             AS total_revenue_all_time,
          MIN(timestamp)               AS first_event_at
        FROM protocol_events
      `);
      const s = totalSinceStart.rows[0];

      return {
        realtime_24h: {
          total_events:    parseInt(r?.total_events_24h   || 0),
          active_users:    parseInt(r?.active_users_24h   || 0),
          total_volume_usd: parseFloat(r?.total_volume_24h  || 0).toFixed(2),
          total_revenue_usd: parseFloat(r?.total_revenue_24h || 0).toFixed(2),
          staked_usd:      parseFloat(r?.staked_24h        || 0).toFixed(2),
          borrowed_usd:    parseFloat(r?.borrowed_24h      || 0).toFixed(2),
          liquidated_usd:  parseFloat(r?.liquidated_24h    || 0).toFixed(2),
          flash_loan_usd:  parseFloat(r?.flash_loan_24h    || 0).toFixed(2),
          stake_count:     parseInt(r?.stake_count_24h      || 0),
          borrow_count:    parseInt(r?.borrow_count_24h     || 0),
          liquidation_count: parseInt(r?.liquidation_count_24h || 0),
          flash_loan_count:  parseInt(r?.flash_loan_count_24h  || 0),
        },
        all_time: {
          total_users:       parseInt(s?.total_users          || 0),
          total_volume_usd:  parseFloat(s?.total_volume_all_time || 0).toFixed(2),
          total_revenue_usd: parseFloat(s?.total_revenue_all_time || 0).toFixed(2),
          first_event_at:    s?.first_event_at,
        },
        generated_at: new Date().toISOString(),
      };
    });
    res.json(data);
  } catch (err) {
    console.error('/realtime-metrics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Startup ────────────────────────────────────────────────────────────────
async function main() {
  if (!DB_URL) {
    console.error('[API] ERROR: DATABASE_URL not set in .env');
    process.exit(1);
  }

  await connectRedis();
  await db.connect();
  console.log('[DB] Connected to PostgreSQL');

  app.listen(PORT, () => {
    console.log(`[API] sXLM Analytics API running on http://localhost:${PORT}`);
    console.log(`[API] Endpoints:`);
    console.log(`       GET /api/analytics/tvl-history?days=90`);
    console.log(`       GET /api/analytics/utilization-curves?days=30`);
    console.log(`       GET /api/analytics/revenue-breakdown?days=30`);
    console.log(`       GET /api/analytics/user-cohorts?limit=100`);
    console.log(`       GET /api/analytics/events?type=stake&limit=50&page=1`);
    console.log(`       GET /api/analytics/realtime-metrics`);
  });
}

main().catch(err => {
  console.error('[API] Fatal:', err);
  process.exit(1);
});
