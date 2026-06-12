const CACHE_TTL_MS = 60_000;

let cached: { price: number; fetchedAt: number } | null = null;

/** ETH→USD spot price via Coinbase (free, no API key), cached for ~1 minute. */
export async function getEthUsdPrice(): Promise<number | null> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.price;
  }
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    if (!res.ok) throw new Error(`Coinbase responded ${res.status}`);
    const data = (await res.json()) as { data?: { amount?: string } };
    const price = Number(data.data?.amount);
    if (!Number.isFinite(price) || price <= 0) throw new Error("invalid price payload");
    cached = { price, fetchedAt: Date.now() };
    return price;
  } catch (err) {
    console.warn("ETH/USD price fetch failed:", err);
    return cached?.price ?? null;
  }
}
