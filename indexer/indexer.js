// indexer/indexer.js
// Hubble-style Stellar Protocol Indexer for sXLM
// Indexes REAL on-chain events from Stellar Horizon API — NO mocks, NO faker.
//
// Event detection strategy:
//   1. Poll Horizon for invoke_host_function operations per known contract IDs
//   2. Determine event_type by inspecting the function name in the XDR metadata
//   3. Parse amounts and user addresses from the Soroban event topics/data
//   4. Persist to protocol_events table with a ledger cursor for resumability

require('dotenv').config();

const { xdr, scValToNative } = require('@stellar/stellar-sdk');
const fetch = require('node-fetch');
const { Pool } = require('pg');

// ─── Config ────────────────────────────────────────────────────────────────
const HORIZON_URL   = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const DATABASE_URL  = process.env.DATABASE_URL;
const XLM_USD_PRICE = parseFloat(process.env.XLM_USD_PRICE || '0.12');

// Contract IDs to watch — reads from .env, falls back to watching all invoke_host_function ops
const WATCHED_CONTRACTS = [
  process.env.STAKING_CONTRACT_ID,
  process.env.LENDING_CONTRACT_ID,
  process.env.LP_POOL_CONTRACT_ID,
  process.env.GOVERNANCE_CONTRACT_ID,
  process.env.SXLM_TOKEN_CONTRACT_ID,
].filter(Boolean); // Remove any empty/undefined entries

const POLL_INTERVAL_MS = 5000;  // 5 seconds
const BATCH_SIZE       = 200;   // Horizon max per page

// ─── DB pool ────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL });

// ─── Event detection ─────────────────────────────────────────────────────────
// Maps Soroban function names (as they appear in invocation metadata) to our event types
const FUNCTION_EVENT_MAP = {
  'deposit': 'stake',
  'request_withdrawal': 'unstake',
  'claim_withdrawal': 'unstake',
  'borrow': 'borrow',
  'repay': 'borrow',
  'liquidate': 'liquidation',
  'liquidate_position': 'liquidation',
  'flash_loan': 'flash_loan',
  'add_liquidity': 'lp_deposit',
  'remove_liquidity': 'lp_withdraw',
  'stake': 'stake',
  'unstake': 'unstake',
};

/**
 * Detect event type from a Stellar operation record.
 */
function detectEventType(op) {
  if (op.type !== 'invoke_host_function') return null;

  // Try to read function name from the function field
  const fn = op.function || '';
  for (const [fnName, eventType] of Object.entries(FUNCTION_EVENT_MAP)) {
    if (fn.toLowerCase().includes(fnName)) return eventType;
  }

  return 'invoke'; // Generic Soroban call we don't specifically classify
}

/**
 * Try to parse amount and user address from Soroban contract events embedded in the
 * transaction metadata (resultMetaXdr). This uses the real XDR parsing via stellar-sdk.
 */
function parseContractEvents(resultMetaXdrBase64) {
  if (!resultMetaXdrBase64) return { amount: 0, user_address: '', contract_id: '' };

  try {
    const meta = xdr.TransactionMeta.fromXDR(resultMetaXdrBase64, 'base64');
    const sorobanMeta = meta?.v3?.()?.sorobanMeta?.();
    if (!sorobanMeta) return { amount: 0, user_address: '', contract_id: '' };

    const events = sorobanMeta.events?.() ?? [];
    let amount = 0;
    let user_address = '';
    let contract_id = '';

    for (const event of events) {
      try {
        const contractIdBytes = event.contractId?.();
        if (contractIdBytes) {
          // Convert contract ID bytes to StrKey
          contract_id = contractIdBytes.toString('hex');
        }

        const topics = event.body?.()?.v0?.()?.topics?.() ?? [];
        const dataVal = event.body?.()?.v0?.()?.data?.();

        if (topics.length >= 2) {
          // First topic is usually the event name (e.g., "deposit", "borrow")
          // Second topic is often the user address
          try {
            const topicStr = scValToNative(topics[0]);
            const addr = scValToNative(topics[1]);
            if (typeof addr === 'string' && addr.startsWith('G')) {
              user_address = addr;
            }
          } catch (_) {}
        }

        if (dataVal) {
          try {
            const native = scValToNative(dataVal);
            if (typeof native === 'bigint') {
              amount = Number(native) / 1e7; // Convert stroops to XLM
            } else if (typeof native === 'object' && native !== null) {
              // Struct — look for amount field
              const raw = native.amount ?? native.xlm_amount ?? native.value ?? 0;
              amount = Number(raw) / 1e7;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    return { amount, user_address, contract_id };
  } catch (err) {
    return { amount: 0, user_address: '', contract_id: '' };
  }
}

/**
 * Revenue multipliers per event type (as bps fraction of amount)
 */
function calcRevenue(eventType, amountUsd) {
  switch (eventType) {
    case 'stake':       return amountUsd * 0.0010; // 0.1% staking fee
    case 'borrow':      return amountUsd * 0.0050; // 0.5% borrow fee
    case 'liquidation': return amountUsd * 0.0200; // 2% liquidation penalty
    case 'flash_loan':  return amountUsd * 0.0009; // 0.09% flash loan fee
    case 'lp_deposit':  return amountUsd * 0.0003; // 0.03% LP fee
    default:            return 0;
  }
}

// ─── Cursor management ───────────────────────────────────────────────────────
async function getLastIndexedPagingToken(cursorKey) {
  const res = await pool.query(
    'SELECT paging_token FROM ledger_cursors WHERE contract_id = $1',
    [cursorKey]
  );
  return res.rows[0]?.paging_token ?? null;
}

async function updateCursor(cursorKey, pagingToken, ledger) {
  await pool.query(
    `INSERT INTO ledger_cursors (contract_id, last_ledger, paging_token, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (contract_id) DO UPDATE SET
       last_ledger  = EXCLUDED.last_ledger,
       paging_token = EXCLUDED.paging_token,
       updated_at   = NOW()`,
    [cursorKey, ledger, pagingToken]
  );
}

// ─── Schema setup ────────────────────────────────────────────────────────────
async function ensureSchema() {
  // Add paging_token to ledger_cursors if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS protocol_events (
      id            BIGSERIAL       PRIMARY KEY,
      ledger        BIGINT          NOT NULL,
      timestamp     TIMESTAMPTZ     NOT NULL,
      event_type    VARCHAR(50)     NOT NULL,
      user_address  VARCHAR(56)     NOT NULL DEFAULT '',
      contract_id   VARCHAR(56)     DEFAULT '',
      asset         VARCHAR(20)     DEFAULT 'XLM',
      amount        NUMERIC(38,7)   DEFAULT 0,
      amount_usd    NUMERIC(38,7)   DEFAULT 0,
      revenue_usd   NUMERIC(38,7)   DEFAULT 0,
      tx_hash       VARCHAR(64)     UNIQUE NOT NULL,
      raw_data      JSONB
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_cursors (
      contract_id   VARCHAR(56)   PRIMARY KEY,
      last_ledger   BIGINT        NOT NULL DEFAULT 0,
      paging_token  VARCHAR(128),
      updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON protocol_events (timestamp DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_type_ts   ON protocol_events (event_type, timestamp DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_user      ON protocol_events (user_address)`);

  console.log('[DB] Schema ready');
}

// ─── Core indexing ───────────────────────────────────────────────────────────
async function fetchAndIndexOperations(cursorKey, pagingToken) {
  let url = `${HORIZON_URL}/operations?limit=${BATCH_SIZE}&order=asc&include_failed=false&join=transactions`;
  if (pagingToken) url += `&cursor=${pagingToken}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Horizon HTTP ${res.status}: ${url}`);

  const json = await res.json();
  const ops  = json._embedded?.records ?? [];

  if (ops.length === 0) return { count: 0, lastToken: pagingToken, lastLedger: 0 };

  let stored = 0;
  let lastToken  = pagingToken;
  let lastLedger = 0;

  for (const op of ops) {
    lastToken  = op.paging_token;
    lastLedger = op.transaction?.ledger ?? lastLedger;

    if (op.type !== 'invoke_host_function') continue;

    // If we're watching specific contracts, filter here
    const opContractId = op.function?.split(':')[0] ?? '';
    if (WATCHED_CONTRACTS.length > 0 && opContractId && !WATCHED_CONTRACTS.includes(opContractId)) {
      continue;
    }

    const eventType = detectEventType(op);
    if (!eventType) continue;

    const txHash = op.transaction_hash;
    const ts     = op.created_at;
    const ledger = op.transaction?.ledger ?? 0;
    const sourceAccount = op.source_account ?? op.transaction?.source_account ?? '';

    // Parse Soroban events from the transaction XDR if available
    const xdrMeta = op.transaction?.result_meta_xdr;
    const { amount, user_address, contract_id } = parseContractEvents(xdrMeta);

    const resolvedUser  = user_address || sourceAccount;
    const amountUsd     = amount * XLM_USD_PRICE;
    const revenueUsd    = calcRevenue(eventType, amountUsd);

    try {
      await pool.query(
        `INSERT INTO protocol_events
           (ledger, timestamp, event_type, user_address, contract_id, asset, amount, amount_usd, revenue_usd, tx_hash, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [
          ledger,
          ts,
          eventType,
          resolvedUser,
          contract_id || opContractId,
          'XLM',
          amount,
          amountUsd,
          revenueUsd,
          txHash,
          JSON.stringify({ op_type: op.type, function: op.function, source: 'stellar_horizon' }),
        ]
      );
      stored++;
    } catch (err) {
      if (!err.message.includes('unique')) {
        console.error(`[Indexer] Insert error: ${err.message}`);
      }
    }
  }

  // Update cursor
  if (lastToken) {
    await updateCursor(cursorKey, lastToken, lastLedger);
  }

  return { count: stored, lastToken, lastLedger };
}

// ─── Main polling loop ────────────────────────────────────────────────────────
async function runIndexer() {
  const CURSOR_KEY = 'global';
  let pagingToken  = await getLastIndexedPagingToken(CURSOR_KEY);

  console.log(`[Indexer] Starting from paging token: ${pagingToken ?? 'genesis'}`);
  if (WATCHED_CONTRACTS.length > 0) {
    console.log(`[Indexer] Watching contracts: ${WATCHED_CONTRACTS.join(', ')}`);
  } else {
    console.log('[Indexer] No contract IDs set — indexing ALL invoke_host_function operations on testnet');
  }

  async function poll() {
    try {
      const { count, lastToken, lastLedger } = await fetchAndIndexOperations(CURSOR_KEY, pagingToken);
      if (count > 0) {
        console.log(`[Indexer] Stored ${count} new events | ledger ${lastLedger}`);
      }
      if (lastToken) pagingToken = lastToken;
    } catch (err) {
      console.error(`[Indexer] Poll error: ${err.message}`);
    }
  }

  // Initial catch-up run (backfill)
  await poll();

  // Live polling
  setInterval(poll, POLL_INTERVAL_MS);
  console.log(`[Indexer] Live polling every ${POLL_INTERVAL_MS / 1000}s`);
}

async function main() {
  if (!DATABASE_URL) {
    console.error('[Indexer] ERROR: DATABASE_URL not set in .env');
    process.exit(1);
  }

  await pool.connect();
  await ensureSchema();
  await runIndexer();
}

main().catch((err) => {
  console.error('[Indexer] Fatal:', err);
  process.exit(1);
});
