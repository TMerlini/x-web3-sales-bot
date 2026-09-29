// On-chain / Alchemy data sources — replaces the Moralis layer (Moralis paused its free tier 2026-09).
// Same public surface the poller/tweet/server already consume: Trade, TokenMetadata, marketplaceLabel,
// getCurrentBlock, getTradesSince, getMintsSince, getTokenMetadata, resolveEnsName.
//
// Sales are DERIVED ON-CHAIN (see getTradesSince); mints + tx values + ENS come from the Alchemy
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
  /**
   * How priceEth was obtained. "underivable" means we found a real sale but could not price it
   * (e.g. a payment token we do not decode). It is NOT the same as a 0 ETH sale, and callers MUST
   * NOT let it fall through a min-price filter silently — see poller.ts.
   */
  priceSource: "tx.value" | "weth-logs" | "underivable";
  blockNumber: number;
}

export interface TokenMetadata {
  name?: string;
  imageUrl?: string;
}

// ── sales: DERIVED ON-CHAIN ──────────────────────────────────────────────────────────────────────────
// Alchemy's getNFTSales was removed on 2026-09-30, and had in any case been useless to us for far
// longer: its index is frozen at block 19777901 (2024-05-01), which every response still reports in
// `validAt`. Because this bot polls from the live cursor, every call returned an empty list. The
// bot's own history shows it: 6 sales posted under Moralis (Jul-Aug 2026), then 0 after the Alchemy
// migration on 2026-09-08, while mints kept posting. A vendor's parsed feed hid its own staleness.
//
// So a sale is now defined, and derived, from the primary artifact:
//
//   A sale is an ERC-721/1155 Transfer whose `from` is not the zero address, and whose transaction
//   also contains a known marketplace fill event.
//
// That rule also does something getNFTSales did silently: it excludes wallet-to-wallet and OTC
// transfers, because those carry no fill event.
//
// Marketplace topic0s are DERIVED with ethers.id() from the human-readable signature, never pasted
// as opaque hex — a reviewer can check the string, not a digest.
const FILL_EVENT_SIGS: Record<string, string> = {
  seaport:   "OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])",
  looksrare: "TakerBid((bytes32,uint256,uint256,address,address,address),address,address,uint256,address,address,address,uint256,uint256[],uint256[])",
  x2y2:      "EvInventory(bytes32,address,address,uint256,uint256,uint256,uint256,uint256,address,bytes,(uint256,bytes))",
  blur:      "Execution721TakerFeePacked(bytes32,uint256,uint256,uint256)",
};
/** topic0 -> marketplace name, in the vocabulary marketplaceLabel() already understands. */
const FILL_TOPICS: Record<string, string> = Object.fromEntries(
  Object.entries(FILL_EVENT_SIGS).map(([name, sig]) => [ethers.id(sig), name])
);
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

/**
 * All ERC-721/1155 transfers for a collection in a block range, paginated to completion.
 * Same call the mints path uses, minus the `fromAddress: ZERO` filter.
 */
async function getAllTransfers(contractAddress: string, fromBlock: number, toBlock: number) {
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
          toBlock: "0x" + toBlock.toString(16),
          contractAddresses: [contractAddress],
          category: ["erc721", "erc1155"],
          order: "asc",
          maxCount: "0x3e8",
          ...(pageKey ? { pageKey } : {}),
        }],
      }),
    });
    if (!res.ok) throw new Error(`getAssetTransfers failed (${res.status})`);
    const j = (await res.json()) as { result?: { transfers?: RawTransfer[]; pageKey?: string }; error?: { message: string } };
    if (j.error) throw new Error(`getAssetTransfers: ${j.error.message}`);
    transfers.push(...(j.result?.transfers ?? []));
    pageKey = j.result?.pageKey || undefined;
  } while (pageKey);
  return transfers;
}

export async function getTradesSince(
  contractAddress: string,
  fromBlock: number,
  _marketplaces?: readonly string[] // every marketplace with a known fill event is picked up; kept for signature compatibility.
): Promise<Trade[]> {
  const trades: Trade[] = [];
  const head = await getCurrentBlock();
  if (fromBlock > head) return trades;

  // Candidate sales = transfers that are not mints. Mints are getMintsSince()'s job; including them
  // here would double-post.
  const byTx = new Map<string, RawTransfer[]>();
  for (const t of await getAllTransfers(contractAddress, fromBlock, head)) {
    if (!t.hash) continue;
    if ((t.from ?? "").toLowerCase() === ZERO) continue;
    const list = byTx.get(t.hash);
    if (list) list.push(t); else byTx.set(t.hash, [t]);
  }

  for (const [hash, list] of byTx) {
    const receipt = await provider().getTransactionReceipt(hash);
    if (!receipt) continue;

    // Which marketplace filled it? No fill event -> not a sale (wallet-to-wallet / OTC).
    let marketplace: string | undefined;
    for (const log of receipt.logs) {
      const m = FILL_TOPICS[log.topics[0]];
      if (m) { marketplace = m; break; }
    }
    if (!marketplace) continue;

    // Price. ETH first; then WETH movement. Never guess — an undecidable price is labelled, not zeroed.
    const tx = await provider().getTransaction(hash);
    let priceEth = Number(ethers.formatEther(tx?.value ?? 0n));
    let priceSource: Trade["priceSource"] = "tx.value";
    if (priceEth === 0) {
      let weth = 0n;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === WETH_ADDRESS && log.topics[0] === ERC721_TRANSFER) {
          try { weth += BigInt(log.data); } catch { /* non-standard data; ignore this leg */ }
        }
      }
      if (weth > 0n) { priceEth = Number(ethers.formatEther(weth)); priceSource = "weth-logs"; }
      else priceSource = "underivable";
    }

    // Seller/buyer/tokens from the collection's own Transfer logs in this tx, so a bundle keeps every id.
    const nftLogs = receipt.logs.filter(
      (l) => l.address.toLowerCase() === contractAddress.toLowerCase() &&
             l.topics[0] === ERC721_TRANSFER && l.topics.length >= 4
    );
    const tokenIds = nftLogs.length
      ? [...new Set(nftLogs.map((l) => String(BigInt(l.topics[3]))))]
      : [...new Set(list.filter((t) => t.tokenId != null).map((t) => String(BigInt(t.tokenId!))))];

    trades.push({
      transactionHash: hash,
      marketplace,
      tokenIds,
      sellerAddress: nftLogs.length ? ethers.getAddress("0x" + nftLogs[0].topics[1].slice(26)) : (list[0].from ?? ""),
      buyerAddress:  nftLogs.length ? ethers.getAddress("0x" + nftLogs[nftLogs.length - 1].topics[2].slice(26)) : (list[list.length - 1].to ?? ""),
      priceEth,
      priceSource,
      blockNumber: receipt.blockNumber,
    });
  }

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
      sellerAddress: "", buyerAddress: finalRecipient, priceEth, priceSource: "tx.value", blockNumber,
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
