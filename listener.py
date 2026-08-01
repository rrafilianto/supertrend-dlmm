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

# Regex pattern untuk Pair Name (misal: S-SOL, LUNA-SOL, Fauci-SOL, SHORTCAT-SOL)
PAIR_NAME_REGEX = re.compile(r"\b([A-Za-z0-9_]+-SOL)\b", re.IGNORECASE)

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
    if message.text:
        texts.append(message.text)
    if message.caption:
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
    Ekstrak Solana Contract Address (CA) atau Pair Name (misal: S-SOL, LUNA-SOL) dari template pesan alert Gambar 1.
    """
    full_text = extract_all_text_from_message(message)
    if not full_text:
        return None

    # 1. Coba ekstrak Solana Mint Address (Base58) dari seluruh isi teks & entitas
    ca_matches = SOLANA_CA_REGEX.findall(full_text)
    for match in ca_matches:
        if len(match) >= 32 and len(match) <= 44:
            if match in ["Discovery", "Supertrend", "Meteora", "Bullish", "Bearish", "Value", "Metric"]:
                continue
            return match

    # 2. Jika tidak ada CA polos/entitas, ekstrak Pair Name (misal: S-SOL, LUNA-SOL, Fauci-SOL)
    pair_matches = PAIR_NAME_REGEX.findall(full_text)
    if pair_matches:
        return pair_matches[0].upper()

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
async def handle_target_alert(client: Client, message):
    """
    Handler dipanggil ketika ada pesan alert masuk dari bot target.
    """
    recv_time = datetime.now()
    raw_text = message.text or message.caption or ""
    sender_name = message.from_user.username if message.from_user and message.from_user.username else str(message.chat.id)

    logger.info(f"⚡ [ALERT DITERIMA] [{recv_time.strftime('%H:%M:%S.%f')[:-3]}] dari @{sender_name}")
    print("=" * 60)
    print(raw_text)
    print("=" * 60)

    target_query = extract_target_query(message)
    if target_query:
        logger.info(f"🎯 [SIGNAL EXTRACTED] Target Query: {target_query}")
        forward_signal_to_manager(target_query, raw_text)
    else:
        logger.warning("⚠️ Tidak ditemukan Solana Mint CA maupun Pair Name pada template pesan alert ini.")


if __name__ == "__main__":
    logger.info(f"Memulai Listener Telegram untuk target bot: @{target_filter_chat}...")
    try:
        app.run()
    except KeyboardInterrupt:
        logger.info("Listener dihentikan oleh pengguna.")
