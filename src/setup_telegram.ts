import axios from 'axios';
import 'dotenv/config'; // for reading .env file

const setup = async () => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    // This should be your production URL from Vercel
    const webhookUrl = process.env.VERCEL_URL + '/api/telegram/webhook'; 

    if (!botToken) {
        console.error("TELEGRAM_BOT_TOKEN is not set in .env file.");
        return;
    }
    if (!process.env.VERCEL_URL) {
        console.error("VERCEL_URL is not set in .env file. Please add your deployment URL.");
        return;
    }

    const telegramApiUrl = `https://api.telegram.org/bot${botToken}/setWebhook`;

    try {
        console.log(`Setting webhook to: ${webhookUrl}`);
        const response = await axios.post(telegramApiUrl, {
            url: webhookUrl,
            allowed_updates: ["message", "callback_query"],
            drop_pending_updates: true,
        });

        if (response.data.ok) {
            console.log("✅ Webhook set successfully!", response.data.description);
        } else {
            console.error("❌ Failed to set webhook:", response.data.description);
        }
    } catch (error: any) {
        console.error("❌ Error setting webhook:", error.response?.data || error.message);
    }
};

setup();