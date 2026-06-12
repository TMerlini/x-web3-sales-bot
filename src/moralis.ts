const BASE = "https://deep-index.moralis.io/api/v2.2";

// One request per marketplace per poll cycle (Moralis takes a single
// marketplace per call). Each call costs ~40 CUs on the Moralis free tier.
const MARKETPLACES = ["opensea", "blur", "looksrare", "x2y2", "0xprotocol"];

function apiKey(): string {
  const key = process.env.MORALIS_API_KEY;
  if (!key) throw new Error("MORALIS_API_KEY is not set");
  return key;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "X-API-Key": apiKey(), accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Moralis request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface RawTrade {
  transaction_hash: string;
  token_ids?: string[];
  seller_address?: string;
  buyer_address?: string;
  marketplace?: string;
  price?: string;
  price_token_address?: string | null;
  block_number?: string | number;
}

export interface Trade {
  transactionHash: string;
  marketplace: string;
  tokenIds: string[];
  sellerAddress: string;
  buyerAddress: string;
  /** Total trade price, assumed 18-decimal ETH/WETH (true for all supported marketplaces). */
  priceEth: number;
  blockNumber: number;
}

function parseTrade(raw: RawTrade, marketplace: string): Trade {
  return {
    transactionHash: raw.transaction_hash,
    marketplace: raw.marketplace || marketplace,
    tokenIds: raw.token_ids ?? [],
    sellerAddress: raw.seller_address ?? "",
    buyerAddress: raw.buyer_address ?? "",
    priceEth: raw.price ? Number(raw.price) / 1e18 : 0,
    blockNumber: Number(raw.block_number ?? 0),
  };
}

/**
 * Fetch all trades for a contract from `fromBlock` (inclusive) onwards across
 * every supported marketplace, sorted oldest-first.
 */
export async function getTradesSince(contractAddress: string, fromBlock: number): Promise<Trade[]> {
  const all: Trade[] = [];
  for (const marketplace of MARKETPLACES) {
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        chain: "eth",
        marketplace,
        from_block: String(fromBlock),
        limit: "100",
      });
      if (cursor) params.set("cursor", cursor);
      const data = await fetchJson<{ result?: RawTrade[]; cursor?: string | null }>(
        `${BASE}/nft/${contractAddress}/trades?${params}`
      );
      for (const raw of data.result ?? []) all.push(parseTrade(raw, marketplace));
      cursor = data.cursor || undefined;
    } while (cursor);
  }
  all.sort((a, b) => a.blockNumber - b.blockNumber);
  return all;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface RawTransfer {
  transaction_hash: string;
  token_id?: string;
  from_address?: string;
  to_address?: string;
  value?: string;
  block_number?: string | number;
  log_index?: string | number;
}

/**
 * Fetch mints (transfers from the zero address) for a contract from
 * `fromBlock` onwards, represented as Trade objects with marketplace "mint".
 * The trade price is the ETH value sent with the mint transaction.
 */
export async function getMintsSince(contractAddress: string, fromBlock: number): Promise<Trade[]> {
  const transfers: RawTransfer[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      chain: "eth",
      from_block: String(fromBlock),
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const data = await fetchJson<{ result?: RawTransfer[]; cursor?: string | null }>(
      `${BASE}/nft/${contractAddress}/transfers?${params}`
    );
    transfers.push(...(data.result ?? []));
    cursor = data.cursor || undefined;
  } while (cursor);

  const byTx = new Map<string, RawTransfer[]>();
  for (const transfer of transfers) {
    const list = byTx.get(transfer.transaction_hash);
    if (list) list.push(transfer);
    else byTx.set(transfer.transaction_hash, [transfer]);
  }

  const mints: Trade[] = [];
  for (const [txHash, list] of byTx) {
    const mintedTokenIds = [
      ...new Set(
        list
          .filter((t) => t.from_address?.toLowerCase() === ZERO_ADDRESS && t.token_id)
          .map((t) => t.token_id as string)
      ),
    ];
    if (mintedTokenIds.length === 0) continue;

    // A mint tx can forward the token onwards in the same tx (mint -> buyer);
    // the final recipient is the last transfer by log index.
    const sorted = [...list].sort((a, b) => Number(a.log_index ?? 0) - Number(b.log_index ?? 0));
    const finalRecipient = sorted[sorted.length - 1].to_address ?? "";

    mints.push({
      transactionHash: txHash,
      marketplace: "mint",
      tokenIds: mintedTokenIds,
      sellerAddress: "",
      buyerAddress: finalRecipient,
      // value is the tx's ETH value (mirrored on each transfer), not per-transfer
      priceEth: Number(list[0].value ?? 0) / 1e18,
      blockNumber: Number(list[0].block_number ?? 0),
    });
  }
  return mints;
}

export interface TokenMetadata {
  name?: string;
  imageUrl?: string;
}

function resolveImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${url.replace("ipfs://", "").replace(/^ipfs\//, "")}`;
  }
  return url.startsWith("http") ? url : undefined;
}

export async function getTokenMetadata(
  contractAddress: string,
  tokenId: string
): Promise<TokenMetadata> {
  try {
    const params = new URLSearchParams({
      chain: "eth",
      format: "decimal",
      normalizeMetadata: "true",
      media_items: "true",
    });
    const data = await fetchJson<{
      name?: string;
      metadata?: string;
      normalized_metadata?: { name?: string; image?: string };
      media?: { media_collection?: { high?: { url?: string } }; original_media_url?: string };
    }>(`${BASE}/nft/${contractAddress}/${tokenId}?${params}`);

    let metaName: string | undefined;
    let metaImage: string | undefined;
    if (data.metadata) {
      try {
        const parsed = JSON.parse(data.metadata) as { name?: string; image?: string };
        metaName = parsed.name;
        metaImage = parsed.image;
      } catch {
        /* unparseable metadata, fall through */
      }
    }

    const name =
      data.normalized_metadata?.name ||
      metaName ||
      (data.name ? `${data.name} #${tokenId}` : undefined);
    const imageUrl =
      data.media?.media_collection?.high?.url ||
      resolveImageUrl(data.normalized_metadata?.image) ||
      resolveImageUrl(metaImage) ||
      resolveImageUrl(data.media?.original_media_url);

    return { name, imageUrl };
  } catch (err) {
    console.warn(`Token metadata lookup failed for ${contractAddress} #${tokenId}:`, err);
    return {};
  }
}

const PUBLIC_RPCS = ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"];

export async function getCurrentBlock(): Promise<number> {
  let lastError: unknown;
  for (const rpc of PUBLIC_RPCS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (!res.ok) throw new Error(`RPC responded ${res.status}`);
      const data = (await res.json()) as { result?: string };
      if (!data.result) throw new Error("no result");
      return parseInt(data.result, 16);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`All public RPCs failed: ${lastError}`);
}

/** Human-readable marketplace labels for tweet text. */
export function marketplaceLabel(marketplace: string): string {
  switch (marketplace?.toLowerCase()) {
    case "opensea":
    case "seaport":
    case "wyvern":
      return "OpenSea";
    case "blur":
      return "Blur";
    case "looksrare":
      return "LooksRare";
    case "x2y2":
      return "X2Y2";
    case "0xprotocol":
      return "0x Protocol";
    case "mint":
      return "Mint";
    default:
      return marketplace || "Unknown";
  }
}
