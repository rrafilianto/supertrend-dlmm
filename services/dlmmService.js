const { Connection, PublicKey, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm').default || require('@meteora-ag/dlmm');
const { StrategyType } = require('@meteora-ag/dlmm');
const bs58 = require('bs58').default || require('bs58');
const fetch = require('node-fetch');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Mendapatkan koneksi Solana Web3 dan Keypair wallet pengirim.
 */
function getSolanaConnectionAndWallet() {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const privateKeyStr = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKeyStr) {
    throw new Error('SOLANA_PRIVATE_KEY belum dikonfigurasi di file .env');
  }

  let secretKey;
  if (privateKeyStr.trim().startsWith('[')) {
    secretKey = Uint8Array.from(JSON.parse(privateKeyStr));
  } else {
    secretKey = bs58.decode(privateKeyStr.trim());
  }

  const wallet = Keypair.fromSecretKey(secretKey);
  return { connection, wallet };
}

/**
 * Hardcoded Pool Selector (Mendukung query Mint CA atau Pair Name seperti LUNA-SOL):
 * Query ke API Meteora -> Filter Pair SOL -> Filter Bin Step 80-125 -> Sort TVL Tertinggi.
 */
async function fetchAndFilterPool(targetQuery) {
  const apiUrl = `https://dlmm.datapi.meteora.ag/pools?query=${targetQuery}`;
  console.log(`[DLMM Service] Fetching pools from Meteora API: ${apiUrl}`);

  const resp = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) {
    throw new Error(`Gagal menghubungi Meteora API (HTTP ${resp.status})`);
  }

  const data = await resp.json();
  const pools = data.data || [];

  if (pools.length === 0) {
    throw new Error(`Tidak ditemukan pool Meteora DLMM untuk query: ${targetQuery}`);
  }

  // Filter Aturan Hardcoded (Wajib Berpasangan dengan SOL & Bin Step 80-125)
  const eligiblePools = pools.filter(p => {
    const isSolTokenX = p.token_x && p.token_x.address === SOL_MINT && p.token_x.symbol === 'SOL';
    const isSolTokenY = p.token_y && p.token_y.address === SOL_MINT && p.token_y.symbol === 'SOL';

    const isSolPair = isSolTokenX || isSolTokenY;

    const binStep = p.pool_config ? p.pool_config.bin_step : 0;
    const isBinStepValid = binStep >= 80 && binStep <= 125;

    return isSolPair && isBinStepValid;
  });

  if (eligiblePools.length === 0) {
    throw new Error(`Tidak ditemukan pool yang memenuhi kriteria (Pair SOL & Bin Step 80-125) untuk query: ${targetQuery}`);
  }

  // Sort TVL Tertinggi
  eligiblePools.sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
  const selectedPool = eligiblePools[0];

  // Ekstrak Mint CA Token Target (Token non-SOL)
  const targetMint = selectedPool.token_x.address === SOL_MINT ? selectedPool.token_y.address : selectedPool.token_x.address;

  console.log(`[DLMM Service] ✅ Selected Pool: ${selectedPool.name} (${selectedPool.address}) | Derived Mint: ${targetMint} | Bin Step: ${selectedPool.pool_config.bin_step} | TVL: $${selectedPool.tvl}`);
  return { selectedPool, targetMint };
}

/**
 * Mapping string strategi dari .env ke enum StrategyType Meteora.
 */
function parseStrategyType(stratStr) {
  const upper = (stratStr || 'BidAsk').toUpperCase();
  if (upper === 'SPOT') return StrategyType.Spot;
  if (upper === 'CURVE') return StrategyType.Curve;
  return StrategyType.BidAsk; // Default: BidAsk
}

/**
 * Swap Token A ke Token B via Jupiter Swap API v6 dengan Retry 3x.
 */
async function executeJupiterSwap(inputMint, outputMint, inputAmountLamports, connection, wallet, maxRetries = 3) {
  const slippageBps = parseInt(process.env.SWAP_SLIPPAGE_BPS || '150', 10);
  console.log(`[Jupiter Swap] Requesting quote: ${inputAmountLamports} (${inputMint}) -> ${outputMint} (Slippage: ${slippageBps / 100}%)...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${inputAmountLamports}&slippageBps=${slippageBps}`;
      const quoteResp = await fetch(quoteUrl);
      const quoteData = await quoteResp.json();

      if (!quoteData || quoteData.error) {
        throw new Error(`Jupiter Quote Error: ${quoteData?.error || 'No route found'}`);
      }

      console.log(`[Jupiter Swap] Quote received. Output Amount: ${quoteData.outAmount}`);

      const swapResp = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto'
        })
      });

      const swapData = await swapResp.json();
      if (!swapData.swapTransaction) {
        throw new Error('Gagal mendapatkan swapTransaction dari Jupiter API');
      }

      const swapTxBuf = Buffer.from(swapData.swapTransaction, 'base64');
      const { VersionedTransaction } = require('@solana/web3.js');
      const transaction = VersionedTransaction.deserialize(swapTxBuf);
      transaction.sign([wallet]);

      const rawTransaction = transaction.serialize();
      const txid = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 2
      });

      await connection.confirmTransaction(txid, 'confirmed');
      console.log(`[Jupiter Swap] ✅ Swap successful! TxID: https://solscan.io/tx/${txid}`);

      return { txid, outputAmount: quoteData.outAmount };
    } catch (err) {
      console.warn(`[Jupiter Swap] Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

/**
 * Menghitung harga token relatif terhadap SOL dengan mempertimbangkan posisi Token X / Token Y.
 */
function getNormalizedTokenPrice(poolInfo, rawPrice) {
  const price = Number(rawPrice);
  if (!price || isNaN(price)) return 0;
  const isTargetTokenX = poolInfo.token_x && poolInfo.token_x.address !== SOL_MINT;
  return isTargetTokenX ? price : (price > 0 ? 1 / price : 0);
}

/**
 * 2-Step Zap In & Deposition Posisi DLMM Double Side.
 */
async function executeOpenPosition(targetQuery) {
  const isDryRun = process.env.DRY_RUN === 'true';
  const solAmount = parseFloat(process.env.DEFAULT_SOL_AMOUNT || '0.1');
  const strategyStr = process.env.STRATEGY_TYPE || 'BidAsk';
  const binBelow = parseInt(process.env.BIN_BELOW || '15', 10);
  const binAbove = parseInt(process.env.BIN_ABOVE || '15', 10);
  const tpPct = parseFloat(process.env.TAKE_PROFIT_PERCENT || '20');
  const slPct = parseFloat(process.env.STOP_LOSS_PERCENT || '10');

  // 1. Hardcoded Pool Selection (Derive Pool & Mint CA)
  const { selectedPool: poolInfo, targetMint } = await fetchAndFilterPool(targetQuery);

  if (isDryRun) {
    console.log(`[DRY_RUN] 🧪 Mode Simulasi Aktif. Tidak mengirim transaksi ke mainnet.`);
    const rawPrice = poolInfo.current_price || 0.0002;
    const mockEntryPrice = getNormalizedTokenPrice(poolInfo, rawPrice);

    const mockPosition = {
      id: `pos_${Date.now()}`,
      query: targetQuery,
      mint: targetMint,
      poolAddress: poolInfo.address,
      poolName: poolInfo.name,
      positionPubKey: `mock_pos_pubkey_${Date.now()}`,
      entryPrice: mockEntryPrice,
      tpPrice: mockEntryPrice * (1 + tpPct / 100),
      slPrice: mockEntryPrice * (1 - slPct / 100),
      strategy: strategyStr,
      binBelow,
      binAbove,
      solAmount,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      isDryRun: true
    };
    return mockPosition;
  }

  // Live Mainnet Mode
  const { connection, wallet } = getSolanaConnectionAndWallet();

  // 2-Step Zap In: Split 50% SOL untuk di-swap ke Token X
  const totalLamports = Math.floor(solAmount * 1e9);
  const swapLamports = Math.floor(totalLamports / 2);
  const depositLamports = totalLamports - swapLamports;

  // Step 1: Jupiter Swap 50% SOL -> Token X
  const { outputAmount } = await executeJupiterSwap(SOL_MINT, targetMint, swapLamports, connection, wallet);

  // Step 2: Initialize DLMM Position
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolInfo.address));
  const activeBin = await dlmmPool.getActiveBin();

  const minBinId = activeBin.binId - binBelow;
  const maxBinId = activeBin.binId + binAbove;
  const strategyType = parseStrategyType(strategyStr);

  const isTokenX = dlmmPool.tokenX.publicKey.toBase58() === targetMint;
  const totalXAmount = isTokenX ? new (require('@coral-xyz/anchor').BN)(outputAmount) : new (require('@coral-xyz/anchor').BN)(depositLamports);
  const totalYAmount = isTokenX ? new (require('@coral-xyz/anchor').BN)(depositLamports) : new (require('@coral-xyz/anchor').BN)(outputAmount);

  const positionKeyPair = Keypair.generate();

  const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeyPair.publicKey,
    user: wallet.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      minBinId,
      maxBinId,
      strategyType
    }
  });

  const txHash = await sendAndConfirmTransaction(connection, createPositionTx, [wallet, positionKeyPair], {
    commitment: 'confirmed'
  });

  console.log(`[DLMM Service] ✅ Position Deployed! Tx: https://solscan.io/tx/${txHash}`);

  const entryPrice = getNormalizedTokenPrice(poolInfo, activeBin.price);
  const positionRecord = {
    id: `pos_${Date.now()}`,
    query: targetQuery,
    mint: targetMint,
    poolAddress: poolInfo.address,
    poolName: poolInfo.name,
    positionPubKey: positionKeyPair.publicKey.toBase58(),
    entryPrice,
    tpPrice: entryPrice * (1 + tpPct / 100),
    slPrice: entryPrice * (1 - slPct / 100),
    strategy: strategyStr,
    binBelow,
    binAbove,
    solAmount,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    isDryRun: false
  };

  return positionRecord;
}

/**
 * Menutup Posisi DLMM, Tarik Likuiditas, Klaim Fee, & Swap Sisa Token ke SOL.
 */
async function executeClosePosition(positionRecord, reason = 'MANUAL') {
  console.log(`[DLMM Close] Initiating close for position ${positionRecord.positionPubKey} (Reason: ${reason})...`);

  if (positionRecord.isDryRun || process.env.DRY_RUN === 'true') {
    console.log(`[DRY_RUN] 🧪 Simulated Close (Remove Liquidity + Swap 100% Token back to SOL + Close Position Account) for position ${positionRecord.positionPubKey}`);
    return { success: true, reason, isDryRun: true };
  }

  const { connection, wallet } = getSolanaConnectionAndWallet();
  const dlmmPool = await DLMM.create(connection, new PublicKey(positionRecord.poolAddress));

  const userPositions = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const targetPos = userPositions.userPositions.find(p => p.publicKey.toBase58() === positionRecord.positionPubKey);

  if (!targetPos) {
    console.warn(`[DLMM Close] Position ${positionRecord.positionPubKey} not found on-chain. Marking as closed.`);
    return { success: true, reason, note: 'Position not found on chain' };
  }

  // 1. Remove Liquidity & Claim Swap Fees
  const removeLiquidityTx = await dlmmPool.removeLiquidity({
    user: wallet.publicKey,
    position: targetPos.publicKey,
    binIds: targetPos.positionData.positionBinData.map(b => b.binId),
    bps: new (require('@coral-xyz/anchor').BN)(10000), // 100% remove
    shouldClaimFee: true
  });

  const removeTxHash = await sendAndConfirmTransaction(connection, removeLiquidityTx, [wallet], { commitment: 'confirmed' });
  console.log(`[DLMM Close] ✅ Liquidity Removed. Tx: https://solscan.io/tx/${removeTxHash}`);

  // 2. Swap Sisa Token Ke SOL (jika ada sisa token)
  let swapBackTxHash = null;
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(positionRecord.mint) });
    if (tokenAccounts.value.length > 0) {
      const tokenBalRaw = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
      if (BigInt(tokenBalRaw) > 0n) {
        console.log(`🔄 [DLMM Close - TP/SL] Swapping 100% remaining token balance (${tokenBalRaw}) back to SOL via Jupiter...`);
        const swapRes = await executeJupiterSwap(positionRecord.mint, SOL_MINT, tokenBalRaw, connection, wallet);
        swapBackTxHash = swapRes.txid;
        console.log(`✅ [DLMM Close - TP/SL] Token successfully swapped to SOL! Solscan Link: https://solscan.io/tx/${swapBackTxHash}`);
      } else {
        console.log(`ℹ️ [DLMM Close - TP/SL] Token balance is 0 (all liquidity was already in SOL). No swap needed.`);
      }
    }
  } catch (swapErr) {
    console.warn(`⚠️ [DLMM Close - TP/SL] Warning swapping remaining token to SOL:`, swapErr.message);
  }

  // 3. Close Position Account (Reclaim Rent)
  const closeTx = await dlmmPool.closePosition({
    user: wallet.publicKey,
    position: targetPos
  });
  const closeTxHash = await sendAndConfirmTransaction(connection, closeTx, [wallet], { commitment: 'confirmed' });
  console.log(`[DLMM Close] ✅ Position Account Closed. Tx: https://solscan.io/tx/${closeTxHash}`);

  return { success: true, reason, removeTxHash, swapBackTxHash, closeTxHash };
}

module.exports = {
  fetchAndFilterPool,
  executeOpenPosition,
  executeClosePosition,
  getNormalizedTokenPrice,
};
