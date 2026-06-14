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
} from "./db";
import { getEthUsdPrice } from "./price";
import { formatTweet, groupTradesByTx, postTweet } from "./tweet";

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
    trades.push(...(await getMintsSince(collection.contract_address, fromBlock)));
    trades.sort((a, b) => a.blockNumber - b.blockNumber);
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

    try {
      await postTweet(text, metadata.imageUrl);
    } catch (err) {
      // Tweet failed (rate limit, network, ...): don't mark, don't advance
      // the cursor — this group is retried on the next cycle.
      console.error(`[${collection.name}] tweet failed for tx ${group.txHash}:`, err);
      return;
    }

    markTweeted(group.txHash, collection.id);
    tweetedCount++;
    console.log(
      `[${collection.name}] tweeted tx ${group.txHash} (${group.tokenIds.length} token(s), ${group.totalEth} ETH)`
    );
  }

  setLastBlock(collection.id, newCursor);
}

export function startPoller(): void {
  let cycles = 0;

  const tick = async () => {
    const collections = getActiveCollections();
    if (collections.length > 0) {
      let currentBlock: number | null = null;
      try {
        currentBlock = await getCurrentBlock();
      } catch (err) {
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
