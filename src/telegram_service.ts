// services/telegramService.ts
import axios, { AxiosInstance } from "axios";
import { Chat, ChatSettings, Message } from "../models/chat";
import socketService from "./socket_service";

interface TelegramUpdate {
  update_id: number;
  message?: any;
  callback_query?: any;
}

class TelegramService {
  private apiClient: AxiosInstance | null;
  private groupId: string | null;
  private isConnected: boolean;
  private botToken: string | null;
  private agent: any;
  private baseUrl: string;
  private isInitializing: boolean;
  private webhookUrl: string | null;
  private quickReplies: string[] = [
    "سلام! چطور می‌تونم کمکتون کنم؟",
    "لطفاً کمی صبر کنید، در حال بررسی موضوع هستم.",
    "ممنون از تماستون، مشکل شما حل شد؟",
    "برای اطلاعات بیشتر با شماره پشتیبانی تماس بگیرید.",
  ];

  constructor() {
    this.apiClient = null;
    this.groupId = null;
    this.isConnected = false;
    this.botToken = null;
    this.agent = null;
    this.baseUrl = "";
    this.isInitializing = false;
    this.webhookUrl = null;
  }

  async initialize() {
    // Prevent multiple initializations
    if (this.isInitializing) {
      console.log("Initialization already in progress...");
      return false;
    }

    this.isInitializing = true;

    try {
      await this.disconnect();

      if (process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_BOT_TOKEN) {
        this.botToken = process.env.TELEGRAM_BOT_TOKEN;
        this.groupId = process.env.TELEGRAM_CHAT_ID;
        this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
      } else {
        console.error("Telegram bot token and group id not found");
      }

      // Get webhook URL from environment
      this.webhookUrl = process.env.TELEGRAM_WEBHOOK_URL || null;
      if (!this.webhookUrl) {
        console.error("TELEGRAM_WEBHOOK_URL environment variable is not set");
        return false;
      }

      // Create axios instance
      this.apiClient = axios.create({
        timeout: 60000,
        ...(this.agent && {
          httpsAgent: this.agent,
          httpAgent: this.agent,
        }),
      });

      // Test bot connection
      console.log("Testing bot connection...");
      const botInfo = await this.makeApiCall("getMe");

      if (!botInfo.ok) {
        throw new Error("Bot token is invalid: " + JSON.stringify(botInfo));
      }

      console.log(`Bot connected successfully! @${botInfo.result.username}`);

      // Set webhook
      console.log("Setting up webhook...");
      const webhookResponse = await this.makeApiCall("setWebhook", {
        url: this.webhookUrl,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
        max_connections: 100,
      });

      if (!webhookResponse.ok) {
        throw new Error(
          "Failed to set webhook: " + JSON.stringify(webhookResponse)
        );
      }

      console.log("Webhook set successfully!");
      this.isConnected = true;
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
    console.log("Disconnecting Telegram service...");

    if (this.isConnected && this.apiClient) {
      try {
        console.log("Removing webhook...");
        await this.makeApiCall("deleteWebhook", {
          drop_pending_updates: true,
        });
      } catch (error) {
        console.error("Error removing webhook on disconnect:", error);
      }
    }

    this.isConnected = false;
    this.apiClient = null;
    console.log("Telegram service disconnected.");
  }

  // Make handleUpdate public so it can be called from webhook
  async handleUpdate(update: TelegramUpdate) {
    try {
      if (update.message) {
        // Check if this is a PV message from an assigned admin
        if (update.message.chat.type === "private") {
          // Find chat where assignedAdminTelegramId matches sender
          const chat = await Chat.findOne({
            assignedAdminTelegramId: update.message.from.id.toString(),
            status: "active",
          });
          if (chat) {
            // Send admin's message to user
            const newMessage = {
              sender: "admin",
              senderInfo: {
                name:
                  update.message.from.first_name +
                  (update.message.from.last_name
                    ? " " + update.message.from.last_name
                    : ""),
                avatar: null,
              },
              content: {
                type: "text",
                text: update.message.text,
              },
              timestamp: new Date(),
              telegramMessageId: update.message.message_id,
            };
            const messageDoc = new Message(newMessage);
            chat.messages.push(messageDoc);
            chat.metadata.lastActivity = new Date();
            chat.metadata.totalMessages += 1;
            await chat.save();
            socketService.sendMessageToUser(chat.chatId, newMessage);
            await this.sendMessage(
              this.groupId!,
              `پیام ادمین ${chat.assignedAdminName} به کاربر ارسال شد.\n🆔 Chat ID: ${chat.chatId}`
            );
            return;
          }
        }
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      console.error("Error handling update:", error);
      throw error; // Re-throw to be handled by the webhook endpoint
    }
  }

  private async makeApiCall(method: string, params: any = {}) {
    if (!this.apiClient || !this.botToken) {
      throw new Error("API client not initialized");
    }

    try {
      const url = `${this.baseUrl}/${method}`;
      const response = await this.apiClient.post(url, params, {
        timeout: method === "getUpdates" ? 35000 : 60000, // Different timeout for getUpdates
      });
      return response.data;
    } catch (error: any) {
      // Don't log errors for expected conflict resolution attempts
      if (!(method === "getUpdates" && error.response?.status === 409)) {
        console.error(
          `Telegram API call failed for ${method}:`,
          error.response?.data || error.message
        );
      }
      throw error;
    }
  }

  private async handleMessage(message: any) {
    // Only process messages from the configured group
    if (message.chat.id.toString() !== this.groupId) return;

    try {
      // Handle commands
      if (message.text && message.text.startsWith("/")) {
        await this.handleCommand(message);
        return;
      }

      // Handle reply messages
      if (message.reply_to_message) {
        await this.handleReplyMessage(message);
        return;
      }

      // Route user messages to assigned admin's PV if assigned
      const chatId = this.extractChatIdFromMessage(message.text || "");
      if (chatId) {
        const chat = await Chat.findOne({ chatId });
        if (chat && chat.assignedAdminTelegramId) {
          // Forward message to admin's PV
          let forwardText = `پیام جدید از کاربر ${
            chat.user?.name || ""
          }\n🆔 Chat ID: ${chatId}\n`;
          forwardText += `📝 پیام:
${message.text}`;
          await this.sendMessage(chat.assignedAdminTelegramId, forwardText);
        }
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  }

  private async handleCommand(message: any) {
    const command = message.text.split(" ")[0].toLowerCase();

    switch (command) {
      case "/start":
        await this.sendMessage(message.chat.id, "ربات چت آنلاین فعال است!");
        break;

      case "/stats":
        try {
          const stats = await this.getChatStats();
          const statsText =
            `📊 آمار چت:\n\n` +
            `🟢 چت‌های فعال: ${stats.active}\n` +
            `⏳ در انتظار: ${stats.waiting}\n` +
            `🔴 بسته شده: ${stats.closed}\n` +
            `📈 کل امروز: ${stats.today}`;

          await this.sendMessage(message.chat.id, statsText);
        } catch (error) {
          console.error("Error getting stats:", error);
        }
        break;

      case "/close":
        if (!message.reply_to_message) {
          await this.sendMessage(
            message.chat.id,
            "لطفاً روی پیام چتی که می‌خواهید ببندید reply کنید"
          );
          return;
        }

        try {
          const chatId = this.extractChatIdFromMessage(
            message.reply_to_message.text || ""
          );
          if (chatId) {
            await this.closeChat(chatId);
            await this.sendMessage(message.chat.id, "✅ چت بسته شد");
          }
        } catch (error) {
          console.error("Error closing chat:", error);
        }
        break;
    }
  }

  private async handleCallbackQuery(callbackQuery: any) {
    try {
      const action = callbackQuery.data;
      const chatId = action?.split("_")[1];

      if (!chatId) return;

      // Step 1: Quick Reply logic
      if (action.startsWith("quickmsg_")) {
        // action: quickmsg_{chatId}_{index}
        const parts = action.split("_");
        const chatId = parts[1];
        const index = parseInt(parts[2], 10);
        const replyText = this.quickReplies[index];
        if (!replyText) {
          await this.answerCallbackQuery(
            callbackQuery.id,
            "پیام آماده یافت نشد"
          );
          return;
        }
        // Send quick reply to user
        const chat = await Chat.findOne({ chatId });
        if (!chat) {
          await this.answerCallbackQuery(callbackQuery.id, "چت یافت نشد");
          return;
        }
        // ساخت پیام جدید برای کاربر
        const newMessage = {
          sender: "admin",
          senderInfo: {
            name:
              callbackQuery.from.first_name +
              (callbackQuery.from.last_name
                ? " " + callbackQuery.from.last_name
                : ""),
            avatar: null,
          },
          content: {
            type: "text",
            text: replyText,
          },
          timestamp: new Date(),
          telegramMessageId: callbackQuery.message?.message_id,
        };
        const messageDoc = new Message(newMessage);
        chat.messages.push(messageDoc);
        chat.metadata.lastActivity = new Date();
        chat.metadata.totalMessages += 1;
        await chat.save();
        socketService.sendMessageToUser(chatId, newMessage);
        await this.answerCallbackQuery(callbackQuery.id, "پیام ارسال شد");
        // After sending quick reply, remove quick reply buttons from original message
        if (callbackQuery.message && callbackQuery.message.message_id) {
          const newInlineKeyboard = [
            [{ text: "🏷️ تگ", callback_data: `tag_${chatId}` }],
            [
              { text: "👤 تخصیص", callback_data: `assign_${chatId}` },
              { text: "🔴 بستن", callback_data: `close_${chatId}` },
            ],
          ];
          await this.makeApiCall("editMessageReplyMarkup", {
            chat_id: callbackQuery.message.chat.id,
            message_id: callbackQuery.message.message_id,
            reply_markup: JSON.stringify({
              inline_keyboard: newInlineKeyboard,
            }),
          });
          // Also update the message text to show sent message
          await this.makeApiCall("editMessageText", {
            chat_id: callbackQuery.message.chat.id,
            message_id: callbackQuery.message.message_id,
            text: `پیام ارسال شد:\n${replyText}`,
            parse_mode: "HTML",
            reply_markup: JSON.stringify({
              inline_keyboard: newInlineKeyboard,
            }),
          });
        }
        return;
      } else if (action.startsWith("quick_")) {
        // Show quick replies as inline keyboard
        const chatId = action.split("_")[1];
        const keyboard = this.quickReplies.map((reply, idx) => [
          {
            text: reply.length > 32 ? reply.slice(0, 32) + "..." : reply,
            callback_data: `quickmsg_${chatId}_${idx}`,
          },
        ]);
        await this.sendMessage(
          callbackQuery.message.chat.id,
          "یک پیام آماده را انتخاب کنید:",
          {
            inline_keyboard: keyboard,
          }
        );
        await this.answerCallbackQuery(callbackQuery.id);
        return;
      }
      switch (action?.split("_")[0]) {
        case "close":
          await this.closeChat(chatId);
          await this.answerCallbackQuery(callbackQuery.id, "چت بسته شد");
          // Remove all inline buttons from the original message
          if (callbackQuery.message && callbackQuery.message.message_id) {
            await this.makeApiCall("editMessageReplyMarkup", {
              chat_id: callbackQuery.message.chat.id,
              message_id: callbackQuery.message.message_id,
              reply_markup: JSON.stringify({ inline_keyboard: [] }),
            });
          }
          // Send close info to group
          const chat = await Chat.findOne({ chatId });
          if (chat) {
            const userName = chat.user?.name || "-";
            const closeDate = new Date().toLocaleString("fa-IR");
            const adminName =
              callbackQuery.from.first_name +
              (callbackQuery.from.last_name
                ? " " + callbackQuery.from.last_name
                : "");
            const closeText = `🔴 چت بسته شد\n🆔 Chat ID: ${chatId}\n👤 کاربر: ${userName}\n⏰ تاریخ: ${closeDate}\n👮‍♂️ ادمین: ${adminName}`;
            await this.sendMessage(callbackQuery.message.chat.id, closeText);
          }
          break;
        case "tag":
          await this.answerCallbackQuery(
            callbackQuery.id,
            "برای تگ‌گذاری از دستور /tag استفاده کنید"
          );
          break;
        case "assign": {
          // Assign chat to this admin
          const adminTelegramId = callbackQuery.from.id.toString();
          const adminName =
            callbackQuery.from.first_name +
            (callbackQuery.from.last_name
              ? " " + callbackQuery.from.last_name
              : "");
          const chat = await Chat.findOne({ chatId });
          if (chat) {
            chat.assignedAdminTelegramId = adminTelegramId;
            chat.assignedAdminName = adminName;
            await chat.save();
            // Remove all inline buttons from the original message
            if (callbackQuery.message && callbackQuery.message.message_id) {
              await this.makeApiCall("editMessageReplyMarkup", {
                chat_id: callbackQuery.message.chat.id,
                message_id: callbackQuery.message.message_id,
                reply_markup: JSON.stringify({ inline_keyboard: [] }),
              });
            }
            // Send assignment info to group
            const userName = chat.user?.name || "-";
            const assignDate = new Date().toLocaleString("fa-IR");
            const assignText = `<b>👤 چت به ادمین اختصاص یافت</b>\n<code>🆔 Chat ID: ${chatId}</code>\n<code>👤 کاربر: ${userName}</code>\n<code>⏰ تاریخ: ${assignDate}</code>\n<code>👮‍♂️ ادمین: ${adminName}</code>`;
            await this.sendMessage(callbackQuery.message.chat.id, assignText);
            // Send system message to user
            socketService.sendMessageToUser(chatId, {
              type: "system",
              message: `چت شما به ادمین ${adminName} اختصاص یافت.`,
              timestamp: new Date(),
            });
          }
          await this.answerCallbackQuery(
            callbackQuery.id,
            "چت به شما اختصاص یافت"
          );
          break;
        }
      }
    } catch (error) {
      console.error("Error handling callback query:", error);
    }
  }

  private async handleReplyMessage(message: any) {
    try {
      const replyText = message.reply_to_message?.text || "";
      const chatId = this.extractChatIdFromMessage(replyText);

      if (!chatId) return;

      const chat = await Chat.findOne({ chatId });
      if (!chat) return;

      // Determine message content type
      let messageContent: any = {};

      if (message.text) {
        messageContent = {
          type: "text",
          text: message.text,
        };
      } else if (message.photo) {
        const photo = message.photo[message.photo.length - 1];
        const fileUrl = await this.getFileUrl(photo.file_id);
        messageContent = {
          type: "image",
          text: message.caption || "",
          fileUrl: fileUrl,
          fileName: `image_${Date.now()}.jpg`,
        };
      } else if (message.document) {
        const fileUrl = await this.getFileUrl(message.document.file_id);
        messageContent = {
          type: "file",
          text: message.caption || "",
          fileUrl: fileUrl,
          fileName: message.document.file_name,
          fileSize: message.document.file_size,
        };
      }

      // Save message to database
      const newMessage = {
        sender: "admin",
        senderInfo: {
          name:
            message.from.first_name +
            (message.from.last_name ? " " + message.from.last_name : ""),
          avatar: null,
        },
        content: messageContent,
        timestamp: new Date(),
        telegramMessageId: message.message_id,
      };

      const messageDoc = new Message(newMessage);
      chat.messages.push(messageDoc);
      chat.metadata.lastActivity = new Date();
      chat.metadata.totalMessages += 1;

      await chat.save();

      // Send message to user via Socket
      socketService.sendMessageToUser(chatId, newMessage);

      console.log(`Message sent to user ${chatId} successfully`);
    } catch (error) {
      console.error("Error handling reply message:", error);
      await this.sendMessage(this.groupId!, "❌ خطا در ارسال پیام");
    }
  }

  async sendMessageToTelegram(chat: any, message: any) {
    console.log("message in sendMessageToTelegram: ", message);
    if (!this.isConnected || !this.groupId) return null;
    console.log("this.groupId in sendMessageToTelegram: ", this.groupId);

    try {
      let messageText = this.formatMessageForTelegram(chat, message);
      let sentMessage = null;

      let inlineKeyboard;
      if (chat.assignedAdminTelegramId) {
        // If already assigned, do not show assign button
        inlineKeyboard = {
          inline_keyboard: [
            [
              { text: "✅ پاسخ سریع", callback_data: `quick_${chat.chatId}` },
              { text: "🏷️ تگ", callback_data: `tag_${chat.chatId}` },
            ],
            [{ text: "🔴 بستن", callback_data: `close_${chat.chatId}` }],
          ],
        };
      } else {
        inlineKeyboard = {
          inline_keyboard: [
            [
              { text: "✅ پاسخ سریع", callback_data: `quick_${chat.chatId}` },
              { text: "🏷️ تگ", callback_data: `tag_${chat.chatId}` },
            ],
            [
              { text: "👤 تخصیص", callback_data: `assign_${chat.chatId}` },
              { text: "🔴 بستن", callback_data: `close_${chat.chatId}` },
            ],
          ],
        };
      }

      if (message.content.type === "text") {
        sentMessage = await this.sendMessage(
          this.groupId,
          messageText,
          inlineKeyboard
        );
      } else if (message.content.type === "image") {
        sentMessage = await this.sendPhoto(
          this.groupId,
          message.content.fileUrl,
          messageText,
          inlineKeyboard
        );
      } else if (message.content.type === "file") {
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

  private async sendMessage(chatId: string, text: string, replyMarkup?: any) {
    const params: any = {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
    };

    if (replyMarkup) {
      params.reply_markup = JSON.stringify(replyMarkup);
    }

    return await this.makeApiCall("sendMessage", params);
  }

  private async sendPhoto(
    chatId: string,
    photo: string,
    caption?: string,
    replyMarkup?: any
  ) {
    const params: any = {
      chat_id: chatId,
      photo: photo,
    };

    if (caption) params.caption = caption;
    if (replyMarkup) params.reply_markup = JSON.stringify(replyMarkup);

    return await this.makeApiCall("sendPhoto", params);
  }

  private async sendDocument(
    chatId: string,
    document: string,
    caption?: string,
    replyMarkup?: any
  ) {
    const params: any = {
      chat_id: chatId,
      document: document,
    };

    if (caption) params.caption = caption;
    if (replyMarkup) params.reply_markup = JSON.stringify(replyMarkup);

    return await this.makeApiCall("sendDocument", params);
  }

  private async answerCallbackQuery(callbackQueryId: string, text?: string) {
    const params: any = {
      callback_query_id: callbackQueryId,
    };

    if (text) params.text = text;

    return await this.makeApiCall("answerCallbackQuery", params);
  }

  formatMessageForTelegram(chat: any, message: any) {
    console.log("chat in formatMessageForTelegram: ", chat);
    const userInfo =
      chat.user.name +
      (chat.user.phoneNumber ? ` (${chat.user.phoneNumber})` : "");
    const timestamp = new Date(message.timestamp).toLocaleString("fa-IR");

    let text = `💬 پیام جدید از ${userInfo}\n`;
    text += `🆔 Chat ID: ${chat.chatId}\n`;
    text += `⏰ ${timestamp}\n`;
    text += `📍 صفحه: ${chat.user.currentPage || "نامشخص"}\n`;

    if (chat.tags && chat.tags.length > 0) {
      text += `🏷️ تگ‌ها: ${chat.tags.join(", ")}\n`;
    }

    text += `\n📝 پیام:\n${message.content.text}`;

    return text;
  }

  extractChatIdFromMessage(text: string) {
    const match = text.match(/🆔 Chat ID: ([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  }

  async getFileUrl(fileId: string) {
    try {
      const response = await this.makeApiCall("getFile", { file_id: fileId });
      if (response.ok) {
        return `https://api.telegram.org/file/bot${this.botToken}/${response.result.file_path}`;
      }
      return null;
    } catch (error) {
      console.error("Error getting file URL:", error);
      return null;
    }
  }

  async getChatStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [active, waiting, closed, todayChats] = await Promise.all([
      Chat.countDocuments({ status: "active" }),
      Chat.countDocuments({ status: "waiting" }),
      Chat.countDocuments({ status: "closed" }),
      Chat.countDocuments({ createdAt: { $gte: today } }),
    ]);

    return { active, waiting, closed, today: todayChats };
  }

  async closeChat(chatId: string) {
    const chat = await Chat.findOne({ chatId });
    if (chat) {
      chat.status = "closed";
      await chat.save();

      socketService.sendMessageToUser(chatId, {
        type: "system",
        message: "چت توسط ادمین بسته شد",
        timestamp: new Date(),
      });
    }
  }

  async updateSettings(botToken: string, groupId: string) {
    let settings = await ChatSettings.findOne();
    if (!settings) {
      settings = new ChatSettings();
    }

    settings.telegramBotToken = botToken;
    settings.telegramGroupId = groupId;
    await settings.save();
    console.log("Telegram settings saved to DB.");

    console.log(
      "Triggering re-initialization of Telegram service due to settings update..."
    );
    return await this.initialize();
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }
}

export default new TelegramService();
