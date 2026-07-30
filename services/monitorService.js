const fetch = require('node-fetch');
const dbService = require('./dbService');
const dlmmService = require('./dlmmService');
const telegramNotifier = require('./telegramNotifier');

let monitorTimer = null;
let isChecking = false;

/**
 * Mengambil harga terkini (Current Price) dari pool Meteora dengan normalisasi Token X vs Token Y.
 */
async function getCurrentPrice(poolAddress, targetMint) {
  try {
    const url = `https://dlmm.datapi.meteora.ag/pools?query=${targetMint}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (resp.ok) {
      const data = await resp.json();
      const pools = data.data || [];
      const pool = pools.find(p => p.address === poolAddress) || pools[0];
      if (pool && pool.current_price) {
        return dlmmService.getNormalizedTokenPrice(pool, pool.current_price);
      }
    }
  } catch (err) {
    console.error(`[Monitor Service] Error fetching price for pool ${poolAddress}:`, err.message);
  }
  return null;
}

/**
 * Satu iterasi pengecekan TP, SL, & Trailing Stop untuk seluruh posisi aktif.
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
      const currentPrice = await getCurrentPrice(pos.poolAddress, pos.mint);
      if (!currentPrice) {
        continue;
      }

      const currentPnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      let maxPnlPct = pos.maxPnlPct || 0;

      // Update Puncak PnL Tertinggi (Peak) jika harga lebih tinggi dari sebelumnya
      if (currentPnlPct > maxPnlPct) {
        maxPnlPct = currentPnlPct;
        pos.maxPnlPct = maxPnlPct;
        pos.maxPrice = currentPrice;
        dbService.updatePositionPeak(pos.id, currentPrice, maxPnlPct);
      }

      console.log(`[Monitor] Pos ID: ${pos.id} | Mint: ${pos.mint} | Current: $${currentPrice.toFixed(8)} | Entry: $${pos.entryPrice.toFixed(8)} | PnL: ${currentPnlPct > 0 ? '+' : ''}${currentPnlPct.toFixed(2)}% (Peak: +${maxPnlPct.toFixed(2)}%) | TP: $${pos.tpPrice.toFixed(8)} | SL: $${pos.slPrice.toFixed(8)}`);

      // 1. Check Hard Take Profit (+20%)
      if (currentPrice >= pos.tpPrice) {
        console.log(`🎯 [HARD TAKE PROFIT TRIGGERED] Position ${pos.id} hit TP target! (+${currentPnlPct.toFixed(2)}%)`);
        const closeRes = await dlmmService.executeClosePosition(pos, 'TAKE_PROFIT');
        dbService.updatePositionStatus(pos.id, 'CLOSED_TP', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, closeRes });
        telegramNotifier.notifyPositionClosed(pos, 'TAKE_PROFIT', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, closeRes });
      }
      // 2. Check Hard Stop Loss (-10%)
      else if (currentPrice <= pos.slPrice) {
        console.log(`🚨 [HARD STOP LOSS TRIGGERED] Position ${pos.id} hit SL target! (${currentPnlPct.toFixed(2)}%)`);
        const closeRes = await dlmmService.executeClosePosition(pos, 'STOP_LOSS');
        dbService.updatePositionStatus(pos.id, 'CLOSED_SL', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, closeRes });
        telegramNotifier.notifyPositionClosed(pos, 'STOP_LOSS', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, closeRes });
      }
      // 3. Check Trailing Stop / Profit Lock-in (Misal Peak pernah >= 5% & Retrace/Drop >= 5% dari Peak)
      else if (trailingEnabled && maxPnlPct >= trailingStartPct) {
        const retraceDrop = maxPnlPct - currentPnlPct;
        if (retraceDrop >= trailingDropPct) {
          console.log(`📈 [TRAILING STOP TRIGGERED] Position ${pos.id} reached peak +${maxPnlPct.toFixed(2)}% and dropped to +${currentPnlPct.toFixed(2)}% (Retrace drop ${retraceDrop.toFixed(2)}% >= ${trailingDropPct}%)! Locking profit...`);
          const closeRes = await dlmmService.executeClosePosition(pos, 'TRAILING_STOP_PROFIT_LOCK');
          dbService.updatePositionStatus(pos.id, 'CLOSED_TRAILING_STOP', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, retraceDrop, closeRes });
          telegramNotifier.notifyPositionClosed(pos, 'TRAILING_STOP_PROFIT_LOCK', { currentPrice, pnlPct: currentPnlPct, maxPnlPct, retraceDrop, closeRes });
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
 */
function startMonitoring() {
  const intervalMs = parseInt(process.env.MONITOR_INTERVAL_MS || '3000', 10);
  console.log(`[Monitor Service] 🚀 Starting 24/7 TP/SL & Trailing Stop Monitor Loop every ${intervalMs / 1000} seconds...`);

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
