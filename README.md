# ⚡ Telegram Alert Listener & Meteora DLMM Automated Trader

Sistem otomatisasi trading **Meteora DLMM (Solana)** berkecepatan tinggi yang mendengarkan alert Telegram secara real-time, membuka posisi **Double Side dengan fitur 2-Step Zap In** dari modal SOL, dan memantau posisi 24/7 setiap 3 detik untuk mengeksekusi **Take Profit (TP)**, **Stop Loss (SL)**, serta **Trailing Stop Profit Lock-in**.

Dilengkapi dengan **Bot Notifikasi Telegram Pribadi** & **Menu Perintah Interaktif UI** (`/status`, `/active`, `/history`, `/stopbot`, `/startbot`).

---

## 🌟 Fitur Utama

- **⚡ Real-Time Telegram Listener (Python Pyrogram)**:
  Mendengarkan bot Telegram target 24/7, me-parse Solana Mint Contract Address (`Base58`) secara otomatis, dan memicu eksekusi order tanpa *latency*.
- **🛡️ Deduplication Protection**:
  Otomatis mendeteksi & mengabaikan alert ganda jika token tersebut sudah memiliki posisi `ACTIVE`.
- **🎯 Hardcoded Pool Selector**:
  Memfilter pool Meteora dengan kriteria ketat:
  1. Pair **HANYA dengan SOL** (`So11111111111111111111111111111111111111112`).
  2. Rentang Bin Step wajib: **`80 <= bin_step <= 125`**.
  3. Mengurutkan & memilih pool dengan **TVL Tertinggi** (`Highest TVL`).
- **🔄 2-Step Zap In (Single Asset SOL $\rightarrow$ Double Side Position)**:
  - Alokasi deposit SOL (misal `0.1 SOL`) dibagi 50/50.
  - **Step 1**: Auto-swap 50% SOL ke Token X via **Jupiter Swap API v6**.
  - **Step 2**: Deposit 50% sisa SOL + Token X hasil swap ke posisi Meteora DLMM **Double Side** (`StrategyType.BidAsk`, `BIN_BELOW=15`, `BIN_ABOVE=15`).
- **🔁 Jupiter Swap 3x Auto-Retry & Slippage Configurable**:
  Dilengkapi retry 3x otomatis jika terjadi gangguan jaringan Jupiter API, serta persentase slippage yang dapat dikonfigurasi (`SWAP_SLIPPAGE_BPS=150`).
- **⏱️ 24/7 TP/SL & Trailing Stop Tracker (Tiap 3 Detik)**:
  - **Hard Take Profit**: Close otomatis saat PnL menyentuh `+20%`.
  - **Hard Stop Loss**: Close otomatis saat PnL menyentuh `-10%`.
  - **Trailing Stop Profit Lock-in**: Mengunci keuntungan jika PnL pernah menyentuh puncak minimal `+5%` dan mengalami penurunan `5%` dari puncaknya.
- **💵 Auto Remove, Swap to SOL, & Rent Reclaim**:
  Saat posisi ditutup (TP/SL/Trailing), sistem menarik 100% likuiditas, mengklaim swap fee, **me-swap 100% sisa token kembali ke SOL**, dan menutup akun posisi untuk mengembalikan sewa SOL (*rent exemption*).
- **📱 Telegram Notifier & Interactive Commands**:
  - Notifikasi HTML real-time saat Position Opened, Closed (dengan link Solscan TX), dan Error.
  - Menu tombol `/` interaktif di Telegram UI untuk mengontrol bot (`/status`, `/active`, `/history`, `/stopbot`, `/startbot`).
- **🧪 Dry Run Simulation Mode**:
  Mode simulasi (`DRY_RUN=true`) untuk menguji seluruh alur tanpa menggunakan modal SOL asli.

---

## 🏗️ Arsitektur Sistem

```
[Telegram Alert] ──► Python listener.py ──► Regex Parser ──► POST http://localhost:3000/open-position
                                                                        │
                                                                        ▼
                                                         Node.js dlmm-position-manager
                                                                        │
                    ┌───────────────────────────────────────────────────┴───────────────────────────────────────────────────┐
                    ▼                                                                                                       ▼
          1. OPEN POSITION (Zap In)                                                                                2. TP/SL MONITOR LOOP (3s)
• Query Meteora API (Pair SOL, Bin 80-125, Top TVL)                                                      • Query Active Bin Price
• Jupiter Swap 50% SOL -> Token X                                                                        • Evaluate Hard TP (+20%) / SL (-10%)
• Deposit Double Side DLMM (BidAsk)                                                                      • Evaluate Trailing Stop (Peak +5%, Drop 5%)
• Save to positions.json & Send Telegram Notification                                                    • Remove Liquidity + Swap Token to SOL + Close Account
                                                                                                         • Send Telegram Close Notification with Solscan Links
```

---

## 🚀 Panduan Setup & Instalasi

### 1. Prasyarat System
- Python `3.10+`
- Node.js `18+`
- PM2 (`npm install -g pm2`)

### 2. Clone Repositori & Install Dependensi

```bash
# Install Python Dependencies
pip install -r requirements.txt

# Install Node.js Dependencies
npm install
```

### 3. Konfigurasi Environment (`.env`)

Salin file `.env.example` menjadi `.env`:
```bash
cp .env.example .env
```

Buka file `.env` dan lengkapi konfigurasi berikut:

```env
# --- TELEGRAM LISTEN CONFIG ---
TELEGRAM_API_ID=12345678                          # Dari my.telegram.org
TELEGRAM_API_HASH=your_api_hash_here             # Dari my.telegram.org
TARGET_BOT_USERNAME=popowkaisarcharonbot         # Bot alert yang ingin didengarkan

# --- TELEGRAM NOTIFIER CONFIG ---
NOTIFIER_ENABLE=true
NOTIFIER_BOT_TOKEN=your_notifier_bot_token_here  # Dari @BotFather
NOTIFIER_CHAT_ID=your_telegram_chat_id_here      # Dari @userinfobot

# --- SOLANA CONFIG ---
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PRIVATE_KEY=your_private_key_here          # Private Key Wallet Anda (Base58)

# --- TRADING PARAMETERS ---
DEFAULT_SOL_AMOUNT=0.1                            # SOL per posisi
STRATEGY_TYPE=BidAsk                              # BidAsk, Spot, atau Curve
BIN_BELOW=15                                      # Range bin bawah (activeBin - 15)
BIN_ABOVE=15                                      # Range bin atas (activeBin + 15)
SWAP_SLIPPAGE_BPS=150                             # Slippage BPS (150 = 1.5%)

# --- RISK MANAGEMENT & MONITORING ---
TAKE_PROFIT_PERCENT=20                            # Hard TP (+20%)
STOP_LOSS_PERCENT=10                              # Hard SL (-10%)
MONITOR_INTERVAL_MS=3000                          # Cek harga tiap 3 detik

# --- TRAILING STOP ---
TRAILING_STOP_ENABLE=true
TRAILING_START_PERCENT=5                          # Aktif jika peak >= +5%
TRAILING_DROP_PERCENT=5                           # Close jika drop 5% dari peak

# --- SAFETY MODE ---
DRY_RUN=true                                      # Set false untuk Live Mainnet
```

---

## 🎮 Perintah Interaktif Telegram

Setelah bot berjalan, Anda bisa mengirimkan perintah ini langsung ke **Bot Notifikasi Telegram Anda**:

| Perintah | Deskripsi & Fungsi |
| :--- | :--- |
| **`/status`** | Menampilkan status bot, mode `DRY_RUN`/`LIVE`, konfigurasi trading, & jumlah posisi aktif. |
| **`/active`** | Menampilkan daftar seluruh posisi DLMM yang sedang terbuka (Entry Price, Peak PnL, Target TP/SL). |
| **`/history`** | Menampilkan 10 riwayat posisi terakhir yang sudah di-close (PnL Akhir %, Status, & Exit Price). |
| **`/stopbot`** | **Menjeda Bot**. Bot akan mengabaikan alert Telegram baru *(posisi aktif tetap dipantau)*. |
| **`/startbot`** | **Melanjutkan Bot**. Bot kembali aktif mendengarkan alert & membuka posisi DLMM. |

---

## 🖥️ Cara Menjalankan Aplikasi

### Cara A: Production Mode 24/7 via PM2 (Rekomendasi)

```bash
# Menjalankan kedua service sekaligus
pm2 start ecosystem.config.js

# Cek status
pm2 status

# Cek log real-time
pm2 logs

# Simpan proses agar otomatis nyala saat server restart
pm2 save
pm2 startup
```

### Cara B: Manual Execution via Terminal

* **Terminal 1 (Node.js Position Manager & TP/SL Tracker)**:
  ```bash
  node server.js
  ```
* **Terminal 2 (Python Telegram Alert Listener)**:
  ```bash
  python listener.py
  ```

---

## 📂 Struktur Repositori

```
├── listener.py              # Python Pyrogram Telegram Alert Listener
├── server.js                # Express API Server lokal (Port 3000)
├── services/
│   ├── dlmmService.js       # Hardcoded Pool Selector, 2-Step Zap In, & Close Position
│   ├── monitorService.js    # 24/7 3-second TP/SL & Trailing Stop Tracker Loop
│   ├── dbService.js         # Persistence database JSON lokal (positions.json)
│   ├── telegramNotifier.js  # Format HTML notification sender ke Telegram Notifier
│   └── botCommandHandler.js # Interactive Telegram command handler (/status, /active, etc)
├── ecosystem.config.js      # Konfigurasi PM2 process manager
├── package.json             # Dependensi Node.js
├── requirements.txt         # Dependensi Python
├── .env.example             # Template konfigurasi variabel lingkungan
└── README.md                # Dokumentasi proyek
```
