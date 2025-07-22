// app.ts
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import telegramRouter from "./routes/telegram_router";
import telegramService from "./services/telegram_service";

dotenv.config();

const app = express();

// --- Middlewares ---
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan("combined"));

// --- API Routes ---
app.use("/api", telegramRouter);

// --- Telegram Webhook ---
app.post("/api/telegram-webhook", async (req, res) => {
  try {
    await telegramService.handleUpdate(req.body);
    res.status(200).send("Update processed");
  } catch (error) {
    console.error("Failed to process webhook update:", error);
    res.status(500).send("Error processing update");
  }
});

app.get("/", (req, res) => {
  res.send("Telegram Service API is running.");
});

// Export app for Vercel
export default app;
