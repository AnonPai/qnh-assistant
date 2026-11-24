import type { UploadedMedia } from '@shared/messaging';
import { sha256Hex } from '@shared/hash';
import { createLogger } from '@shared/logger';
import { fetchUrlAsArrayBuffer, type UrlHashCache } from '@shared/url-hash-cache';

const log = createLogger('store-images');

function key(shopId: string | number, hash: string) {
  return `qnh.store-image.v1:${shopId}:${hash}`;
}

type StoredImage = { media: UploadedMedia; targetHash: string };

export async function rememberStoreImage(
  shopId: string | number, hash: string, media: UploadedMedia, targetHash: string,
) {
  try {
    await chrome.storage.local.set({ [key(shopId, hash)]: { media, targetHash } satisfies StoredImage });
  } catch (err) {
    log.warn('图片复用记录保存失败', err);
  }
}

export async function reuseStoreImages(
  shopId: string | number, pending: Set<string>, mediaIdMap: Record<string, UploadedMedia>,
  cache: UrlHashCache, cancelFlag: { cancelled: boolean },
) {
  if (!pending.size) return;
  let records;
  try {
    records = await chrome.storage.local.get([...pending].map(hash => key(shopId, hash)));
  } catch (err) {
    log.warn('图片复用记录读取失败', err);
    return;
  }
  for (const hash of pending) {
    if (cancelFlag.cancelled) break;
    const record = records[key(shopId, hash)] as StoredImage | undefined;
    if (!record?.media?.fileUrl || !record.targetHash) continue;
    try {
      // 跨任务引用另一商品的图片前，核对线上文件，避免把已失效或被替换的链接写入新商品。
      const targetHash = await sha256Hex(await fetchUrlAsArrayBuffer(record.media.fileUrl));
      if (targetHash !== record.targetHash) continue;
      mediaIdMap[hash] = record.media;
      cache.recordUploadEquiv(hash, targetHash);
      pending.delete(hash);
    } catch (err) {
      log.warn('门店图片地址无法核实，将从本地上传', err);
    }
  }
}
