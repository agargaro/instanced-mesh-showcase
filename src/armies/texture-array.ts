import type { Texture } from 'three';
import { DataArrayTexture, LinearFilter, LinearMipMapLinearFilter, SRGBColorSpace } from 'three';

/** Packs the images into one sRGB array texture, resized to the largest image, as the legacy example. */
export function createDataArrayTexture(textures: Texture[]): DataArrayTexture {
  const images = textures.map((item) => item.image as HTMLImageElement);
  const width = Math.max(...images.map((image) => image.width));
  const height = Math.max(...images.map((image) => image.height));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('Canvas 2D is unavailable.');
  const pixels = new Uint8Array(width * height * 4 * images.length);
  for (let i = 0; i < images.length; i++) {
    context.clearRect(0, 0, width, height);
    context.drawImage(images[i], 0, 0, width, height);
    pixels.set(context.getImageData(0, 0, width, height).data, i * width * height * 4);
  }
  const textureArray = new DataArrayTexture(pixels, width, height, images.length);
  textureArray.minFilter = LinearMipMapLinearFilter;
  textureArray.magFilter = LinearFilter;
  textureArray.generateMipmaps = true;
  textureArray.colorSpace = SRGBColorSpace;
  textureArray.needsUpdate = true;
  return textureArray;
}
