import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  AreaChart, Area,
  LineChart, Line,
  BarChart, Bar,
  ComposedChart,
  XAxis, YAxis,
  CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, Legend,
} from 'recharts'

// ─── API endpoints (reads VITE_API_URL or falls back to relative path for local proxy) ───
const BASE       = import.meta.env.VITE_API_URL ?? ''
const ANALYTICS  = `${BASE}/api/analytics`
const BACKEND    = `${BASE}/api`

// ─── Shared types ────────────────────────────────────────────────────────────
interface TvlPoint      { date: string; tvl_usd: number; exchange_rate: number }
interface UtilPoint     { date: string; total_staked: number; total_borrowed: number; utilization: number }
interface RevenuePoint  { date: string; total: number; stake_revenue?: number; borrow_revenue?: number; liquidation_revenue?: number; flash_loan_revenue?: number }
interface EventRow      { id: number; event_type: string; user_address: string; amount: number; amount_usd: number; revenue_usd: number; timestamp: string; tx_hash: string }
interface CohortRow     { wallet: string; collateral_xlm: number; borrowed_xlm: number; health_factor: number; activities: string[] }
interface RealtimeData  { realtime_24h: Record<string, number|string>; all_time: Record<string, number|string> }
interface ProtocolStats { tvlUsd: number; exchangeRate: number; isPaused: boolean; protocolFeePct: number; liquidityBuffer: number }
interface ApyData       { currentApy: number; currentApr: number; exchangeRate: number }

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n: unknown, dec = 2): string {
  const v = Number(n)
  if (isNaN(v)) return '—'
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(dec === 0 ? 0 : 1) + 'K'
  return v.toFixed(dec)
}
function fmtDate(d: string) { return d ? d.slice(5, 10) : '' }
function fmtAddr(s: string) { return s ? s.slice(0, 6) + '…' + s.slice(-4) : '—' }
function fmtTime(s: string) { return s ? new Date(s).toLocaleTimeString() : '—' }

function badgeClass(type: string) {
  const map: Record<string, string> = {
    stake: 'badge-stake', unstake: 'badge-unstake', borrow: 'badge-borrow',
    liquidation: 'badge-liquidation', flash_loan: 'badge-flash_loan',
    lp_deposit: 'badge-lp_deposit', lp_withdraw: 'badge-lp_withdraw',
  }
  return `badge ${map[type] ?? 'badge-borrow'}`
}
function healthClass(hf: number) {
  if (!hf) return ''
  return hf > 1.5 ? 'health-good' : hf > 1.1 ? 'health-warn' : 'health-bad'
}

// ─── Custom hook: fetch with auto-refresh ─────────────────────────────────────
function useLive<T>(url: string, init: T, intervalMs = 0): { data: T; loading: boolean; error: string | null } {
  const [data, setData]       = useState<T>(init)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'fetch error')
    } finally {
      setLoading(false)
    }
  }, [url])

  useEffect(() => {
    load()
    if (intervalMs > 0) {
      const id = setInterval(load, intervalMs)
      return () => clearInterval(id)
    }
  }, [load, intervalMs])

  return { data, loading, error }
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
const TT = { contentStyle: { background: '#0d0f18', border: '1px solid #252b42', borderRadius: 10, fontSize: 12 }, labelStyle: { color: '#7e8eb0' }, itemStyle: { color: '#f1f5f9' } }

// ─── KPI Card ─────────────────────────────────────────────────────────────────
function KPI({ label, value, sub, color, icon }: { label: string; value: string; sub?: string; color: string; icon?: string }) {
  return (
    <div className="card">
      <div className="card-accent" style={{ background: `linear-gradient(90deg, ${color}, transparent)` }} />
      {icon && <div className="kpi-icon">{icon}</div>}
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={{ color }}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

// ─── Shimmer placeholder ─────────────────────────────────────────────────────
function Shimmer() {
  return <div className="loading-shimmer" />
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [now, setNow] = useState(() => new Date().toLocaleTimeString())
  const timerRef = useRef<ReturnType<typeof setInterval>>()
  useEffect(() => {
    timerRef.current = setInterval(() => setNow(new Date().toLocaleTimeString()), 1000)
    return () => clearInterval(timerRef.current)
  }, [])

  // Data feeds
  const rt       = useLive<RealtimeData | null>(`${ANALYTICS}/realtime-metrics`, null, 10_000)
  const tvl      = useLive<{ data: TvlPoint[] }>(`${ANALYTICS}/tvl-history?days=90`, { data: [] })
  const util     = useLive<{ data: UtilPoint[] }>(`${ANALYTICS}/utilization-curves?days=30`, { data: [] })
  const rev      = useLive<{ data: RevenuePoint[] }>(`${ANALYTICS}/revenue-breakdown?days=30`, { data: [] })
  const cohorts  = useLive<{ data: CohortRow[]; count: number }>(`${ANALYTICS}/user-cohorts?limit=50`, { data: [], count: 0 })
  const events   = useLive<{ data: EventRow[]; total: number }>(`${ANALYTICS}/events?limit=40`, { data: [], total: 0 }, 10_000)
  const ps       = useLive<ProtocolStats | null>(`${BACKEND}/protocol-stats`, null, 30_000)
  const apy      = useLive<ApyData | null>(`${BACKEND}/apy`, null, 60_000)

  // Derived KPIs
  const tvlUsd       = ps.data?.tvlUsd ?? 0
  const currentApy   = apy.data?.currentApy ?? 0
  const rev24h       = Number(rt.data?.realtime_24h?.total_revenue_usd ?? 0)
  const users24h     = Number(rt.data?.realtime_24h?.active_users ?? 0)
  const totalUsers   = Number(rt.data?.all_time?.total_users ?? 0)
  const stakes24h    = Number(rt.data?.realtime_24h?.stake_count ?? 0)
  const liquids24h   = Number(rt.data?.realtime_24h?.liquidation_count ?? 0)
  const flash24h     = Number(rt.data?.realtime_24h?.flash_loan_count ?? 0)
  const vol24h       = Number(rt.data?.realtime_24h?.total_volume_usd ?? 0)
  const allTimeVol   = Number(rt.data?.all_time?.total_volume_usd ?? 0)
  const utilCurrent  = util.data.data.length
    ? util.data.data[util.data.data.length - 1].utilization
    : 0
  const totalEvents  = events.data.total ?? 0

  return (
    <div className="page">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="header">
        <div>
          <div className="logo">⬡ sXLM Protocol Analytics</div>
          <div className="logo-sub">Real-time on-chain data · Stellar Testnet · No mocks</div>
        </div>
        <div className="header-right">
          {ps.data?.isPaused && (
            <span className="badge badge-liquidation">⚠ Protocol Paused</span>
          )}
          <div className="live-badge">
            <div className="live-dot" />
            Live
          </div>
          <span className="ts">{now}</span>
        </div>
      </header>

      {/* ── KPI Row 1 ──────────────────────────────────────────────────────── */}
      <div className="section-label">Key Metrics</div>
      <div className="grid-4" style={{ marginBottom: 14 }}>
        <KPI label="Total Value Locked"  value={`$${fmt(tvlUsd)}`}              color="var(--primary)" icon="💎" sub="Staked XLM in protocol" />
        <KPI label="Protocol APY"         value={`${currentApy.toFixed(2)}%`}    color="var(--green)"   icon="📈" sub="Exchange rate–derived" />
        <KPI label="24h Revenue"          value={`$${fmt(rev24h)}`}              color="var(--amber)"   icon="💰" sub="Staking + borrow + LP fees" />
        <KPI label="Utilization Rate"     value={`${utilCurrent.toFixed(1)}%`}   color="var(--cyan)"    icon="📊" sub="Borrowed / Staked" />
      </div>
      <div className="grid-4">
        <KPI label="Active Users (24h)"   value={fmt(users24h, 0)}               color="var(--purple)"  icon="👤" sub={`${fmt(totalUsers, 0)} total`} />
        <KPI label="All-Time Volume"      value={`$${fmt(allTimeVol)}`}          color="var(--text)"    icon="🔄" sub={`$${fmt(vol24h)} today`} />
        <KPI label="Liquidations (24h)"   value={fmt(liquids24h, 0)}             color="var(--red)"     icon="⚡" sub="Positions liquidated" />
        <KPI label="Flash Loans (24h)"    value={fmt(flash24h, 0)}               color="var(--cyan)"    icon="🌊" sub="From lending pool" />
      </div>

      {/* ── TVL + Utilization ──────────────────────────────────────────────── */}
      <div className="section-label" style={{ marginTop: 24 }}>Historical Trends</div>
      <div className="grid-2">
        <div className="card">
          <div className="chart-title">TVL History — 90 Days</div>
          <div className="chart-sub">Cumulative staked XLM value in USD</div>
          {tvl.loading ? <Shimmer /> : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={tvl.data.data}>
                <defs>
                  <linearGradient id="gTvl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 4" stroke="#1a1f32" />
                <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: '#4b5678', fontSize: 10 }} />
                <YAxis tickFormatter={v => `$${fmt(v, 0)}`} tick={{ fill: '#4b5678', fontSize: 10 }} />
                <RTooltip {...TT} formatter={(v: unknown) => [`$${fmt(v)}`, 'TVL']} />
                <Area type="monotone" dataKey="tvl_usd" stroke="#6366f1" fill="url(#gTvl)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
          {tvl.data.data.length === 0 && !tvl.loading && (
            <div className="empty-state"><div className="empty-icon">📭</div>No TVL data yet — indexer is collecting events</div>
          )}
        </div>

        <div className="card">
          <div className="chart-title">Utilization Curve — 30 Days</div>
          <div className="chart-sub">Borrowed vs Staked XLM (daily aggregates)</div>
          {util.loading ? <Shimmer /> : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={util.data.data}>
                <CartesianGrid strokeDasharray="2 4" stroke="#1a1f32" />
                <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: '#4b5678', fontSize: 10 }} />
                <YAxis tickFormatter={v => fmt(v, 0) + ' XLM'} tick={{ fill: '#4b5678', fontSize: 10 }} />
                <RTooltip {...TT} formatter={(v: unknown, k: string) => [`${fmt(v)} XLM`, k]} />
                <Legend />
                <Line type="monotone" dataKey="total_staked"   stroke="#10b981" strokeWidth={2} dot={false} name="Staked" />
                <Line type="monotone" dataKey="total_borrowed" stroke="#f59e0b" strokeWidth={2} dot={false} name="Borrowed" />
              </LineChart>
            </ResponsiveContainer>
          )}
          {util.data.data.length === 0 && !util.loading && (
            <div className="empty-state"><div className="empty-icon">📊</div>Utilization data will appear once events are indexed</div>
          )}
        </div>
      </div>

      {/* ── Revenue + APY ──────────────────────────────────────────────────── */}
      <div className="grid-2">
        <div className="card">
          <div className="chart-title">Revenue Breakdown — 30 Days</div>
          <div className="chart-sub">Daily protocol revenue by source in USD</div>
          {rev.loading ? <Shimmer /> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={rev.data.data}>
                <CartesianGrid strokeDasharray="2 4" stroke="#1a1f32" />
                <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: '#4b5678', fontSize: 10 }} />
                <YAxis tickFormatter={v => `$${fmt(v, 0)}`} tick={{ fill: '#4b5678', fontSize: 10 }} />
                <RTooltip {...TT} formatter={(v: unknown) => [`$${fmt(v)}`, 'Revenue']} />
                <Legend />
                <Bar dataKey="stake_revenue"       fill="#10b981" name="Staking"      radius={[2,2,0,0]} />
                <Bar dataKey="borrow_revenue"      fill="#f59e0b" name="Borrow"       radius={[2,2,0,0]} />
                <Bar dataKey="liquidation_revenue" fill="#ef4444" name="Liquidation"  radius={[2,2,0,0]} />
                <Bar dataKey="flash_loan_revenue"  fill="#a855f7" name="Flash Loan"   radius={[2,2,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
          {rev.data.data.length === 0 && !rev.loading && (
            <div className="empty-state"><div className="empty-icon">💰</div>Revenue data will populate as protocol earns fees</div>
          )}
        </div>

        <div className="card">
          <div className="chart-title">Exchange Rate History — 90 Days</div>
          <div className="chart-sub">sXLM/XLM exchange rate growth (compounding rewards)</div>
          {tvl.loading ? <Shimmer /> : (
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={tvl.data.data}>
                <defs>
                  <linearGradient id="gEr" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 4" stroke="#1a1f32" />
                <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: '#4b5678', fontSize: 10 }} />
                <YAxis tickFormatter={v => v.toFixed(4)} tick={{ fill: '#4b5678', fontSize: 10 }} domain={['auto', 'auto']} />
                <RTooltip {...TT} formatter={(v: unknown) => [Number(v).toFixed(7), 'Exchange Rate']} />
                <Area type="monotone" dataKey="exchange_rate" stroke="#10b981" fill="url(#gEr)" strokeWidth={2} dot={false} name="ER" />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── User Cohorts ───────────────────────────────────────────────────── */}
      <div className="section-label" style={{ marginTop: 4 }}>User Analysis</div>
      <div className="grid-2">
        <div className="card">
          <div className="section-header">
            <div>
              <div className="chart-title">Top User Cohorts</div>
              <div className="chart-sub">By position size — lending + LP + staking</div>
            </div>
            <span className="event-count">{cohorts.data.count} wallets</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Collateral</th>
                  <th>Borrowed</th>
                  <th>Health</th>
                  <th>Roles</th>
                </tr>
              </thead>
              <tbody>
                {cohorts.data.data.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: 28, textAlign: 'center', color: 'var(--muted)' }}>
                    No cohort data yet — indexer is running
                  </td></tr>
                ) : cohorts.data.data.slice(0, 25).map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: 'var(--mono)', color: 'var(--primary)', fontSize: 11 }}>{fmtAddr(r.wallet)}</td>
                    <td>{fmt(r.collateral_xlm ?? 0)} XLM</td>
                    <td>{fmt(r.borrowed_xlm ?? 0)} XLM</td>
                    <td className={healthClass(r.health_factor)}>{r.health_factor ? r.health_factor.toFixed(2) : '—'}</td>
                    <td>
                      {(r.activities ?? []).slice(0, 2).map((a: string) => (
                        <span key={a} className={badgeClass(a)} style={{ marginRight: 3 }}>{a}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Live Event Feed ───────────────────────────────────────────────── */}
        <div className="card">
          <div className="section-header">
            <div>
              <div className="chart-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="live-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 8px var(--green)', display: 'inline-block' }} />
                Live Event Feed
              </div>
              <div className="chart-sub">Most recent on-chain events · 10s refresh</div>
            </div>
            <span className="event-count">{fmt(totalEvents, 0)} total</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>User</th>
                  <th>Amount</th>
                  <th>Revenue</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {events.data.data.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: 28, textAlign: 'center', color: 'var(--muted)' }}>
                    Waiting for on-chain events from indexer…
                  </td></tr>
                ) : events.data.data.map((e, i) => (
                  <tr key={i}>
                    <td><span className={badgeClass(e.event_type)}>{e.event_type}</span></td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtAddr(e.user_address)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(e.amount)} XLM</td>
                    <td style={{ color: 'var(--green)', fontVariantNumeric: 'tabular-nums' }}>${fmt(e.revenue_usd)}</td>
                    <td style={{ color: 'var(--muted)' }}>{fmtTime(e.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Protocol Status ────────────────────────────────────────────────── */}
      {ps.data && (
        <>
          <div className="section-label" style={{ marginTop: 4 }}>Protocol Status</div>
          <div className="grid-4">
            <KPI label="Exchange Rate"     value={ps.data.exchangeRate.toFixed(7)}               color="var(--text)"   sub="sXLM / XLM" />
            <KPI label="Liquidity Buffer"  value={`${fmt(ps.data.liquidityBuffer)} XLM`}          color="var(--cyan)"   sub="Withdrawal reserve" />
            <KPI label="Protocol Fee"      value={`${ps.data.protocolFeePct.toFixed(1)}%`}        color="var(--amber)"  sub="Applied on rewards" />
            <KPI label="Status"            value={ps.data.isPaused ? 'Paused ⚠' : 'Active ✓'}   color={ps.data.isPaused ? 'var(--red)' : 'var(--green)'} sub="Contract state" />
          </div>
        </>
      )}

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="footer">
        <div className="footer-text">
          sXLM Protocol Analytics · Data from Stellar Horizon &amp; Soroban RPC · All values are real on-chain data
        </div>
        <div className="footer-text" style={{ display: 'flex', gap: 16 }}>
          <span>Indexer: <code style={{ color: 'var(--sub)', fontFamily: 'var(--mono)', fontSize: 11 }}>:3000</code></span>
          <span>Analytics API: <code style={{ color: 'var(--sub)', fontFamily: 'var(--mono)', fontSize: 11 }}>:3002</code></span>
          <span>Backend: <code style={{ color: 'var(--sub)', fontFamily: 'var(--mono)', fontSize: 11 }}>:3001</code></span>
        </div>
      </footer>
    </div>
  )
}
