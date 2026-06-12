# NFT Sales X Bot (Multi-Collection, Multi-Marketplace)

A self-hosted bot that watches NFT sales for **multiple Ethereum collections** across all major marketplaces (OpenSea, Blur, LooksRare, X2Y2, 0x Protocol) and tweets each sale from a single X account. Collections are managed through a built-in, password-protected web dashboard.

Sales data comes from Moralis' [NFT Trades API](https://docs.moralis.com/web3-data-api/evm/reference/get-nft-trades), which indexes trades across marketplaces — no contract ABIs or log decoding required.

## Features

- Track any number of collections, managed from a web UI (add / remove / pause / min-price filter)
- Covers OpenSea, Blur, LooksRare, X2Y2 and 0x Protocol
- Tweets include token image, price in ETH + USD, marketplace, buyer/seller and links
- Sweeps (multiple tokens bought in one transaction) are grouped into a single tweet
- SQLite storage — no external database needed
- Dedupe protection across restarts (never double-posts a sale)

## Requirements

- Node.js 20+
- A [Moralis](https://moralis.com) Web3 Data API key (free tier works; keep `POLL_INTERVAL_SECONDS` at 600 to stay within it)
- An [X Developer App](https://developer.twitter.com/) with **Read and Write** permissions, plus the access token & secret for the account that should post

## Setup

```sh
npm install
cp .env.example .env   # then fill in your keys
npm run build
npm start
```

Open `http://localhost:3000`, log in with your `ADMIN_PASSWORD`, and add collections by name + contract address. New collections start tracking from the current block (no backfill of old sales).

For development: `npm run dev` (auto-reloads). Set `DRY_RUN=true` in `.env` to log tweets to the console instead of posting.

## Deployment (VPS / Railway)

### Docker

```sh
docker build -t nft-sales-x-bot .
docker run -d --name sales-bot \
  --env-file .env \
  -p 3000:3000 \
  -v sales-bot-data:/app/data \
  --restart unless-stopped \
  nft-sales-x-bot
```

The SQLite database lives in `/app/data` — keep it on a volume so collections and dedupe state survive restarts.

### Railway

- Create a new project from this repo (the `Dockerfile` is picked up automatically)
- Add the variables from `.env.example` in the service settings
- Attach a volume mounted at `/app/data`

### Bare VPS (pm2)

```sh
npm install && npm run build
pm2 start dist/index.js --name sales-bot
pm2 save
```

## X API rate limits

All collections tweet from one X account. The X API **free tier allows ~500 posts/month (~17/day)** shared across all collections. If your collections trade more than that, either set per-collection min-price filters in the dashboard or upgrade to the Basic tier.

## License

MIT
