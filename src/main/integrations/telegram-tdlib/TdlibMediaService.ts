import type { TelegramAttachmentDownloadResult } from '../../domain/types';
import type { TdlibClient } from './TdlibClient';

export class TdlibMediaService {
  constructor(private readonly client: TdlibClient) {}

  async downloadFile(payload: { fileId: number; priority?: number }): Promise<TelegramAttachmentDownloadResult> {
    const result = await this.client.send<{ '@type': string; local?: { path?: string } }>({
      '@type': 'downloadFile',
      file_id: payload.fileId,
      priority: payload.priority ?? 1,
      offset: 0,
      limit: 0,
      synchronous: true
    });
    const filePath = result.local?.path;
    if (!filePath) {
      throw new Error('TDLib не вернул путь к скачанному файлу.');
    }
    return { filePath };
  }
}
