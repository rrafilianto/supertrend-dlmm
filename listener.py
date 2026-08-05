from __future__ import annotations
import os
import sys
import re
import logging
import urllib.request
import json
from datetime import datetime
from dotenv import load_dotenv
from pyrogram import Client, filters

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# Load environment variables dari file .env
load_dotenv()

API_ID = os.getenv("TELEGRAM_API_ID")
API_HASH = os.getenv("TELEGRAM_API_HASH")
TARGET_BOT = os.getenv("TARGET_BOT_USERNAME")
MANAGER_URL = os.getenv("POSITION_MANAGER_URL", "http://localhost:3000/open-position")

# Validasi konfigurasi awal
if not API_ID or not API_HASH:
    logger.error("Silakan tentukan TELEGRAM_API_ID dan TELEGRAM_API_HASH di file .env terlebih dahulu.")
    sys.exit(1)

if not TARGET_BOT:
    logger.error("Silakan tentukan TARGET_BOT_USERNAME di file .env terlebih dahulu.")
    sys.exit(1)

# Format target_bot (apabila berupa angka ID, ubah ke integer)
target_filter_chat = int(TARGET_BOT) if TARGET_BOT.lstrip("-").isdigit() else TARGET_BOT.lstrip("@")

# Regex pattern untuk Solana Mint Address (Base58 32-44 karakter)
SOLANA_CA_REGEX = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")

# Regex pattern untuk Pair Name (mendukung ASCII Hyphen '-', En-dash '–', & Em-dash '—')
PAIR_NAME_REGEX = re.compile(r"\b([A-Za-z0-9_]+[\-–—]SOL)\b", re.IGNORECASE)

# Regex pattern untuk Cashtag Ticker (misal: $SISYPUSS, $LUNA, $Fauci)
CASHTAG_REGEX = re.compile(r"\$([A-Za-z0-9_]+)\b")

# Inisialisasi Pyrogram Client
app = Client(
    name="alert_listener_session",
    api_id=int(API_ID),
    api_hash=API_HASH,
)


def extract_all_text_from_message(message) -> str:
    """
    Ekstrak seluruh teks dan data entitas dari template pesan Telegram (Rich Table, Copy Text, Expandable Blockquote, Inline Button, dsb).
    """
    texts = []

    # 1. Teks Utama & Caption
    if getattr(message, "text", None):
        texts.append(message.text)
    if getattr(message, "caption", None):
        texts.append(message.caption)

    # 2. Entitas Teks (Link, Spoiler, Expandable Blockquote, Copy Text)
    entities = (getattr(message, "entities", None) or []) + (getattr(message, "caption_entities", None) or [])
    for ent in entities:
        if hasattr(ent, "url") and ent.url:
            texts.append(ent.url)

    # 3. Inline Keyboard Buttons (Tombol 'Open pool on Meteora' & 'Mint CA · tap to copy')
    if getattr(message, "reply_markup", None) and hasattr(message.reply_markup, "inline_keyboard"):
        for row in message.reply_markup.inline_keyboard:
            for btn in row:
                if hasattr(btn, "url") and btn.url:
                    texts.append(btn.url)
                if hasattr(btn, "text") and btn.text:
                    texts.append(btn.text)
                if hasattr(btn, "copy_text") and btn.copy_text and hasattr(btn.copy_text, "text"):
                    texts.append(btn.copy_text.text)

    return "\n".join(texts)


def extract_target_query(message) -> str | None:
    """
    Pipeline ekstraksi 3 tingkat (Solana CA Base58 -> Pair Name -> Cashtag Ticker)
    sehingga template alert dalam format apapun 100% selalu berhasil diekstrak!
    """
    full_text = extract_all_text_from_message(message)
    if not full_text:
        return None

    # Filter Kata-kata Sampah yang Bukan Solana Mint CA
    EXCLUDED_WORDS = {
        "Discovery", "Supertrend", "Meteora", "Bullish", "Bearish", 
        "Value", "Metric", "Telegram", "https", "http", "Sengriuiut_Bot"
    }

    # TINGKAT 1: Coba ekstrak Solana Mint Address (Base58 32-44 karakter)
    ca_matches = SOLANA_CA_REGEX.findall(full_text)
    for match in ca_matches:
        if 32 <= len(match) <= 44:
            if match in EXCLUDED_WORDS or match.startswith("http"):
                continue
            return match

    # TINGKAT 2: Coba ekstrak Pair Name (misal: SISYPUSS-SOL, S-SOL, LUNA-SOL, Fauci-SOL)
    pair_matches = PAIR_NAME_REGEX.findall(full_text)
    if pair_matches:
        normalized_pair = re.sub(r"[\-–—]", "-", pair_matches[0])
        return normalized_pair.upper()

    # TINGKAT 3: Coba ekstrak Cashtag Ticker (misal: $SISYPUSS -> SISYPUSS-SOL)
    cashtag_matches = CASHTAG_REGEX.findall(full_text)
    for tag in cashtag_matches:
        symbol = tag.upper()
        if symbol not in ["SOL", "USDC", "USDT"]:
            return f"{symbol}-SOL"

    return None


def forward_signal_to_manager(query: str, raw_text: str):
    """
    Kirimkan HTTP POST request ke Node.js Position Manager (localhost:3000/open-position).
    """
    payload = json.dumps({
        "query": query,
        "rawAlert": raw_text,
        "timestamp": datetime.now().isoformat()
    }).encode("utf-8")

    req = urllib.request.Request(
        MANAGER_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            res_data = json.loads(resp.read().decode())
            logger.info(f"✅ [SUCCESS] Sent Signal `{query}` to Position Manager: {res_data}")
    except Exception as e:
        logger.error(f"❌ [ERROR] Gagal mengirim Signal `{query}` ke Position Manager ({MANAGER_URL}): {e}")


@app.on_message(filters.chat(target_filter_chat))
@app.on_edited_message(filters.chat(target_filter_chat))
async def handle_target_alert(client: Client, message):
    """
    Handler dipanggil ketika ada pesan alert BARU atau pesan DIEDIT dari bot target.
    HANYA memproses pesan yang mengandung teks "Warm Entry".
    """
    recv_time = datetime.now()
    full_text = extract_all_text_from_message(message)

    # 🛡️ FILTER KETAT: Hanya proses jika isi pesan mengandung kata "Warm Entry"
    if "warm entry" not in full_text.lower():
        return

    sender_name = message.from_user.username if message.from_user and message.from_user.username else str(message.chat.id)

    logger.info(f"⚡ [WARM ENTRY ALERT DITERIMA/DIEDIT] [{recv_time.strftime('%H:%M:%S.%f')[:-3]}] dari @{sender_name}")
    print("=" * 60)
    print(full_text)
    print("=" * 60)

    target_query = extract_target_query(message)
    if target_query:
        logger.info(f"🎯 [SIGNAL EXTRACTED] Target Query: {target_query}")
        forward_signal_to_manager(target_query, full_text)
    else:
        logger.warning("⚠️ Tidak ditemukan Solana Mint CA maupun Pair Name pada template pesan alert ini.")


if __name__ == "__main__":
    logger.info(f"Memulai Listener Telegram untuk target bot: @{target_filter_chat}...")
    try:
        app.run()
    except KeyboardInterrupt:
        logger.info("Listener dihentikan oleh pengguna.")
