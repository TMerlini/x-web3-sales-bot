import dotenv from "dotenv";
dotenv.config();

import { startPoller } from "./poller";
import { startServer } from "./server";

const REQUIRED_ENV = [
  "ALCHEMY_API_KEY",
  "X_CONSUMER_KEY",
  "X_CONSUMER_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_SECRET",
  "ADMIN_PASSWORD",
];

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  console.error("Copy .env.example to .env and fill in your keys.");
  process.exit(1);
}

startServer();
startPoller();
