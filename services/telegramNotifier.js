const fetch = require('node-fetch');

/**
 * Kirim pesan HTML ke Telegram Bot Pribadi Anda.
 */
async function sendNotification(htmlText) {
  const isEnabled = process.env.NOTIFIER_ENABLE === 'true';
  const botToken = process.env.NOTIFIER_BOT_TOKEN;
  const chatId = process.env.NOTIFIER_CHAT_ID;

  if (!isEnabled || !botToken || !chatId || botToken === 'your_notifier_bot_token_here') {
    return;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('[Notifier] Gagal mengirim pesan Telegram Notifier:', errBody);
    }
  } catch (err) {
    console.error('[Notifier] Error sending Telegram notification:', err.message);
  }
}

/**
 * Notifikasi saat Bot Service Baru Di-Start / Online
 */
async function notifyBotStarted() {
  const isDryRun = process.env.DRY_RUN === 'true';
  const modeText = isDryRun ? '🧪 <b>DRY RUN (Simulasi)</b>' : '⚡ <b>LIVE MAINNET</b>';
  const message = `
🟢 <b>[DLMM TRADER STARTED]</b>

Meteora DLMM Automated Trader Service online dan siap mendengarkan alert!

<b>Mode:</b> ${modeText}
<b>Strategy:</b> ${process.env.STRATEGY_TYPE || 'BidAsk'} (Bin: -${process.env.BIN_BELOW || 15} / +${process.env.BIN_ABOVE || 15})
<b>Default Deposit:</b> ${process.env.DEFAULT_SOL_AMOUNT || 0.1} SOL
<b>Target TP / SL:</b> +${process.env.TAKE_PROFIT_PERCENT || 20}% / -${process.env.STOP_LOSS_PERCENT || 10}%
<b>Trailing Stop:</b> ${process.env.TRAILING_STOP_ENABLE === 'true' ? '✅ ENABLED (+5% peak, 5% drop)' : '❌ DISABLED'}
<b>Target Bot Alert:</b> @${process.env.TARGET_BOT_USERNAME || 'N/A'}
  `.trim();

  await sendNotification(message);
}

/**
 * Notifikasi saat Posisi DLMM Baru Berhasil Dibuka (Zap In Completed)
 */
async function notifyPositionOpened(pos) {
  const modeText = pos.isDryRun ? '🧪 <b>DRY RUN / SIMULASI</b>' : '⚡ <b>LIVE MAINNET</b>';
  const message = `
🚀 <b>[DLMM POSITION OPENED]</b>

<b>Pool:</b> ${pos.poolName || 'N/A'}
<b>Mint CA:</b> <code>${pos.mint}</code>
<b>Entry Price:</b> $${(pos.entryPrice || 0).toFixed(8)}
<b>Strategy:</b> ${pos.strategy} (Bin: -${pos.binBelow} / +${pos.binAbove})
<b>SOL Amount:</b> ${pos.solAmount} SOL

🎯 <b>Target TP (+${process.env.TAKE_PROFIT_PERCENT || 20}%):</b> $${(pos.tpPrice || 0).toFixed(8)}
🚨 <b>Target SL (-${process.env.STOP_LOSS_PERCENT || 10}%):</b> $${(pos.slPrice || 0).toFixed(8)}

----------------------------------
Status: ${modeText}
  `.trim();

  await sendNotification(message);
}

/**
 * Notifikasi saat Posisi DLMM Ditutup (TP / SL / Trailing Stop / Manual)
 */
async function notifyPositionClosed(pos, reason, closeDetails = {}) {
  const modeText = pos.isDryRun ? '🧪 <b>DRY RUN / SIMULASI</b>' : '⚡ <b>LIVE MAINNET</b>';
  const currentPrice = closeDetails.currentPrice || 0;
  const pnlPct = closeDetails.pnlPct || 0;
  const maxPnlPct = closeDetails.maxPnlPct || pnlPct;
  const unclaimedFeeSol = closeDetails.unclaimedFeeSol || 0;

  let reasonHeader = 'ℹ️ <b>[POSITION CLOSED]</b>';
  let badgeText = reason;

  if (reason === 'TAKE_PROFIT') {
    reasonHeader = '🎯 <b>[TAKE PROFIT TRIGGERED]</b> 🎉';
    badgeText = `HARD TAKE PROFIT (+${process.env.TAKE_PROFIT_PERCENT || 20}%)`;
  } else if (reason === 'STOP_LOSS') {
    reasonHeader = '🚨 <b>[STOP LOSS TRIGGERED]</b> 🛑';
    badgeText = `HARD STOP LOSS (-${process.env.STOP_LOSS_PERCENT || 10}%)`;
  } else if (reason === 'TRAILING_STOP_PROFIT_LOCK') {
    reasonHeader = '📈 <b>[TRAILING STOP PROFIT LOCK]</b> 💰';
    badgeText = `TRAILING STOP (Peak: +${maxPnlPct.toFixed(2)}%)`;
  }

  const pnlSign = pnlPct >= 0 ? '+' : '';
  const removeTx = closeDetails.closeRes?.removeTxHash ? `https://solscan.io/tx/${closeDetails.closeRes.removeTxHash}` : null;
  const swapTx = closeDetails.closeRes?.swapBackTxHash ? `https://solscan.io/tx/${closeDetails.closeRes.swapBackTxHash}` : null;

  let message = `
${reasonHeader}

<b>Pool:</b> ${pos.poolName || 'N/A'}
<b>Mint CA:</b> <code>${pos.mint}</code>
<b>Reason:</b> ${badgeText}

<b>Entry Price:</b> $${(pos.entryPrice || 0).toFixed(8)}
<b>Exit Price:</b> $${currentPrice.toFixed(8)}
<b>True PnL Akhir:</b> <b>${pnlSign}${pnlPct.toFixed(2)}%</b> (Peak: +${maxPnlPct.toFixed(2)}%)
<b>Swap Fees Earned:</b> <b>+${unclaimedFeeSol.toFixed(4)} SOL</b>

Mode: ${modeText}
  `.trim();

  if (removeTx) {
    message += `\n🔗 <a href="${removeTx}">Solscan Liquidity Remove</a>`;
  }
  if (swapTx) {
    message += `\n🔗 <a href="${swapTx}">Solscan Swap to SOL</a>`;
  }

  await sendNotification(message);
}

/**
 * Notifikasi Error / Kegagalan Order
 */
async function notifyError(action, errorMsg) {
  const message = `
❌ <b>[DLMM TRADER ERROR]</b>

<b>Action:</b> ${action}
<b>Error:</b> <code>${errorMsg}</code>
  `.trim();

  await sendNotification(message);
}

module.exports = {
  sendNotification,
  notifyBotStarted,
  notifyPositionOpened,
  notifyPositionClosed,
  notifyError,
};
