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

router.post("/webhook", async (req: Request, res: Response) => {
    await telegramService.handleUpdate(req.body);
    res.status(200).send("OK"); // Always send a 200 OK to Telegram quickly
});

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
