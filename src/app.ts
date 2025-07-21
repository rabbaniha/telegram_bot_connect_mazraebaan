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
const PORT = process.env.PORT || 3002;

// --- Middlewares ---
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan("combined"));

// --- API Routes ---
// Routes for communication with the main server
app.use("/api", telegramRouter);

// --- Telegram Webhook ---
// The endpoint that Telegram will send updates to
app.post("/api/telegram-webhook", async (req, res) => {
  try {
    await telegramService.handleUpdate(req.body);
    res.status(200).send("Update processed");
  } catch (error) {
    console.error("Failed to process webhook update:", error);
    res.status(500).send("Error processing update");
  }
});

app.listen(PORT, async () => {
  console.log(`App run on port ${PORT}`);
  // Initialize Telegram Service on startup
  await telegramService.initialize();
});