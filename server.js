require('dotenv').config();
const express = require('express');
const dbService = require('./services/dbService');
const dlmmService = require('./services/dlmmService');
const monitorService = require('./services/monitorService');
const telegramNotifier = require('./services/telegramNotifier');
const botCommandHandler = require('./services/botCommandHandler');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Healthcheck Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    isPaused: botCommandHandler.isBotPaused(),
    dryRun: process.env.DRY_RUN === 'true',
    activePositionsCount: dbService.getActivePositions().length
  });
});

// Endpoint untuk Menerima Signal Open Position dari Python Telegram Listener
app.post('/open-position', async (req, res) => {
  try {
    const { mint, rawAlert } = req.body;

    if (!mint) {
      return res.status(400).json({ error: 'Field `mint` (Solana Contract Address) wajib diisi.' });
    }

    // CEK STATUS PAUSE DARI TELEGRAM COMMAND (/stopbot)
    if (botCommandHandler.isBotPaused()) {
      console.log(`⏸️ [PAUSED IGNORED] Bot sedang di-pause via Telegram command. Mengabaikan alert mint: ${mint}`);
      return res.status(200).json({
        success: true,
        message: 'Bot sedang di-pause via Telegram command. Alert diabaikan.',
        ignored: true
      });
    }

    console.log(`\n==================================================`);
    console.log(`📩 [SIGNAL RECEIVED] Request to open DLMM position for Mint: ${mint}`);
    if (rawAlert) {
      console.log(`Raw Alert Preview: ${rawAlert.slice(0, 100)}...`);
    }
    console.log(`==================================================\n`);

    // DEDUP CHECK: Cegah pembukaan posisi ganda untuk mint token yang sama yang masih ACTIVE
    const activePositions = dbService.getActivePositions();
    const existingPos = activePositions.find(p => p.mint === mint);
    if (existingPos) {
      console.log(`⚠️ [DUPLICATE IGNORED] Posisi untuk mint ${mint} sudah aktif (ID: ${existingPos.id}). Mengabaikan alert duplikat.`);
      return res.status(200).json({
        success: true,
        message: 'Posisi untuk token ini sudah aktif, mengabaikan alert duplikat.',
        position: existingPos,
        ignored: true
      });
    }

    const positionRecord = await dlmmService.executeOpenPosition(mint);
    dbService.addPosition(positionRecord);

    console.log(`🎉 [POSITION CREATED] Saved to database! ID: ${positionRecord.id} | Status: ACTIVE`);

    // Kirim notifikasi Telegram Bot Pribadi
    telegramNotifier.notifyPositionOpened(positionRecord);

    return res.status(200).json({
      success: true,
      message: 'Posisi DLMM berhasil dibuka!',
      position: positionRecord
    });
  } catch (err) {
    console.error('❌ [ERROR] Gagal membuka posisi DLMM:', err.message);
    telegramNotifier.notifyError('Open Position Failed', err.message);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Endpoint untuk Mengambil Semua Posisi (Active & Closed)
app.get('/positions', (req, res) => {
  const db = dbService.loadPositions();
  res.json(db);
});

// Endpoint Manual Close Position
app.post('/close-position', async (req, res) => {
  try {
    const { id } = req.body;
    const db = dbService.loadPositions();
    const pos = db.positions.find(p => p.id === id && p.status === 'ACTIVE');

    if (!pos) {
      return res.status(404).json({ error: `Posisi aktif dengan ID ${id} tidak ditemukan.` });
    }

    const closeRes = await dlmmService.executeClosePosition(pos, 'MANUAL_CLOSE');
    const updated = dbService.updatePositionStatus(pos.id, 'CLOSED_MANUAL', { closeRes });

    telegramNotifier.notifyPositionClosed(pos, 'MANUAL_CLOSE', { currentPrice: pos.entryPrice, pnlPct: 0, closeRes });

    return res.json({ success: true, message: 'Posisi berhasil ditutup!', position: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server, Background Monitor Loop, & Telegram Interactive Command Polling
app.listen(PORT, () => {
  console.log(`
  🚀 Meteora DLMM Position Manager Running on http://localhost:${PORT}
  -------------------------------------------------------------
  • DRY_RUN Mode : ${process.env.DRY_RUN === 'true' ? '🧪 TRUE (Simulasi)' : '⚡ FALSE (LIVE MAINNET)'}
  • Strategy     : ${process.env.STRATEGY_TYPE || 'BidAsk'}
  • Bin Range    : Below (-${process.env.BIN_BELOW || 15}) | Above (+${process.env.BIN_ABOVE || 15})
  • Take Profit  : +${process.env.TAKE_PROFIT_PERCENT || 20}%
  • Stop Loss    : -${process.env.STOP_LOSS_PERCENT || 10}%
  • Monitor Loop : Every ${(process.env.MONITOR_INTERVAL_MS || 3000) / 1000} seconds
  • Notifier Bot : ${process.env.NOTIFIER_ENABLE === 'true' ? '🔔 ENABLED' : '🔕 DISABLED'}
  -------------------------------------------------------------
  `);

  monitorService.startMonitoring();
  botCommandHandler.startCommandPolling();
  telegramNotifier.notifyBotStarted();
});
