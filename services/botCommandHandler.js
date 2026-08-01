const fetch = require('node-fetch');
const dbService = require('./dbService');
const dlmmService = require('./dlmmService');
const telegramNotifier = require('./telegramNotifier');

let isPaused = false;
let lastUpdateId = 0;
let pollingTimer = null;

function isBotPaused() {
  return isPaused;
}

/**
 * mendaftarkan menu tombol '/' otomatis di aplikasi Telegram UI via Telegram API setMyCommands.
 */
async function registerTelegramCommands(botToken) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/setMyCommands`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'status', description: 'Lihat status & konfigurasi bot' },
          { command: 'active', description: 'Lihat daftar posisi DLMM yang sedang aktif' },
          { command: 'history', description: 'Lihat 10 riwayat posisi yang sudah closed' },
          { command: 'stopbot', description: 'Jeda bot (abaikan alert baru)' },
          { command: 'startbot', description: 'Lanjutkan bot (terima alert baru)' },
        ]
      })
    });
    console.log('[Bot Commands] ✅ Telegram Bot UI command menu (/ menu) set successfully!');
  } catch (err) {
    console.warn('[Bot Commands] Error setting Telegram commands UI menu:', err.message);
  }
}

/**
 * Polling long-poll Telegram Bot API getUpdates.
 */
async function startCommandPolling() {
  const isEnabled = process.env.NOTIFIER_ENABLE === 'true';
  const botToken = process.env.NOTIFIER_BOT_TOKEN;
  const ownerChatId = process.env.NOTIFIER_CHAT_ID;

  if (!isEnabled || !botToken || !ownerChatId || botToken === 'your_notifier_bot_token_here') {
    console.log('[Bot Commands] Telegram Notifier is disabled or not configured. Command polling skipped.');
    return;
  }

  // Daftarkan menu UI '/' otomatis di Telegram
  await registerTelegramCommands(botToken);

  console.log('[Bot Commands] 🤖 Starting Telegram Interactive Command Polling (/status, /stopbot, /startbot, /active, /history)...');

  // Loop polling tiap 2 detik
  pollingTimer = setInterval(async () => {
    try {
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`;
      const resp = await fetch(url);
      if (!resp.ok) return;

      const data = await resp.json();
      if (!data.ok || !data.result || data.result.length === 0) return;

      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg || !msg.text) continue;

        const senderChatId = String(msg.chat.id);
        const text = msg.text.trim();

        // Keamanan: Hanya proses command jika berasal dari NOTIFIER_CHAT_ID milik Anda
        if (senderChatId !== String(ownerChatId)) {
          console.warn(`[Bot Commands] Unauthorized command attempt from Chat ID: ${senderChatId}`);
          await telegramNotifier.sendNotification(`⛔ <b>Access Denied:</b> Command dari Chat ID (${senderChatId}) ditolak.`);
          continue;
        }

        await handleCommand(text);
      }
    } catch (err) {
      // Ignore polling connection error silently
    }
  }, 2000);
}

/**
 * Router & Handler Command Telegram.
 */
async function handleCommand(cmdText) {
  const cmd = cmdText.split(' ')[0].toLowerCase();

  if (cmd === '/start' || cmd === '/status' || cmd === '/help') {
    await handleStatusCmd();
  } else if (cmd === '/stop' || cmd === '/stopbot' || cmd === '/pause') {
    isPaused = true;
    console.log('[Bot Commands] ⏸️ Bot PAUSED via Telegram Command');
    await telegramNotifier.sendNotification(`
⏸️ <b>[BOT TRADER DIJEDA / PAUSED]</b>

Bot trader berhasil dijeda!
Signal alert baru dari Telegram akan <b>DIABAIKAN</b> sampai Anda mengirim command /startbot atau /resume.

<i>Catatan: Tracker TP/SL posisi yang sudah aktif tetap berjalan memantau harga.</i>
    `.trim());
  } else if (cmd === '/startbot' || cmd === '/resume') {
    isPaused = false;
    console.log('[Bot Commands] ▶️ Bot RESUMED via Telegram Command');
    await telegramNotifier.sendNotification(`
▶️ <b>[BOT TRADER DILANJUTKAN / RESUMED]</b>

Bot trader aktif kembali!
Bot sekarang siap mendengarkan alert & membuka posisi DLMM baru secara otomatis.
    `.trim());
  } else if (cmd === '/active' || cmd === '/positions') {
    await handleActivePositionsCmd();
  } else if (cmd === '/history' || cmd === '/closed') {
    await handleHistoryCmd();
  }
}

/**
 * Handler Command /status
 */
async function handleStatusCmd() {
  const isDryRun = process.env.DRY_RUN === 'true';
  const modeText = isDryRun ? '🧪 <b>DRY RUN (Simulasi)</b>' : '⚡ <b>LIVE MAINNET</b>';
  const statusText = isPaused ? '⏸️ <b>PAUSED (Dijeda)</b>' : '🟢 <b>ACTIVE (Berjalan)</b>';
  const activeCount = dbService.getActivePositions().length;

  const msg = `
🤖 <b>[DLMM TRADER COMMAND PANEL]</b>

<b>Status Bot:</b> ${statusText}
<b>Mode:</b> ${modeText}
<b>Posisi Aktif:</b> ${activeCount} Posisi

<b>Konfigurasi Saat Ini:</b>
• Strategy: <code>${process.env.STRATEGY_TYPE || 'BidAsk'}</code> (Bin: -${process.env.BIN_BELOW || 15} / +${process.env.BIN_ABOVE || 15})
• Deposit SOL: <code>${process.env.DEFAULT_SOL_AMOUNT || 0.1} SOL</code>
• Hard TP / SL: <code>+${process.env.TAKE_PROFIT_PERCENT || 20}% / -${process.env.STOP_LOSS_PERCENT || 10}%</code>
• Trailing Stop: <code>${process.env.TRAILING_STOP_ENABLE === 'true' ? 'ENABLED (+5% peak, 5% drop)' : 'DISABLED'}</code>
• Slippage: <code>${(process.env.SWAP_SLIPPAGE_BPS || 150) / 100}%</code>
• Target Bot Alert: <code>@${process.env.TARGET_BOT_USERNAME || 'N/A'}</code>

<b>Daftar Perintah Telegram:</b>
/active - Lihat daftar posisi aktif saat ini
/history - Lihat 10 posisi terakhir yang sudah di-close
/stopbot - Jeda bot (abaikan alert baru)
/startbot - Lanjutkan bot (terima alert baru)
/status - Lihat status bot ini
  `.trim();

  await telegramNotifier.sendNotification(msg);
}

/**
 * Handler Command /active (Lihat posisi yang sedang terbuka)
 */
async function handleActivePositionsCmd() {
  const activeList = dbService.getActivePositions();

  if (activeList.length === 0) {
    await telegramNotifier.sendNotification(`ℹ️ <b>[POSISI AKTIF]</b> Saat ini tidak ada posisi DLMM yang sedang terbuka.`);
    return;
  }

  let text = `📊 <b>[DAFTAR POSISI AKTIF (${activeList.length})]</b>\n\n`;

  for (let idx = 0; idx < activeList.length; idx++) {
    const pos = activeList[idx];
    const maxPnl = pos.maxPnlPct || 0;
    text += `<b>${idx + 1}. ${pos.poolName || pos.mint}</b>\n`;
    text += `• Mint: <code>${pos.mint}</code>\n`;
    text += `• Entry Price: $${(pos.entryPrice || 0).toFixed(8)}\n`;
    text += `• Peak True PnL: +${maxPnl.toFixed(2)}%\n`;
    text += `• Target TP: +${process.env.TAKE_PROFIT_PERCENT || 20}%\n`;
    text += `• Target SL: -${process.env.STOP_LOSS_PERCENT || 10}%\n`;
    text += `• Opened At: ${new Date(pos.createdAt).toLocaleString()}\n`;
    text += `----------------------------------\n`;
  }

  await telegramNotifier.sendNotification(text);
}

/**
 * Handler Command /history (Lihat 10 posisi terakhir yang sudah closed)
 */
async function handleHistoryCmd() {
  const db = dbService.loadPositions();
  const closedList = db.positions.filter(p => p.status !== 'ACTIVE');

  if (closedList.length === 0) {
    await telegramNotifier.sendNotification(`ℹ️ <b>[RIWAYAT POSISI]</b> Belum ada riwayat posisi yang ditutup.`);
    return;
  }

  const last10Closed = closedList.slice(-10).reverse();

  let text = `📜 <b>[10 RIWAYAT POSISI TERAKHIR]</b>\n\n`;

  for (let idx = 0; idx < last10Closed.length; idx++) {
    const pos = last10Closed[idx];
    const details = pos.closeDetails || {};
    const pnlPct = details.pnlPct || 0;
    const pnlSign = pnlPct >= 0 ? '+' : '';
    const statusEmoji = pnlPct >= 0 ? '🟢' : '🔴';
    const feeSol = details.unclaimedFeeSol || 0;

    text += `<b>${idx + 1}. ${statusEmoji} ${pos.poolName || pos.mint}</b>\n`;
    text += `• Status: <code>${pos.status}</code>\n`;
    text += `• True PnL Akhir: <b>${pnlSign}${pnlPct.toFixed(2)}%</b> (Peak: +${(details.maxPnlPct || 0).toFixed(2)}%)\n`;
    text += `• Fees Earned: <b>+${feeSol.toFixed(4)} SOL</b>\n`;
    text += `• Entry: $${(pos.entryPrice || 0).toFixed(8)} ➔ Exit: $${(details.currentPrice || 0).toFixed(8)}\n`;
    text += `• Closed At: ${pos.closedAt ? new Date(pos.closedAt).toLocaleString() : 'N/A'}\n`;
    text += `----------------------------------\n`;
  }

  await telegramNotifier.sendNotification(text);
}

module.exports = {
  isBotPaused,
  startCommandPolling,
  handleCommand,
};
