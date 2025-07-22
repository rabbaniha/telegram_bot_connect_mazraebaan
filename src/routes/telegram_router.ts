// routes/telegram_router.ts
import { Router, Request, Response } from "express";
import telegramService from "../services/telegram_service";

const router = Router();

// Middleware to check for API Key for security
const apiKeyAuth = (req: Request, res: Response, next: Function) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey && apiKey === process.env.MAIN_SERVER_API_KEY) {
    next();
  } else {
    res.status(401).send("Unauthorized");
  }
};

// Initailize telegram and set webhook after running
router.get("/initialize", async (req: Request, res: Response) => {
  const porotocol = "https";
  const host = req.get("host");
  const webhookUrl = `${porotocol}://${host}/api/telegram/webhook`;

  if (telegramService.getIsConnected()) {
    res
      .status(200)
      .json({ success: true, message: "Already connected to Telegram" });
    return;
  }

  const isInitializing = await telegramService.initialize(webhookUrl);
  if (isInitializing) {
    console.log("Telegram Service Initialized");
    res.json({
      success: true,
      message: `Telegram Service Initialized in ${webhookUrl}`,
    });
    return;
  } else {
    res.status(500).json({
      success: false,
      message: "Failed to initialize Telegram Service",
    });
    return;
  }
});

// Route to get the connection status of the Telegram bot
// Your main server can periodically call this to check the service health.
router.get("/status", (req: Request, res: Response) => {
  res.json({ isConnected: telegramService.getIsConnected() });
});

// Route for the main server to send a message to be forwarded to Telegram
// This is the primary endpoint for your main server to use.
router.post(
  "/message-to-telegram",
  apiKeyAuth,
  async (req: Request, res: Response) => {
    try {
      const { chat, message } = req.body;
      if (!chat || !message) {
        return res
          .status(400)
          .send("Missing 'chat' or 'message' in request body");
      }

      const telegramMessageId = await telegramService.sendMessageToTelegram(
        chat,
        message
      );

      if (telegramMessageId) {
        res.status(200).json({ success: true, telegramMessageId });
      } else {
        res.status(500).json({
          success: false,
          error: "Failed to send message to Telegram",
        });
      }
    } catch (error) {
      console.error("API Error: /message-to-telegram", error);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

export default router;
