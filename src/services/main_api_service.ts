// services/main_api_service.ts
import axios, { AxiosInstance } from "axios";

class MainApiService {
  private apiClient: AxiosInstance;

  constructor() {
    if (!process.env.MAIN_SERVER_API_URL || !process.env.MAIN_SERVER_API_KEY) {
      console.error(
        "MAIN_SERVER_API_URL or MAIN_SERVER_API_KEY is not set. Communication with the main server is disabled."
      );
      // Create a dummy client to avoid crashes if used
      this.apiClient = axios.create({
          baseURL: 'http://localhost:9999', // Dummy URL
      });
      return;
    }
    
    this.apiClient = axios.create({
      baseURL: process.env.MAIN_SERVER_API_URL,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.MAIN_SERVER_API_KEY,
      },
      timeout: 15000,
    });
  }

  /**
   * Forwards a message or an event (like chat close, assign) from Telegram to the main server.
   * @param payload The data to send to the main server.
   */
  async forwardUpdateToMainServer(payload: { event: string; data: any }) {
    try {
      // The endpoint on your main server should be e.g., /api/telegram-updates
      const response = await this.apiClient.post("/telegram-updates", payload);
      console.log("Successfully forwarded update to main server.");
      return response.data;
    } catch (error: any) {
      console.error(
        "Failed to forward update to main server:",
        error.response?.data || error.message
      );
      throw error;
    }
  }
}

export default new MainApiService();