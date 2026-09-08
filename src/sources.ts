// On-chain / Alchemy data sources — replaces the Moralis layer (Moralis paused its free tier 2026-09).
// Same public surface the poller/tweet/server already consume: Trade, TokenMetadata, marketplaceLabel,
// getCurrentBlock, getTradesSince, getMintsSince, getTokenMetadata, resolveEnsName.
//
// Sales come from Alchemy's parsed getNFTSales (REST); mints + tx values + ENS come from the Alchemy
// JSON-RPC endpoint via ethers. Every collection is queried uniformly — whatever trades on OpenSea/Seaport
// (incl. Pixel Goblins) is picked up. No third-party quota that resets on us the way Moralis did.

import { ethers } from "ethers";

function apiKey(): string {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw new Error("ALCHEMY_API_KEY is not set");
  return key;
}
const NFT_BASE = () => `https://eth-mainnet.g.alchemy.com/nft/v3/${apiKey()}`;
const RPC_URL = () => `https://eth-mainnet.g.alchemy.com/v2/${apiKey()}`;

let _provider: ethers.JsonRpcProvider | null = null;
function provider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL());
  return _provider;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alchemy request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface Trade {
  transactionHash: string;
  marketplace: string;
  tokenIds: string[];
  sellerAddress: string;
  buyerAddress: string;
  /** Total buyer-paid price, assumed 18-decimal ETH/WETH (true for all supported marketplaces). */
  priceEth: number;
  blockNumber: number;
}

export interface TokenMetadata {
  name?: string;
  imageUrl?: string;
}

// ── sales: Alchemy getNFTSales ───────────────────────────────────────────────────────────────────────
interface Fee { amount?: string | null; decimals?: number | null }
interface RawSale {
  marketplace?: string;
  contractAddress?: string;
  tokenId?: string;
  buyerAddress?: string;
  sellerAddress?: string;
  sellerFee?: Fee; protocolFee?: Fee; royaltyFee?: Fee;
  blockNumber?: number;
  transactionHash?: string;
}

// Buyer-paid total = what the seller nets + marketplace fee + royalty, all in the payment token.
// (Verified against a real Goblinarinos sale: seller 0.2925 + protocol 0.0075 = 0.3 ETH.)
function salePriceEth(s: RawSale): number {
  let total = 0n;
  let decimals = 18;
  for (const f of [s.sellerFee, s.protocolFee, s.royaltyFee]) {
    if (f?.amount) {
      total += BigInt(f.amount);
      if (typeof f.decimals === "number") decimals = f.decimals;
    }
  }
  return Number(total) / 10 ** decimals;
}

export async function getTradesSince(
  contractAddress: string,
  fromBlock: number,
  _marketplaces?: readonly string[] // Alchemy returns all marketplaces; kept for signature compatibility.
): Promise<Trade[]> {
  const trades: Trade[] = [];
  // Alchemy getNFTSales 400s on a high fromBlock when toBlock is the string "latest" (a quiet collection
  // whose last sale is far behind the live cursor). An explicit NUMERIC toBlock avoids it. If the cursor
  // has caught up to head there is nothing to scan.
  const head = await getCurrentBlock();
  if (fromBlock > head) return trades;
  let pageKey: string | undefined;
  do {
    const params = new URLSearchParams({
      fromBlock: String(fromBlock),
      toBlock: String(head),
      order: "asc",
      contractAddress,
      limit: "1000",
    });
    if (pageKey) params.set("pageKey", pageKey);
    const data = await fetchJson<{ nftSales?: RawSale[]; pageKey?: string }>(
      `${NFT_BASE()}/getNFTSales?${params}`
    );
    for (const s of data.nftSales ?? []) {
      trades.push({
        transactionHash: s.transactionHash ?? "",
        marketplace: s.marketplace ?? "unknown",
        tokenIds: s.tokenId != null ? [String(s.tokenId)] : [],
        sellerAddress: s.sellerAddress ?? "",
        buyerAddress: s.buyerAddress ?? "",
        priceEth: salePriceEth(s),
        blockNumber: Number(s.blockNumber ?? 0),
      });
    }
    pageKey = data.pageKey || undefined;
  } while (pageKey);
  trades.sort((a, b) => a.blockNumber - b.blockNumber);
  return trades;
}

// ── mints: Alchemy getAssetTransfers (from the zero address) + tx value for price ──────────────────────
const ZERO = "0x0000000000000000000000000000000000000000";
// ERC-721 Transfer(address,address,uint256) topic0 — used to find a mint's true recipient below.
const ERC721_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface RawTransfer { hash?: string; from?: string; to?: string; tokenId?: string; blockNum?: string }

export async function getMintsSince(contractAddress: string, fromBlock: number): Promise<Trade[]> {
  const transfers: RawTransfer[] = [];
  let pageKey: string | undefined;
  do {
    const res = await fetch(RPC_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers",
        params: [{
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "latest",
          fromAddress: ZERO,
          contractAddresses: [contractAddress],
          category: ["erc721", "erc1155"],
          order: "asc",
          maxCount: "0x3e8",
          ...(pageKey ? { pageKey } : {}),
        }],
      }),
    });
    if (!res.ok) throw new Error(`getAssetTransfers failed (${res.status})`);
    const j = (await res.json()) as { result?: { transfers?: RawTransfer[]; pageKey?: string }; error?: { message?: string } };
    if (j.error) throw new Error(`getAssetTransfers: ${j.error.message}`);
    transfers.push(...(j.result?.transfers ?? []));
    pageKey = j.result?.pageKey || undefined;
  } while (pageKey);

  // Group minted tokens by tx; price = the ETH value of the mint tx (matches the prior behaviour).
  const byTx = new Map<string, RawTransfer[]>();
  for (const t of transfers) {
    if (!t.hash) continue;
    const list = byTx.get(t.hash);
    if (list) list.push(t); else byTx.set(t.hash, [t]);
  }
  const mints: Trade[] = [];
  for (const [hash, list] of byTx) {
    const tokenIds = [...new Set(list.filter((t) => t.tokenId != null).map((t) => String(BigInt(t.tokenId!))))];
    if (tokenIds.length === 0) continue;
    let priceEth = 0;
    let blockNumber = 0;
    // Default recipient = the `to` of the last 0x0-sourced transfer. When a collection mints THROUGH
    // a minter contract (0x0 -> minter -> buyer) that is the MINTER (always the same address), not the
    // buyer — because the minter->buyer leg is not 0x0-sourced and so is absent from `list`. Refined
    // from the tx's Transfer logs below.
    let finalRecipient = list[list.length - 1].to ?? "";
    try {
      const tx = await provider().getTransaction(hash);
      if (tx) {
        priceEth = Number(ethers.formatEther(tx.value ?? 0n));
        blockNumber = tx.blockNumber ?? 0;
      }
      // True recipient: the last ERC-721 Transfer of THIS contract in the tx is where the token
      // actually landed, even when a minter contract is the first hop. Falls back to the 0x0-leg
      // recipient if the receipt is unavailable or carries no ERC-721 Transfer (e.g. ERC-1155).
      const receipt = await provider().getTransactionReceipt(hash);
      if (receipt) {
        const addr = contractAddress.toLowerCase();
        const xfers = receipt.logs.filter(
          (l) => l.address.toLowerCase() === addr && l.topics[0] === ERC721_TRANSFER && l.topics.length === 4
        );
        if (xfers.length) {
          const to = ethers.getAddress(ethers.dataSlice(xfers[xfers.length - 1].topics[2], 12));
          if (to && to !== ZERO) finalRecipient = to;
        }
      }
    } catch { /* tx/receipt lookup best-effort; keep the 0x0-leg recipient + zero price/block */ }
    if (!blockNumber && list[0].blockNum) blockNumber = parseInt(list[0].blockNum, 16);
    mints.push({
      transactionHash: hash, marketplace: "mint", tokenIds,
      sellerAddress: "", buyerAddress: finalRecipient, priceEth, blockNumber,
    });
  }
  return mints;
}

// ── token metadata: Alchemy getNFTMetadata ─────────────────────────────────────────────────────────────
function resolveImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${url.replace("ipfs://", "").replace(/^ipfs\//, "")}`;
  return url.startsWith("http") ? url : undefined;
}

export async function getTokenMetadata(contractAddress: string, tokenId: string): Promise<TokenMetadata> {
  try {
    const params = new URLSearchParams({ contractAddress, tokenId, refreshCache: "false" });
    const data = await fetchJson<{
      name?: string;
      image?: { cachedUrl?: string; originalUrl?: string; pngUrl?: string };
      raw?: { metadata?: { name?: string; image?: string } };
    }>(`${NFT_BASE()}/getNFTMetadata?${params}`);
    const name = data.name || data.raw?.metadata?.name || undefined;
    const imageUrl =
      data.image?.cachedUrl || data.image?.pngUrl || data.image?.originalUrl ||
      resolveImageUrl(data.raw?.metadata?.image);
    return { name, imageUrl };
  } catch (err) {
    console.warn(`Token metadata lookup failed for ${contractAddress} #${tokenId}:`, err);
    return {};
  }
}

// ── chain head + ENS (via the Alchemy JSON-RPC endpoint) ───────────────────────────────────────────────
export async function getCurrentBlock(): Promise<number> {
  return await provider().getBlockNumber();
}

export async function resolveEnsName(address: string): Promise<string | undefined> {
  if (!address) return undefined;
  try {
    return (await provider().lookupAddress(address)) || undefined;
  } catch {
    return undefined;
  }
}

// ── marketplace labels (unchanged) ─────────────────────────────────────────────────────────────────────
export function marketplaceLabel(marketplace: string): string {
  switch (marketplace?.toLowerCase()) {
    case "opensea":
    case "seaport":
    case "wyvern": return "OpenSea";
    case "blur": return "Blur";
    case "looksrare": return "LooksRare";
    case "x2y2": return "X2Y2";
    case "0xprotocol": return "0x Protocol";
    case "mint": return "Mint";
    default: return marketplace || "Unknown";
  }
}
