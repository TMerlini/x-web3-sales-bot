import {
  getCurrentBlock,
  getMintsSince,
  getTokenMetadata,
  getTradesSince,
  TokenMetadata,
  resolveEnsName,
} from "./moralis";
import {
  Collection,
  getActiveCollections,
  getMarketplaces,
  getPollIntervalSeconds,
  hasTweeted,
  markTweeted,
  nextPhrase,
  pruneTweeted,
  setLastBlock,
  enqueueSale,
  listQueue,
  removeQueued,
  bumpQueueAttempt,
} from "./db";
import { getEthUsdPrice } from "./price";
import { formatTweet, groupTradesByTx, postTweet } from "./tweet";
import {
  recordPoll,
  recordMoralis,
  recordTweetOk,
  recordTweetError,
  recordPosted,
  classifyTweetError,
  isXDown,
  logEvent,
} from "./status";

// Give up on a queued sale after this many failed retries (~days of an outage).
const MAX_QUEUE_ATTEMPTS = 100;

// Safety valve so a sudden burst of sales can't blow through X rate limits
// in a single cycle. Remaining sales are picked up on the next cycle.
const MAX_TWEETS_PER_CYCLE = 10;

// Cursor lags the chain head by ~1 hour of blocks so trades Moralis hasn't
// indexed yet aren't skipped (indexing can lag well beyond a few minutes).
// Overlapping ranges are harmless: the tweeted table dedupes them.
const CURSOR_LAG_BLOCKS = 300;

async function processCollection(collection: Collection, currentBlock: number): Promise<void> {
  const fromBlock = collection.last_block + 1;
  const trades = await getTradesSince(collection.contract_address, fromBlock, getMarketplaces());
  if (collection.track_mints) {
    // Moralis's /transfers timestamp index has occasional per-block gaps (HTTP 425
    // "block timestamp not found"). A mints failure must NOT discard the sales already
    // fetched above, nor stall the cursor — isolate it and continue with trades only.
    try {
      trades.push(...(await getMintsSince(collection.contract_address, fromBlock)));
      trades.sort((a, b) => a.blockNumber - b.blockNumber);
    } catch (e: any) {
      console.warn(`[${collection.name}] mints fetch failed, continuing with sales only: ${e?.message ?? e}`);
    }
  }
  const newCursor = Math.max(collection.last_block, currentBlock - CURSOR_LAG_BLOCKS);

  if (trades.length === 0) {
    setLastBlock(collection.id, newCursor);
    return;
  }

  console.log(`[${collection.name}] ${trades.length} trade(s) since block ${fromBlock}`);
  const groups = groupTradesByTx(trades);
  let tweetedCount = 0;

  for (const group of groups) {
    if (hasTweeted(group.txHash, collection.id)) continue;

    if (collection.min_price_eth > 0 && group.totalEth < collection.min_price_eth) {
      markTweeted(group.txHash, collection.id); // below threshold: record as handled
      continue;
    }

    if (tweetedCount >= MAX_TWEETS_PER_CYCLE) {
      // Don't advance the cursor; remaining groups are retried next cycle
      // (already-tweeted ones are skipped via the dedupe table).
      console.log(`[${collection.name}] tweet cap reached, deferring remaining sales`);
      return;
    }

    const [metadata, ethUsd, buyerEns, sellerEns] = await Promise.all([
      group.tokenIds.length > 0
        ? getTokenMetadata(collection.contract_address, group.tokenIds[0])
        : Promise.resolve<TokenMetadata>({}),
      getEthUsdPrice(),
      resolveEnsName(group.buyerAddress),
      resolveEnsName(group.sellerAddress),
    ]);

    const text = formatTweet(collection, group, metadata, ethUsd, nextPhrase(collection), buyerEns, sellerEns);

    // X already known-down this cycle: queue it without hammering the API.
    if (isXDown()) {
      enqueueSale(collection.id, collection.name, group.txHash, text, metadata.imageUrl, "queued: X API down");
      markTweeted(group.txHash, collection.id); // handed to the retry queue; cursor may advance
      continue;
    }

    try {
      await postTweet(text, metadata.imageUrl);
      recordTweetOk();
    } catch (err) {
      const xe = classifyTweetError(err);
      recordTweetError(xe);
      console.error(`[${collection.name}] tweet failed for tx ${group.txHash}:`, err);
      // Decouple retry from the cursor: queue the sale (so the cursor still
      // advances — no Moralis-CU burn from a frozen cursor) and let the queue
      // re-post it when X recovers.
      enqueueSale(collection.id, collection.name, group.txHash, text, metadata.imageUrl, `${xe.kind}: ${xe.message}`);
      markTweeted(group.txHash, collection.id);
      continue;
    }

    markTweeted(group.txHash, collection.id);
    tweetedCount++;
    recordPosted(
      group.tokenIds.length === 1 && group.tokenIds[0]
        ? `${collection.name} #${group.tokenIds[0]}`
        : `${group.tokenIds.length}× ${collection.name}`
    );
    console.log(
      `[${collection.name}] tweeted tx ${group.txHash} (${group.tokenIds.length} token(s), ${group.totalEth} ETH)`
    );
  }

  setLastBlock(collection.id, newCursor);
}

// Retry the sales the queue is holding (e.g. after an X-API outage). Runs at
// the start of each cycle; the first attempt also probes whether X recovered.
async function flushQueue(): Promise<void> {
  const items = listQueue();
  if (items.length === 0) return;
  let sent = 0;
  for (const item of items) {
    if (sent >= MAX_TWEETS_PER_CYCLE) break;
    try {
      await postTweet(item.text, item.image_url ?? undefined);
      recordTweetOk();
      removeQueued(item.id);
      sent++;
      recordPosted(`${item.collection_name} (from queue)`);
    } catch (err) {
      const xe = classifyTweetError(err);
      recordTweetError(xe);
      if (item.attempts + 1 >= MAX_QUEUE_ATTEMPTS) {
        removeQueued(item.id);
        logEvent("error", `Dropped queued sale after ${MAX_QUEUE_ATTEMPTS} tries: ${item.collection_name} ${item.tx_hash.slice(0, 10)}…`);
      } else {
        bumpQueueAttempt(item.id, `${xe.kind}: ${xe.message}`);
      }
      break; // X still down — stop the flush, retry next cycle
    }
  }
}

export function startPoller(): void {
  let cycles = 0;

  const tick = async () => {
    recordPoll();
    await flushQueue(); // post anything queued first (and probe X health)
    const collections = getActiveCollections();
    if (collections.length > 0) {
      let currentBlock: number | null = null;
      try {
        currentBlock = await getCurrentBlock();
        recordMoralis(true);
      } catch (err) {
        recordMoralis(false, err instanceof Error ? err.message : String(err));
        console.error("Could not fetch current block, skipping cycle:", err);
      }
      if (currentBlock !== null) {
        for (const collection of collections) {
          try {
            await processCollection(collection, currentBlock);
          } catch (err) {
            console.error(`[${collection.name}] poll cycle failed:`, err);
          }
        }
      }
    }
    if (++cycles % 1440 === 0) pruneTweeted();
    setTimeout(tick, getPollIntervalSeconds() * 1000);
  };

  console.log(`Poller started (every ${getPollIntervalSeconds()}s, adjustable from the dashboard)`);
  void tick();
}
