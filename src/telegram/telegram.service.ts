import { Injectable, Logger } from '@nestjs/common';
import * as TelegramBot from 'node-telegram-bot-api';
import { OpenaiService } from '../openai/openai.service';
import { StabilityaiService } from '../stabilityai/stabilityai.service';
import { AudioService } from '../audio/audio.service';
import { UserContextService } from '../user-context/user-context.service';

@Injectable()
export class TelegramService {
  private bot: TelegramBot;
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly openaiService: OpenaiService,
    private readonly stabilityaiService: StabilityaiService,
    private readonly audioService: AudioService,
    private readonly userContextService: UserContextService,
  ) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not defined');
    }

    this.bot = new TelegramBot(token);

    if (process.env.NODE_ENV === 'production') {
      this.setupWebhook();
    } else {
      this.bot = new TelegramBot(token, { polling: true });
      this.setupHandlers();
    }
  }

  private async setupWebhook() {
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    if (webhookUrl) {
      await this.bot.setWebHook(webhookUrl);
      this.logger.log(`Webhook set to: ${webhookUrl}`);
    }
  }

  private setupHandlers() {
    this.bot.onText(/\/start/, (msg) => {
      this.handleStartCommand(msg);
    });

    this.bot.on('message', (msg) => {
      if (msg.text && !msg.text.startsWith('/')) {
        this.handleTextMessage(msg);
      }
    });

    this.bot.on('voice', (msg) => {
      this.handleVoiceMessage(msg);
    });

    this.bot.on('callback_query', (query) => {
      this.handleCallbackQuery(query);
    });
  }

  async processWebhookUpdate(update: any) {
    try {
      if (update.message) {
        const msg = update.message;

        if (msg.text?.startsWith('/start')) {
          await this.handleStartCommand(msg);
        } else if (msg.text && !msg.text.startsWith('/')) {
          await this.handleTextMessage(msg);
        } else if (msg.voice) {
          await this.handleVoiceMessage(msg);
        }
      } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      this.logger.error('Error processing webhook update:', error);
    }
  }

  private async handleStartCommand(msg: any) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    await this.userContextService.saveToContext(
      'User started conversation with GraeCare via Telegram',
      'assistant',
      userId
    );

    const welcomeMessage = `
🛍️ *Welcome to GraeCare!*

Hi ${msg.from.first_name || 'there'}! I'm your digital assistant for all things GraeCare.

How can I help you today?
    `;

    const options = {
      parse_mode: 'Markdown' as const,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🛒 View Products', callback_data: 'view_products' },
            { text: '📦 Track My Order', callback_data: 'track_order' }
          ],
          [
            { text: '📍 Pickup Locations', callback_data: 'pickup_locations' },
            { text: '💬 FAQs', callback_data: 'faqs' }
          ],
          [
            { text: '👤 Talk to Support', callback_data: 'talk_to_human' }
          ]
        ]
      }
    };

    await this.bot.sendMessage(chatId, welcomeMessage, options);
  }

  private async handleTextMessage(msg: any) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    if (text.toLowerCase().includes('/imagine')) {
      await this.handleImageGeneration(chatId, userId, text);
      return;
    }

    await this.bot.sendChatAction(chatId, 'typing');

    const aiResponse = await this.openaiService.generateAIResponse(userId, text);

    await this.bot.sendMessage(chatId, aiResponse, {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id
    });
  }

  private async handleImageGeneration(chatId: number, userId: string, text: string) {
    const prompt = text.replace(/\/imagine/gi, '').trim();

    if (!prompt) {
      await this.bot.sendMessage(chatId, '🖼️ Please describe the image you want to generate.\n\nExample: `/imagine herbal tea packaging design`');
      return;
    }

    const loadingMsg = await this.bot.sendMessage(chatId, '🖼️ Generating your image...');

    try {
      const response = await this.stabilityaiService.textToImage(prompt);

      if (Array.isArray(response) && response.length > 0) {
        const imageUrl = `${process.env.SERVER_URL}/${response[0]}`;
        await this.bot.deleteMessage(chatId, loadingMsg.message_id);
        await this.bot.sendPhoto(chatId, imageUrl, {
          caption: `🖼️ Generated: "${prompt}"`
        });
      } else {
        await this.bot.editMessageText('❌ Failed to generate image.', {
          chat_id: chatId,
          message_id: loadingMsg.message_id
        });
      }
    } catch (error) {
      this.logger.error('Image generation error:', error);
      await this.bot.editMessageText('❌ Failed to generate image.', {
        chat_id: chatId,
        message_id: loadingMsg.message_id
      });
    }
  }

  private async handleVoiceMessage(msg: any) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const voiceFileId = msg.voice.file_id;

    try {
      const processingMsg = await this.bot.sendMessage(chatId, '🎤 Processing your voice message...');

      const file = await this.bot.getFile(voiceFileId);
      const fileStream = this.bot.getFileStream(file.file_id);

      const filePath = await this.saveVoiceFile(fileStream, file.file_id);
      const transcription = await this.audioService.convertAudioToText(filePath);

      if (transcription.status === 'error') {
        await this.bot.editMessageText('❌ Could not transcribe audio.', {
          chat_id: chatId,
          message_id: processingMsg.message_id
        });
        return;
      }

      const aiResponse = await this.openaiService.generateAIResponse(userId, transcription.data);
      const textToSpeech = await this.audioService.convertTextToSpeech(aiResponse);

      await this.bot.deleteMessage(chatId, processingMsg.message_id);

      if (textToSpeech.status === 'success') {
        const audioUrl = `${process.env.SERVER_URL}/${textToSpeech.data}`;
        await this.bot.sendVoice(chatId, audioUrl, {
          reply_to_message_id: msg.message_id
        });
      } else {
        await this.bot.sendMessage(chatId, aiResponse, {
          reply_to_message_id: msg.message_id
        });
      }

    } catch (error) {
      this.logger.error('Voice message error:', error);
      await this.bot.sendMessage(chatId, '❌ Failed to process your voice message.');
    }
  }

  private async handleCallbackQuery(query: any) {
    const chatId = query.message.chat.id;
    const userId = query.from.id.toString();
    const data = query.data;

    await this.bot.answerCallbackQuery(query.id);

    await this.userContextService.saveToContext(
      `User selected: ${data}`,
      'user',
      userId
    );

    const serviceInfo = this.getServiceInfo(data);

    await this.userContextService.saveToContext(
      serviceInfo,
      'assistant',
      userId
    );

    await this.bot.sendMessage(chatId, serviceInfo, {
      parse_mode: 'Markdown'
    });
  }

  private getServiceInfo(serviceId: string): string {
    const serviceInfo = {
      view_products: `🛍️ *GraeCare Products*\n\nExplore our selection of wellness, personal care, and everyday health items.\n\nYou can browse:\n• Herbal teas\n• Skincare\n• Supplements\n• Feminine care\n\nVisit [graecare.com](https://graecare.com) to shop now or type your specific product name.`,
      track_order: `📦 *Track Your Order*\n\nTo track your order, please reply with your *Order ID* or *Phone Number* used during checkout.`,
      pickup_locations: `📍 *Pickup Locations*\n\nYou can collect your order from any of our authorized pickup stations.\n\nTo find the nearest location, reply with your area or town.`,
      faqs: `💬 *Frequently Asked Questions*\n\nHere are some quick answers:\n\n• *How long does delivery take?* Usually 1–3 business days.\n• *Where are you located?* Nairobi, Kenya (Online-first).\n• *Can I return products?* Yes, within 7 days if unopened.\n\nType your question if it’s not listed.`,
      talk_to_human: `👤 *Talk to Support*\n\nOur team will respond as soon as possible. You can also email us at *support@graecare.com* or call *+254 700 123456*.`
    };

    return serviceInfo[serviceId] || 'Thank you for your interest! Let us know how we can help.';
  }

  private async saveVoiceFile(fileStream: NodeJS.ReadableStream, fileId: string): Promise<string> {
    const fs = require('fs');
    const path = require('path');

    const audioFolder = process.env.AUDIO_FILES_FOLDER || 'audioFiles';
    const fileName = `${fileId}.ogg`;
    const filePath = path.join(process.cwd(), audioFolder, fileName);

    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(filePath);
      fileStream.pipe(writeStream);

      writeStream.on('finish', () => resolve(filePath));
      writeStream.on('error', (error) => reject(error));
    });
  }
}
