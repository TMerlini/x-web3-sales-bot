import crypto from "crypto";
import express from "express";
import path from "path";
import { getCurrentBlock } from "./moralis";
import {
  addCollection,
  deleteCollection,
  isDryRun,
  listCollections,
  setDryRun,
  updateCollection,
} from "./db";

const SESSION_COOKIE = "sid";
const sessions = new Set<string>();

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function isAuthed(req: express.Request): boolean {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return !!sid && sessions.has(sid);
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function startServer(): void {
  const app = express();
  app.use(express.json());

  // --- Auth ---

  app.post("/api/login", (req, res) => {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) {
      res.status(500).json({ error: "ADMIN_PASSWORD is not configured" });
      return;
    }
    const given = String(req.body?.password ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(password);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ error: "Wrong password" });
      return;
    }
    const sid = crypto.randomBytes(32).toString("hex");
    sessions.add(sid);
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`
    );
    res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) sessions.delete(sid);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get("/api/session", (req, res) => {
    res.json({ authed: isAuthed(req) });
  });

  // All other /api routes require auth
  app.use("/api", (req, res, next) => {
    if (!isAuthed(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  // --- Settings ---

  app.get("/api/settings", (_req, res) => {
    res.json({ dryRun: isDryRun() });
  });

  app.patch("/api/settings", (req, res) => {
    if (req.body?.dryRun === undefined) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    setDryRun(!!req.body.dryRun);
    console.log(`Mode switched to ${isDryRun() ? "DRY RUN" : "LIVE"} via dashboard`);
    res.json({ dryRun: isDryRun() });
  });

  // --- Collections CRUD ---

  app.get("/api/collections", (_req, res) => {
    res.json(listCollections());
  });

  app.post("/api/collections", async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    const contractAddress = String(req.body?.contractAddress ?? "").trim();
    const minPriceEth = Number(req.body?.minPriceEth ?? 0);

    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }
    if (!ADDRESS_RE.test(contractAddress)) {
      res.status(400).json({ error: "Invalid contract address" });
      return;
    }
    if (!Number.isFinite(minPriceEth) || minPriceEth < 0) {
      res.status(400).json({ error: "Invalid min price" });
      return;
    }

    try {
      // Start tracking from the current block (no backfill of old sales)
      const currentBlock = await getCurrentBlock();
      const collection = addCollection(name, contractAddress, minPriceEth, currentBlock);
      res.status(201).json(collection);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint failed")) {
        res.status(409).json({ error: "This contract is already being tracked" });
      } else {
        console.error("Failed to add collection:", err);
        res.status(500).json({ error: "Failed to add collection" });
      }
    }
  });

  app.patch("/api/collections/:id", (req, res) => {
    const id = Number(req.params.id);
    const fields: {
      name?: string;
      min_price_eth?: number;
      paused?: number;
      phrases?: string;
      track_mints?: number;
    } = {};

    if (req.body?.phrases !== undefined) {
      const phrases = req.body.phrases;
      if (!Array.isArray(phrases) || phrases.some((p: unknown) => typeof p !== "string")) {
        res.status(400).json({ error: "Phrases must be an array of strings" });
        return;
      }
      const cleaned = (phrases as string[])
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 100);
      if (cleaned.some((p) => p.length > 200)) {
        res.status(400).json({ error: "Each phrase must be 200 characters or less" });
        return;
      }
      fields.phrases = JSON.stringify(cleaned);
    }

    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) {
        res.status(400).json({ error: "Name cannot be empty" });
        return;
      }
      fields.name = name;
    }
    if (req.body?.minPriceEth !== undefined) {
      const minPriceEth = Number(req.body.minPriceEth);
      if (!Number.isFinite(minPriceEth) || minPriceEth < 0) {
        res.status(400).json({ error: "Invalid min price" });
        return;
      }
      fields.min_price_eth = minPriceEth;
    }
    if (req.body?.paused !== undefined) {
      fields.paused = req.body.paused ? 1 : 0;
    }
    if (req.body?.trackMints !== undefined) {
      fields.track_mints = req.body.trackMints ? 1 : 0;
    }

    const updated = updateCollection(id, fields);
    if (!updated) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }
    res.json(updated);
  });

  app.delete("/api/collections/:id", (req, res) => {
    deleteCollection(Number(req.params.id));
    res.json({ ok: true });
  });

  // --- Static dashboard ---
  app.use(express.static(path.join(__dirname, "..", "public")));

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`);
  });
}
