# NFT Sales Bot

A self-hosted bot that watches NFT sales and mints for **multiple Ethereum collections** across all major marketplaces and tweets each one from a single X account. Collections — and which marketplaces to watch and how often to poll — are managed through a password-protected web dashboard.

Built by [dinamic.eth](https://dinamic.eth.limo) · [@Pixel_Goblins](https://x.com/Pixel_Goblins) · [@goblinarinos](https://x.com/goblinarinos)

---

## Features

- Track any number of collections — add, pause, remove, set min-price filters from the dashboard
- **Choose which marketplaces to track** (OpenSea, Blur, LooksRare, X2Y2, 0x Protocol) live from the dashboard — fewer marketplaces means less Moralis quota per poll
- **Adjustable poll interval** from the dashboard (60–86400s), applied on the next cycle with no restart
- Tweets include token image (OpenSea card), price in ETH + USD, marketplace, buyer/seller
- **ENS reverse lookup** — buyer/seller addresses resolved to `.eth` names when available
- **Mints tracking** — toggle per collection from the dashboard
- Sweeps grouped into a single tweet
- Per-collection **phrase rotation** — custom phrases prepended to each tweet
- Liquid glass dashboard UI with video background
- SQLite storage — no external database needed
- Dedup protection across restarts — never double-posts

---

## Requirements

- Node.js 20+
- [Moralis](https://moralis.com) Web3 Data API key (free tier works — trim the marketplace list and raise the poll interval from the dashboard to stay within the free quota)
- [X Developer App](https://developer.twitter.com/) with **Read and Write** permissions + access token & secret

---

## Setup

```sh
npm install
cp .env.example .env   # fill in your keys
npm run build
npm start
```

Open `http://localhost:3000`, log in with your `ADMIN_PASSWORD`, and add collections by name + contract address.

For development: `npm run dev` (auto-reloads). Set `DRY_RUN=true` to log tweets to the console instead of posting.

### Dashboard

- **Collections** — add, pause, delete, set a per-collection min-price filter, toggle mint tracking, and define rotating phrases.
- **Bot settings** — tick the marketplaces to watch and set the poll interval. Both are stored in SQLite (in the `/app/data` volume), so they persist across restarts and image rebuilds; `POLL_INTERVAL_SECONDS` only seeds the initial value on first run, after which the dashboard owns it.
- **Mode** — a header toggle switches between dry-run (logged to console) and live (posted to X).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `MORALIS_API_KEY` | Yes | Web3 Data API key from moralis.com |
| `X_CONSUMER_KEY` | Yes | X app consumer key |
| `X_CONSUMER_SECRET` | Yes | X app consumer secret |
| `X_ACCESS_TOKEN` | Yes | X account access token |
| `X_ACCESS_SECRET` | Yes | X account access secret |
| `ADMIN_PASSWORD` | Yes | Dashboard login password |
| `POLL_INTERVAL_SECONDS` | No | Seeds the initial poll interval (default: 600); adjustable live from the dashboard afterwards |
| `DRY_RUN` | No | Log tweets instead of posting (default: false) |

---

## Deployment

### Docker Compose (recommended)

```yaml
services:
  nft-sales-bot:
    image: nft-sales-bot:latest
    build: .
    container_name: nft-sales-bot
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
```

```sh
docker compose up -d --build
```

### Docker

```sh
docker build -t nft-sales-bot .
docker run -d --name nft-sales-bot \
  --env-file .env \
  -p 3000:3000 \
  -v nft-sales-bot-data:/app/data \
  --restart unless-stopped \
  nft-sales-bot
```

The SQLite database lives in `/app/data` — mount a volume to persist collections, dashboard settings and dedup state across restarts.

### Railway

- Create a new project from this repo (Dockerfile is picked up automatically)
- Add variables from `.env.example` in the service settings
- Attach a volume mounted at `/app/data`

---

## X API rate limits

All collections tweet from one X account. The free tier allows ~500 posts/month (~17/day). If your collections trade heavily, set per-collection min-price filters in the dashboard or upgrade to the Basic tier.

---

## License

MIT
