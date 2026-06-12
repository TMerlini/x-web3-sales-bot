import { TwitterApi } from "twitter-api-v2";
import { Trade, TokenMetadata, marketplaceLabel } from "./moralis";
import { Collection, isDryRun } from "./db";

let client: TwitterApi | null = null;

function getClient(): TwitterApi {
  if (!client) {
    const { X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
    if (!X_CONSUMER_KEY || !X_CONSUMER_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
      throw new Error("X API credentials are not fully configured");
    }
    client = new TwitterApi({
      appKey: X_CONSUMER_KEY,
      appSecret: X_CONSUMER_SECRET,
      accessToken: X_ACCESS_TOKEN,
      accessSecret: X_ACCESS_SECRET,
    });
  }
  return client;
}

function shortAddress(address: string): string {
  if (!address || address.length < 10) return address || "?";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatAmount(amount: number): string {
  if (amount >= 1000) return amount.toFixed(0);
  if (amount >= 1) return parseFloat(amount.toFixed(3)).toString();
  return parseFloat(amount.toFixed(5)).toString();
}

function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export interface SaleGroup {
  txHash: string;
  tokenIds: string[];
  totalEth: number;
  marketplace: string;
  buyerAddress: string;
  sellerAddress: string;
}

/** Merge trades sharing a transaction hash (sweeps) into single units. */
export function groupTradesByTx(trades: Trade[]): SaleGroup[] {
  const groups = new Map<string, SaleGroup>();
  for (const trade of trades) {
    const existing = groups.get(trade.transactionHash);
    if (existing) {
      existing.tokenIds.push(...trade.tokenIds);
      existing.totalEth += trade.priceEth;
    } else {
      groups.set(trade.transactionHash, {
        txHash: trade.transactionHash,
        tokenIds: [...trade.tokenIds],
        totalEth: trade.priceEth,
        marketplace: trade.marketplace,
        buyerAddress: trade.buyerAddress,
        sellerAddress: trade.sellerAddress,
      });
    }
  }
  return [...groups.values()];
}

export function formatTweet(
  collection: Collection,
  group: SaleGroup,
  metadata: TokenMetadata,
  ethUsd: number | null,
  phrase: string | null
): string {
  const market = marketplaceLabel(group.marketplace);
  const isMint = group.marketplace === "mint";
  const usd = ethUsd && group.totalEth > 0 ? ` ($${formatUsd(group.totalEth * ethUsd)})` : "";
  const priceText = group.totalEth > 0 ? ` for ${formatAmount(group.totalEth)} ETH${usd}` : "";
  const lead = phrase ? [phrase, ``] : [];

  if (group.tokenIds.length <= 1) {
    const tokenId = group.tokenIds[0];
    const name = metadata.name || (tokenId ? `${collection.name} #${tokenId}` : collection.name);
    const link = tokenId
      ? `https://opensea.io/assets/ethereum/${collection.contract_address}/${tokenId}`
      : `https://etherscan.io/tx/${group.txHash}`;
    const headline = isMint
      ? `${name} minted${priceText}`
      : `${name} sold${priceText} on ${market}`;
    const parties = isMint
      ? `Minter: ${shortAddress(group.buyerAddress)}`
      : `${shortAddress(group.sellerAddress)} → ${shortAddress(group.buyerAddress)}`;
    return [...lead, headline, ``, parties, ``, link].join("\n");
  }

  const headline = isMint
    ? `${group.tokenIds.length} ${collection.name} minted${priceText}`
    : `${group.tokenIds.length} ${collection.name} swept${priceText} on ${market}`;
  return [
    ...lead,
    headline,
    ``,
    `${isMint ? "Minter" : "Buyer"}: ${shortAddress(group.buyerAddress)}`,
    ``,
    `https://etherscan.io/tx/${group.txHash}`,
  ].join("\n");
}

async function downloadImage(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!/^image\/(jpeg|png|gif|webp)/.test(contentType)) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    // X media upload limit is 5MB for images
    if (buffer.length > 5 * 1024 * 1024) return null;
    return { buffer, mimeType: contentType.split(";")[0] };
  } catch {
    return null;
  }
}

export async function postTweet(text: string, imageUrl?: string): Promise<void> {
  if (isDryRun()) {
    console.log(`[DRY_RUN] Would tweet:\n${text}\n(image: ${imageUrl || "none"})`);
    return;
  }

  const api = getClient();
  let mediaIds: string[] = [];

  if (imageUrl) {
    const image = await downloadImage(imageUrl);
    if (image) {
      try {
        const mediaId = await api.v1.uploadMedia(image.buffer, { mimeType: image.mimeType });
        mediaIds = [mediaId];
      } catch (err) {
        console.warn("Media upload failed, tweeting without image:", err);
      }
    }
  }

  await api.v2.tweet(
    mediaIds.length > 0 ? { text, media: { media_ids: [mediaIds[0]] } } : { text }
  );
}
