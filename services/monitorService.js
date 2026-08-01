const dbService = require('./dbService');
const dlmmService = require('./dlmmService');
const telegramNotifier = require('./telegramNotifier');

let monitorTimer = null;
let isChecking = false;

// Tracker 2-tick confirmation peak PnL (mencegah false trailing stop akibat 1-tick price spike)
const pendingPeaks = new Map();

/**
 * Konfirmasi Peak PnL hanya jika PnL baru bertahan selama 2 tick berturut-turut (confirmTicks = 2)
 */
function confirmPeak(posId, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null || isNaN(candidatePnlPct)) return false;

  const activePositions = dbService.getActivePositions();
  const pos = activePositions.find(p => p.id === posId);
  if (!pos) return false;

  const currentPeak = pos.maxPnlPct || 0;

  // Jika candidate PnL tidak lebih tinggi dari peak saat ini -> reset pending candidate
  if (candidatePnlPct <= currentPeak) {
    pendingPeaks.delete(posId);
    return false;
  }

  const pending = pendingPeaks.get(posId);
  if (pending && candidatePnlPct >= pending.candidatePnlPct) {
    pending.count += 1;
    if (pending.count >= confirmTicks) {
      pendingPeaks.delete(posId);
      return true; // Peak terkonfirmasi!
    }
  } else {
    pendingPeaks.set(posId, { candidatePnlPct, count: 1 });
  }

  return false;
}

/**
 * Satu iterasi pengecekan Single True PnL, TP, SL, & Trailing Stop untuk seluruh posisi aktif.
 */
async function checkPositions() {
  if (isChecking) return;
  isChecking = true;

  try {
    const activePositions = dbService.getActivePositions();
    if (activePositions.length === 0) {
      isChecking = false;
      return;
    }

    const trailingEnabled = process.env.TRAILING_STOP_ENABLE === 'true';
    const trailingStartPct = parseFloat(process.env.TRAILING_START_PERCENT || '5');
    const trailingDropPct = parseFloat(process.env.TRAILING_DROP_PERCENT || '5');

    console.log(`[Monitor Service] 🔍 Checking ${activePositions.length} active position(s)...`);

    for (const pos of activePositions) {
      const pnlInfo = await dlmmService.fetchTruePositionPnl(pos);

      // 🛡️ Proteksi Suspicious Tick: Abaikan evaluasi jika harga Jupiter/RPC missing/zero
      if (pnlInfo.pnlPctSuspicious) {
        console.warn(`[Monitor] ⚠️ Position ${pos.id} suspicious tick (missing prices/RPC error). Skipping exit evaluation to prevent false triggers.`);
        continue;
      }

      const currentPrice = pnlInfo.currentPrice;
      const currentPnlPct = pnlInfo.currentPnlPct; // Single True PnL % (Termasuk FeeX & FeeY)
      const unclaimedFeeSol = pnlInfo.unclaimedFeeSol || 0;
      let maxPnlPct = pos.maxPnlPct || 0;

      // 🛡️ Konfirmasi 2-Tick Peak PnL sebelum menaikkan peak di database
      if (confirmPeak(pos.id, currentPnlPct, 2)) {
        maxPnlPct = currentPnlPct;
        pos.maxPnlPct = maxPnlPct;
        pos.maxPrice = currentPrice;
        dbService.updatePositionPeak(pos.id, currentPrice, maxPnlPct);
        console.log(`[Monitor] 🚀 Confirmed New Peak PnL for ${pos.id}: +${maxPnlPct.toFixed(2)}%`);
      }

      const pnlSign = currentPnlPct >= 0 ? '+' : '';
      console.log(`[Monitor] Pos ID: ${pos.id} | Mint: ${pos.mint} | Price: $${currentPrice.toFixed(8)} | PnL: ${pnlSign}${currentPnlPct.toFixed(2)}% (Fees: +${unclaimedFeeSol.toFixed(4)} SOL) (Peak: +${maxPnlPct.toFixed(2)}%) | TP: +${process.env.TAKE_PROFIT_PERCENT || 20}% | SL: -${process.env.STOP_LOSS_PERCENT || 10}%`);

      // 1. Check Hard Take Profit (+20%) via Single True PnL %
      if (currentPnlPct >= (pos.tpPct || parseFloat(process.env.TAKE_PROFIT_PERCENT || '20'))) {
        console.log(`🎯 [HARD TAKE PROFIT TRIGGERED] Position ${pos.id} hit TP target! (True PnL: ${pnlSign}${currentPnlPct.toFixed(2)}%)`);
        const closeRes = await dlmmService.executeClosePosition(pos, 'TAKE_PROFIT');
        dbService.updatePositionStatus(pos.id, 'CLOSED_TP', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, unclaimedFeeSol, closeRes });
        telegramNotifier.notifyPositionClosed(pos, 'TAKE_PROFIT', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, unclaimedFeeSol, closeRes });
      }
      // 2. Check Hard Stop Loss (-10%) via Single True PnL %
      else if (currentPnlPct <= -Math.abs(pos.slPct || parseFloat(process.env.STOP_LOSS_PERCENT || '10'))) {
        console.log(`🚨 [HARD STOP LOSS TRIGGERED] Position ${pos.id} hit SL target! (True PnL: ${pnlSign}${currentPnlPct.toFixed(2)}%)`);
        const closeRes = await dlmmService.executeClosePosition(pos, 'STOP_LOSS');
        dbService.updatePositionStatus(pos.id, 'CLOSED_SL', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, unclaimedFeeSol, closeRes });
        telegramNotifier.notifyPositionClosed(pos, 'STOP_LOSS', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, unclaimedFeeSol, closeRes });
      }
      // 3. Check Trailing Stop / Profit Lock-in via Single True PnL %
      else if (trailingEnabled && maxPnlPct >= trailingStartPct) {
        const retraceDrop = maxPnlPct - currentPnlPct;
        if (retraceDrop >= trailingDropPct) {
          console.log(`📈 [TRAILING STOP TRIGGERED] Position ${pos.id} reached peak +${maxPnlPct.toFixed(2)}% and dropped to ${pnlSign}${currentPnlPct.toFixed(2)}% (Retrace drop ${retraceDrop.toFixed(2)}% >= ${trailingDropPct}%)! Locking profit...`);
          const closeRes = await dlmmService.executeClosePosition(pos, 'TRAILING_STOP_PROFIT_LOCK');
          dbService.updatePositionStatus(pos.id, 'CLOSED_TRAILING_STOP', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, retraceDrop, unclaimedFeeSol, closeRes });
          telegramNotifier.notifyPositionClosed(pos, 'TRAILING_STOP_PROFIT_LOCK', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, retraceDrop, unclaimedFeeSol, closeRes });
        }
      }
    }
  } catch (err) {
    console.error('[Monitor Service] Exception in checkPositions:', err);
  } finally {
    isChecking = false;
  }
}

/**
 * Memulai background loop pemantau TP/SL/Trailing Stop 24/7.
 * Melakukan On-Chain Auto-Sync terlebih dahulu saat startup di Live Mainnet Mode.
 */
async function startMonitoring() {
  const intervalMs = parseInt(process.env.MONITOR_INTERVAL_MS || '3000', 10);
  console.log(`[Monitor Service] 🚀 Starting 24/7 TP/SL & Trailing Stop Monitor Loop every ${intervalMs / 1000} seconds...`);

  // Lakukan On-Chain Auto-Sync posisi saat startup di Mode Live
  try {
    await dlmmService.syncOnChainPositions();
  } catch (syncErr) {
    console.warn('[Monitor Service] On-Chain position sync warning:', syncErr.message);
  }

  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(checkPositions, intervalMs);
}

/**
 * Menghentikan background loop.
 */
function stopMonitoring() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    console.log('[Monitor Service] Stopped Monitor Loop.');
  }
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  checkPositions,
};
