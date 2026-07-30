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

# Regex pattern untuk mencocokkan Solana Mint Address (Base58 32-44 karakter)
SOLANA_CA_REGEX = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")

# Inisialisasi Pyrogram Client
app = Client(
    name="alert_listener_session",
    api_id=int(API_ID),
    api_hash=API_HASH,
)


def extract_mint_address(text: str) -> str | None:
    """
    Ekstrak Solana Contract Address (Base58) dari teks alert Telegram.
    Akan mengabaikan kata-kata umum dan fokus pada string CA valid (biasanya diakhiri 'pump' atau 43-44 char).
    """
    if not text:
        return None

    matches = SOLANA_CA_REGEX.findall(text)
    for match in matches:
        if len(match) >= 32 and len(match) <= 44:
            if match in ["Discovery", "Supertrend", "Meteora", "Bullish", "Bearish"]:
                continue
            return match
    return None


def forward_mint_to_manager(mint_ca: str, raw_text: str):
    """
    Kirimkan HTTP POST request ke Node.js Position Manager (localhost:3000/open-position).
    """
    payload = json.dumps({
        "mint": mint_ca,
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
            logger.info(f"✅ [SUCCESS] Sent CA {mint_ca} to Position Manager: {res_data}")
    except Exception as e:
        logger.error(f"❌ [ERROR] Gagal mengirim CA {mint_ca} ke Position Manager ({MANAGER_URL}): {e}")


@app.on_message(filters.chat(target_filter_chat))
async def handle_target_alert(client: Client, message):
    """
    Handler dipanggil ketika ada pesan alert masuk dari bot target.
    """
    recv_time = datetime.now()
    text = message.text or message.caption or ""
    sender_name = message.from_user.username if message.from_user and message.from_user.username else str(message.chat.id)

    logger.info(f"⚡ [ALERT DITERIMA] [{recv_time.strftime('%H:%M:%S.%f')[:-3]}] dari @{sender_name}")
    print("=" * 60)
    print(text)
    print("=" * 60)

    mint_ca = extract_mint_address(text)
    if mint_ca:
        logger.info(f"🎯 [MINT EXTACTED] Found Solana Token CA: {mint_ca}")
        forward_mint_to_manager(mint_ca, text)
    else:
        logger.warning("⚠️ Tidak ditemukan Solana Mint Address pada pesan alert ini.")


if __name__ == "__main__":
    logger.info(f"Memulai Listener Telegram untuk target bot: @{target_filter_chat}...")
    try:
        app.run()
    except KeyboardInterrupt:
        logger.info("Listener dihentikan oleh pengguna.")
