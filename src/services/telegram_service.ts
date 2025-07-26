// services/telegram_service.ts
import axios, { AxiosInstance } from "axios";
import mainApiService from "./main_api_service";

interface TelegramUpdate {
  update_id: number;
  message?: any;
  callback_query?: any;
}

// A simplified interface for what we expect from the main server
interface Chat {
  chatId: string;
  user: {
    name?: string;
    phoneNumber?: string;
    currentPage?: string;
  };
  tags?: string[];
  assignedAdminTelegramId?: string;
}

interface Message {
  content: {
    type: "text" | "image" | "file";
    text?: string;
    fileUrl?: string;
  };
  timestamp: Date;
}

class TelegramService {
  private apiClient: AxiosInstance | null = null;
  private groupId: string | null = null;
  private isConnected: boolean = false;
  private botToken: string | null = null;
  private baseUrl: string = "";
  private isInitializing: boolean = false;
  private webhookUrl: string | null = null;
  private quickReplies: string[] = [
    "سلام! چطور می‌تونم کمکتون کنم؟",
    "لطفاً کمی صبر کنید، در حال بررسی موضوع هستم.",
    "ممنون از تماستون، مشکل شما حل شد؟",
    "برای اطلاعات بیشتر با شماره پشتیبانی تماس بگیرید.",
  ];

  constructor() {
    this.apiClient = null;
  }

  async initialize(webhookUrl: string) {
    if (this.isInitializing) {
      console.log("Initialization already in progress...");
      return false;
    }
    this.isInitializing = true;

    try {
      await this.disconnect();

      this.botToken = process.env.TELEGRAM_BOT_TOKEN || null;
      this.groupId = process.env.TELEGRAM_CHAT_ID || null;
      this.webhookUrl = webhookUrl || null;
      if (!this.botToken || !this.groupId || !this.webhookUrl) {
        console.error(
          "Telegram environment variables (TOKEN, CHAT_ID, WEBHOOK_URL) are not set."
        );
        return false;
      }

      this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
      this.apiClient = axios.create({ timeout: 60000 });

      console.log("Testing bot connection...");
      const botInfo = await this.makeApiCall("getMe");
      if (!botInfo.ok) {
        throw new Error("Bot token is invalid: " + JSON.stringify(botInfo));
      }
      console.log(`Bot connected successfully! @${botInfo.result.username}`);

      console.log("Setting up webhook...");
      const webhookResponse = await this.makeApiCall("setWebhook", {
        url: this.webhookUrl,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      if (!webhookResponse.ok) {
        throw new Error(
          "Failed to set webhook: " + JSON.stringify(webhookResponse)
        );
      }

      console.log("Webhook set successfully!");
      this.isConnected = true;

      // --- NEW: Notify admin on successful connection ---
      await this.sendMessage(this.groupId, `✅ **سرویس ربات تلگرام با موفقیت متصل و فعال شد.**\n${new Date().toLocaleString('fa-IR')}`);

      return true;
    } catch (error: any) {
      console.error(
        "Failed to initialize Telegram bot:",
        error.message || error
      );
      this.isConnected = false;
      return false;
    } finally {
      this.isInitializing = false;
    }
  }

  async disconnect() {
    if (this.isConnected && this.apiClient && this.groupId) {
      try {
        // --- NEW: Notify admin on disconnect ---
        await this.sendMessage(this.groupId, `🔌 **سرویس ربات تلگرام در حال قطع اتصال...**`);

        console.log("Removing webhook...");
        await this.makeApiCall("deleteWebhook", { drop_pending_updates: true });
      } catch (error) {
        console.error("Error removing webhook:", error);
      }
    }
    this.isConnected = false;
    this.apiClient = null;
  }

  async handleUpdate(update: TelegramUpdate) {
    try {
      if (update.message) {
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      console.error("Error handling update:", error);
    }
  }

  // --- Message Handlers ---

  private async handleMessage(message: any) {
    const isReply = !!message.reply_to_message;
    const isCommand = message.text && message.text.startsWith("/");
    const chatId = isReply
      ? this.extractChatIdFromMessage(message.reply_to_message.text || "")
      : null;

    if (message.chat.id.toString() !== this.groupId) return;
    if (!chatId && isReply) return;

    try {
      if (isCommand) {
        await this.handleCommand(message);
      } else if (isReply && chatId) {
        await this.handleReplyMessage(message, chatId);
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  }

  private async handleReplyMessage(message: any, chatId: string) {
    try {
      const adminInfo = {
        name:
          message.from.first_name +
          (message.from.last_name ? ` ${message.from.last_name}` : ""),
        telegramId: message.from.id.toString(),
      };

      let content: any = {};
      if (message.text) {
        content = { type: "text", text: message.text };
      } else {
        const fileId =
          message.photo?.[message.photo.length - 1].file_id ||
          message.document?.file_id;
        const fileUrl = fileId ? await this.getFileUrl(fileId) : null;
        content = {
          type: message.photo ? "image" : "file",
          text: message.caption || "",
          fileName: message.document?.file_name || `image_${Date.now()}.jpg`,
          fileUrl: fileUrl,
        };
      }

      await mainApiService.forwardUpdateToMainServer({
        event: "admin_message",
        data: {
          chatId: chatId,
          message: {
            sender: "admin",
            senderInfo: adminInfo,
            content: content,
            timestamp: new Date(),
            // Kept from previous improvement
            telegramMessageId: message.message_id, 
          },
        },
      });
    } catch (error) {
      console.error("Error handling reply message:", error);
      await this.sendMessage(
        this.groupId!,
        `❌ خطا در ارسال پیام به سرور اصلی برای چت ${chatId}`
      );
    }
  }

  private async handleCommand(message: any) {
    const command = message.text.split(" ")[0].toLowerCase();
    switch (command) {
      case "/start":
      case "/status":
        await this.sendMessage(
          message.chat.id,
          this.isConnected ? "✅ سرویس ربات تلگرام فعال و متصل است." : "❌ سرویس ربات تلگرام قطع است."
        );
        break;
    }
  }

  private async handleCallbackQuery(callbackQuery: any) {
    try {
      const action = callbackQuery.data;
      const parts = action.split("_");
      const actionType = parts[0];
      const chatId = parts[1];

      if (!chatId) return;

      const adminInfo = {
        name:
          callbackQuery.from.first_name +
          (callbackQuery.from.last_name
            ? ` ${callbackQuery.from.last_name}`
            : ""),
        telegramId: callbackQuery.from.id.toString(),
      };

      if (actionType === "quickmsg") {
        const index = parseInt(parts[2], 10);
        const replyText = this.quickReplies[index];
        if (replyText) {
          await mainApiService.forwardUpdateToMainServer({
            event: "admin_message",
            data: {
              chatId: chatId,
              message: {
                sender: "admin",
                senderInfo: adminInfo,
                content: { type: "text", text: replyText },
                timestamp: new Date(),
              },
            },
          });
          await this.answerCallbackQuery(
            callbackQuery.id,
            "پیام آماده ارسال شد."
          );
        } else {
          await this.answerCallbackQuery(callbackQuery.id, "پیام یافت نشد.");
        }
        return;
      }
      
      let eventType = "";
      let answerText = "";

      switch (actionType) {
        case "close":
          eventType = "chat_close";
          answerText = "چت بسته شد.";
          break;
        case "assign":
          eventType = "chat_assign";
          answerText = "چت به شما اختصاص یافت.";
          break;
        // --- NEW: Handle "Replying..." button click ---
        case "replying":
          eventType = "admin_typing";
          answerText = "وضعیت 'در حال پاسخ' به کاربر ارسال شد.";
          break;
        default:
          return; // Unknown action
      }

      await this.answerCallbackQuery(callbackQuery.id, answerText);

      await mainApiService.forwardUpdateToMainServer({
        event: eventType,
        data: {
          chatId: chatId,
          admin: adminInfo,
          timestamp: new Date(),
        },
      });
    } catch (error) {
      console.error("Error handling callback query:", error);
    }
  }

  // --- Public Methods (called via API) ---

  async sendMessageToTelegram(chat: Chat, message: Message) {
    if (!this.isConnected || !this.groupId) return null;

    try {
      const messageText = this.formatMessageForTelegram(chat, message);

      // --- NEW: Updated inline keyboard with "Replying" button ---
      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: "👤 تخصیص به من", callback_data: `assign_${chat.chatId}` },
            { text: "📝 در حال پاسخ", callback_data: `replying_${chat.chatId}` },
            { text: "🔴 بستن چت", callback_data: `close_${chat.chatId}` },
          ],
        ],
      };

      let sentMessage;
      if (message.content.type === "text") {
        sentMessage = await this.sendMessage(
          this.groupId,
          messageText,
          inlineKeyboard
        );
      } else if (message.content.type === "image" && message.content.fileUrl) {
        sentMessage = await this.sendPhoto(
          this.groupId,
          message.content.fileUrl,
          messageText,
          inlineKeyboard
        );
      } else if (message.content.type === "file" && message.content.fileUrl) {
        sentMessage = await this.sendDocument(
          this.groupId,
          message.content.fileUrl,
          messageText,
          inlineKeyboard
        );
      }

      return sentMessage ? sentMessage.result.message_id : null;
    } catch (error) {
      console.error("Error sending message to Telegram:", error);
      return null;
    }
  }

  // --- Telegram API Wrappers (unchanged) ---

  private async makeApiCall(method: string, params: any = {}) {
    if (!this.apiClient || !this.botToken)
      throw new Error("API client not initialized");
    try {
      const url = `${this.baseUrl}/${method}`;
      const response = await this.apiClient.post(url, params);
      return response.data;
    } catch (error: any) {
      console.error(
        `Telegram API call failed for ${method}:`,
        error.response?.data || error.message
      );
      throw error;
    }
  }

  private async sendMessage(chatId: string, text: string, replyMarkup?: any) {
    return this.makeApiCall("sendMessage", {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      ...(replyMarkup && { reply_markup: JSON.stringify(replyMarkup) }),
    });
  }
  
  // sendPhoto, sendDocument, answerCallbackQuery methods remain the same...

  private async sendPhoto(
    chatId: string,
    photo: string,
    caption?: string,
    replyMarkup?: any
  ) {
    return this.makeApiCall("sendPhoto", {
      chat_id: chatId,
      photo: photo,
      parse_mode: "HTML",
      ...(caption && { caption }),
      ...(replyMarkup && { reply_markup: JSON.stringify(replyMarkup) }),
    });
  }

  private async sendDocument(
    chatId: string,
    document: string,
    caption?: string,
    replyMarkup?: any
  ) {
    return this.makeApiCall("sendDocument", {
      chat_id: chatId,
      document: document,
      parse_mode: "HTML",
      ...(caption && { caption }),
      ...(replyMarkup && { reply_markup: JSON.stringify(replyMarkup) }),
    });
  }

  private async answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.makeApiCall("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text && { text }),
    });
  }
  
  // --- Utility Methods (unchanged) ---

  private formatMessageForTelegram(chat: Chat, message: Message): string {
    const userInfo =
      chat.user.name +
      (chat.user.phoneNumber ? ` (${chat.user.phoneNumber})` : "");
    const timestamp = new Date(message.timestamp).toLocaleString("fa-IR");

    let text = `💬 <b>پیام جدید از ${userInfo}</b>\n`;
    text += `<code>🆔 Chat ID: ${chat.chatId}</code>\n`;
    text += `⏰ ${timestamp}\n`;
    if (chat.user.currentPage) {
      text += `📍 صفحه: ${chat.user.currentPage}\n`;
    }
    if (chat.tags && chat.tags.length > 0) {
      text += `🏷️ تگ‌ها: ${chat.tags.join(", ")}\n`;
    }
    text += `\n📝 <b>پیام:</b>\n${message.content.text || "(فایل)"}`;
    return text;
  }

  private extractChatIdFromMessage(text: string): string | null {
    const match = text.match(/🆔 Chat ID: ([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  }

  private async getFileUrl(fileId: string): Promise<string | null> {
    try {
      const response = await this.makeApiCall("getFile", { file_id: fileId });
      return response.ok
        ? `https://api.telegram.org/file/bot${this.botToken}/${response.result.file_path}`
        : null;
    } catch (error) {
      console.error("Error getting file URL:", error);
      return null;
    }
  }

  public getIsConnected(): boolean {
    return this.isConnected;
  }
}

export default new TelegramService();