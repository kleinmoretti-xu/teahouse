// 图片消息相关常量：main / renderer 共用，避免各层各自维护白名单。

export const IMAGE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'] as const

export const DEFAULT_IMAGE_EXTENSION = '.png'
