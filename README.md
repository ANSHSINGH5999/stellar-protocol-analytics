# STELLO PROTOCOL

![Stello Protocol](https://img.shields.io/badge/Stellar-Soroban-black?logo=stellar) ![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white) ![Rust](https://img.shields.io/badge/Rust-000000?style=flat&logo=rust&logoColor=white)

Stello is a comprehensive liquid staking protocol for the Stellar (XLM) network, built on Soroban smart contracts. Users stake XLM to receive **sXLM** (Staked XLM), participate in validator delegation, and unlock ecosystem features like lending, liquidity pools, governance, and leverage.

---

## 🏗 System Architecture

This project is structured as a powerful monorepo containing everything needed to run the protocol, from on-chain contracts to the analytics frontend.

| Component | Stack | Description |
|-----------|-------|-------------|
| **`contract`** | Rust / Soroban | Smart contracts governing the sXLM token, staking logic, collateralized lending, XLM/sXLM liquidity pools, and protocol governance. |
| **`backend`** | Node.js / Fastify / Prisma | Robust backend API and off-chain services. Manages validator selection, reward distribution, risk management, keeper logic, and serves the Analytics API. |
| **`indexer`** | Node.js / PostgreSQL | Hubble-style custom blockchain indexer that listens to Stellar/Soroban events, parses liquidations, stakes, and flash loans, and persists them to the DB. |
| **`frontend`** | React / Vite / Tailwind | The primary user-facing dApp (Decentralized Application). Allows users to stake, withdraw, manage validators, supply liquidity, and participate in governance. |
| **`dashboard`** | React / Vite / Recharts | An advanced, Dune-style analytics dashboard presenting real-time protocol metrics, TVL history, utilization curves, and revenue breakdowns. |

### Technical Stack Details
- **Chain:** Stellar (Soroban). Pre-configured for Stellar Testnet.
- **Data Layer:** PostgreSQL (via Prisma ORM) for metrics, positions, validators; Redis for real-time event-bus messaging.
- **Wallet Integration:** Stellar Freighter wallet (frontend authentication and signing).
- **Backend Architecture:** Fastify for high-performance API routing, node-cron for scheduled metrics.

---

## 📜 Deployed Contract Addresses

| Contract | Address |
|----------|---------|
| **sXLM Token** | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |
| **Staking** | `CDYXKWVDGEVA6OSIGN7GRAPPRN6AKID35OJL5ZZQIBCMECZ35KGL45PS` |
| **LP Pool** | `CAW2DRMOI3CCJWKVMEUWYJUEQHXB4S4DR72HNL2DWQCMQQUH3LFFVLHV` |
| **Lending** | `CAOWXZ6BWA2ZYY7GHD75OFKADKUJS4WCKPDYGGXULQWFJRB55TXAQNJG` |
| **Governance** | `CB7LV3FBQ7US26GVC7SM7RMX22IEEHAEUL7V3TDDWM32DHA5TDFDDEP4` |

*Ensure these are set in your `.env` files for the respective components when deploying.*

---

## ⚙️ Prerequisites

Before you begin, ensure you have the following installed:
- **Node.js** (v20+ recommended)
- **Rust** and **Soroban CLI** ([Stellar Soroban Setup Guide](https://soroban.stellar.org/docs))
- **PostgreSQL** (running locally or via Docker)
- **Redis** (running locally or via Docker)
- **pnpm** or **npm** (Package manager)

---

## 🚀 Getting Started

Follow these steps to spin up the entire Stello ecosystem locally.

### 1. Smart Contracts
Navigate to the contract directory to build the Soroban contracts.

```bash
cd contract
cargo build
```
*Tip: Deploy these to your target network using the Soroban CLI and update your env variables with the outputted Contract IDs.*

### 2. Database & Redis Services
Ensure PostgreSQL and Redis are running. Create a `.env` in the `backend/` directory:
```env
DATABASE_URL="postgresql://user:password@localhost:5432/sxlm_protocol"
REDIS_URL="redis://localhost:6379"
```

### 3. Backend API Gateway
The Fastify server handles off-chain logic and serves the Analytics API.
```bash
cd backend
npm install
npx prisma generate
npx prisma db push     # Prepare the database schema
npm run seed           # (Optional) Seed DB with sample validator & metric data
npm run dev
```
*API will run at `http://localhost:3001`.*

### 4. Protocol Indexer
The custom indexer ingests Soroban events (Stakes, Liquidations, Borrows) and updates the database.
```bash
cd indexer
npm install
# Ensure DATABASE_URL is accessible here
npm run dev
```

### 5. Frontend dApp
The core user application for staking and interacting with the protocol.
```bash
cd frontend
npm install
# Configure VITE_ environment variables (see below)
npm run dev
```
*Frontend will run at `http://localhost:5173`.*

### 6. Analytics Dashboard
The Dune-style visualizer for protocol health and TVL.
```bash
cd dashboard
npm install
npm run dev
```
*Dashboard will run at `http://localhost:5174`.*

---

## 🔐 Environment Variables Summary

### `backend/.env`
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string for the event bus |
| `STELLAR_RPC_URL` | Soroban RPC endpoint (e.g. `https://soroban-testnet.stellar.org`) |
| `STELLAR_NETWORK_PASSPHRASE` | Network passphrase (e.g. `Test SDF Network ; September 2015`) |
| `SXLM_TOKEN_CONTRACT_ID` | Your deployed sXLM contract ID |
| `ADMIN_SECRET_KEY` | Admin secret key for executing backend contract txs |
| `JWT_SECRET` | Secret key for JWT auth rendering |

### `frontend/.env` & `dashboard/.env`
Note: Expose variables to Vite using the `VITE_` prefix.
| Variable | Description |
|----------|-------------|
| `VITE_NETWORK_NAME` | Target network (`TESTNET` or `MAINNET`) |
| `VITE_API_URL` | URL of the running Backend API (default `http://localhost:3001`) |
| `VITE_SXLM_TOKEN_CONTRACT_ID` | Deployed sXLM token contract ID |
| `VITE_STAKING_CONTRACT_ID` | Deployed staking contract ID |

---

## 🛠 Project Map

```text
stello_finance/
├── contract/                 # Rust Workspace: Soroban Smart Contracts
│   ├── sxlm-token/           # The yield-bearing LST
│   ├── staking/              # Delegation & Staking logic
│   ├── lending/              # Collateralized lending markets
│   ├── lp-pool/              # XLM/sXLM liquidity
│   └── governance/           # DAO parameter voting
├── backend/                  # Fastify / Node.js API
│   ├── prisma/               # Database Schema & Migrations
│   └── src/                  
│       ├── api-gateway/      # REST API Routes (Analytics, simulate, apy)
│       └── *-engine/         # Modular services (Risk, Staking, Reward, Restaking)
├── indexer/                  # Node.js Event Indexer
│   └── indexer.js            # Ingests on-chain events to PostgreSQL
├── frontend/                 # React SPA (User dApp)
│   └── src/components/       # Wallet, Stake, Govern UIs
└── dashboard/                # React SPA (Dune-style Analytics)
    └── src/                  # Recharts, TVL curves, Revenue breakdown
```

---

## 📦 Deployment Strategy

- **Backend / Indexer:** A `render.yaml` and `nixpacks.toml` are included for seamless PaaS deployment (like Render or Railway). It automatically builds Prisma and starts the Node.js server.
- **Frontend / Dashboard:** Build using `npm run build` and deploy the output `dist/` directory to Vercel, Netlify, or Cloudflare Pages.
- **Contracts:** Compile to `.wasm` via `cargo build` and deploy using Soroban CLI to Stellar Mainnet/Testnet.

---

## 📄 License
This protocol is open-source. See the included repository license file for details.
