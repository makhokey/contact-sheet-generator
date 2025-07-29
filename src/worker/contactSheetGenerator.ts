import { encode } from '@cf-wasm/png';
import * as photon from '@cf-wasm/photon';

interface ContactSheetOptions {
  thumbnailSize: number;
  columns: number;
  spacing: number;
  backgroundColor: string;
}

interface ProcessedImage {
  photonImage: photon.PhotonImage;
  position: { x: number; y: number };
  index: number;
}

export async function generateContactSheet(
  imageUrls: string[], 
  options: ContactSheetOptions = {
    thumbnailSize: 200,
    columns: 4,
    spacing: 10,
    backgroundColor: '#000000'
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _r2Bucket?: unknown
): Promise<Uint8Array> {
  
  const { thumbnailSize, columns, spacing } = options;
  const maxImages = Math.min(imageUrls.length, 20);
  
  // Calculate dimensions
  const rows = Math.ceil(maxImages / columns);
  const canvasWidth = (columns * thumbnailSize) + ((columns + 1) * spacing);
  const canvasHeight = (rows * thumbnailSize) + ((rows + 1) * spacing);
  
  try {
    // Create background canvas
    const backgroundPixels = new Uint8Array(canvasWidth * canvasHeight * 4);
    backgroundPixels.fill(255); // White background
    const canvas = new photon.PhotonImage(backgroundPixels, canvasWidth, canvasHeight);
    
    // Process all images in parallel
    const imagePromises = imageUrls.slice(0, maxImages).map(async (imageUrl, i) => {
      try {
        // Calculate grid position
        const row = Math.floor(i / columns);
        const col = i % columns;
        const x = spacing + (col * (thumbnailSize + spacing));
        const y = spacing + (row * (thumbnailSize + spacing));
        
        // Use higher quality Cloudflare Images optimization with better settings
        const highQualitySize = Math.min(thumbnailSize * 2, 800); // 2x for retina, capped at 800px
        const optimizedUrl = `https://images.qarta.ge/cdn-cgi/image/w=${highQualitySize},h=${highQualitySize},fit=scale-down,q=95,f=webp,sharpen=1,metadata=none/${imageUrl}`;
        
        const response = await fetch(optimizedUrl);
        if (!response.ok) return null;
        
        const imageBytes = new Uint8Array(await response.arrayBuffer());
        const photonImage = photon.PhotonImage.new_from_byteslice(imageBytes);
        
        // Calculate proper dimensions maintaining aspect ratio
        const imgWidth = photonImage.get_width();
        const imgHeight = photonImage.get_height();
        
        const scaleX = thumbnailSize / imgWidth;
        const scaleY = thumbnailSize / imgHeight;
        const scale = Math.min(scaleX, scaleY);
        
        const newWidth = Math.floor(imgWidth * scale);
        const newHeight = Math.floor(imgHeight * scale);
        
        // Use high-quality Lanczos sampling for better image quality
        const resizedImage = photon.resize(
          photonImage, 
          newWidth, 
          newHeight, 
          photon.SamplingFilter.Lanczos3
        );
        
        photonImage.free();
        
        return {
          photonImage: resizedImage,
          position: { x, y },
          index: i
        } as ProcessedImage;
        
      } catch {
        // Return fallback colored rectangle
        const colors = [[255, 100, 100], [100, 255, 100], [100, 100, 255], [255, 200, 100]];
        const [r, g, b] = colors[i % colors.length];
        
        const fallbackPixels = new Uint8Array(thumbnailSize * thumbnailSize * 4);
        for (let j = 0; j < fallbackPixels.length; j += 4) {
          fallbackPixels[j] = r;
          fallbackPixels[j + 1] = g;
          fallbackPixels[j + 2] = b;
          fallbackPixels[j + 3] = 255;
        }
        
        const row = Math.floor(i / columns);
        const col = i % columns;
        const x = spacing + (col * (thumbnailSize + spacing));
        const y = spacing + (row * (thumbnailSize + spacing));
        
        return {
          photonImage: new photon.PhotonImage(fallbackPixels, thumbnailSize, thumbnailSize),
          position: { x, y },
          index: i
        } as ProcessedImage;
      }
    });
    
    // Await all image processing
    const processedImages = (await Promise.all(imagePromises)).filter(Boolean) as ProcessedImage[];
    
    // Get canvas pixel data once for efficient compositing
    const canvasPixels = canvas.get_raw_pixels();
    
    // Composite all images onto canvas using optimized pixel copying
    for (const { photonImage, position } of processedImages) {
      const imgWidth = photonImage.get_width();
      const imgHeight = photonImage.get_height();
      const offsetX = Math.floor((thumbnailSize - imgWidth) / 2);
      const offsetY = Math.floor((thumbnailSize - imgHeight) / 2);
      
      const imgPixels = photonImage.get_raw_pixels();
      
      // Fast block copy using optimized loops
      for (let y = 0; y < imgHeight; y++) {
        const canvasY = position.y + offsetY + y;
        if (canvasY >= canvasHeight) break;
        
        const srcOffset = y * imgWidth * 4;
        const dstOffset = (canvasY * canvasWidth + position.x + offsetX) * 4;
        
        // Copy entire row at once when possible
        if (position.x + offsetX + imgWidth <= canvasWidth) {
          canvasPixels.set(imgPixels.subarray(srcOffset, srcOffset + imgWidth * 4), dstOffset);
        } else {
          // Pixel by pixel for edge cases
          for (let x = 0; x < imgWidth; x++) {
            const canvasX = position.x + offsetX + x;
            if (canvasX >= canvasWidth) break;
            
            const srcIdx = srcOffset + x * 4;
            const dstIdx = dstOffset + x * 4;
            
            canvasPixels[dstIdx] = imgPixels[srcIdx];
            canvasPixels[dstIdx + 1] = imgPixels[srcIdx + 1];
            canvasPixels[dstIdx + 2] = imgPixels[srcIdx + 2];
            canvasPixels[dstIdx + 3] = imgPixels[srcIdx + 3];
          }
        }
      }
      
      // Free memory immediately
      photonImage.free();
    }
    
    // Update canvas with composited pixels
    const finalCanvas = new photon.PhotonImage(canvasPixels, canvasWidth, canvasHeight);
    
    // Get final pixel data and encode with optimized settings
    const pngBytes = encode(canvasPixels, canvasWidth, canvasHeight, {
      // Use faster compression level while maintaining quality
      level: 6, // Default is 9, 6 is good balance of speed/compression
      // Enable filtering for better compression on photographic content
      filter: 'auto'
    });
    
    // Clean up
    canvas.free();
    finalCanvas.free();
    
    return pngBytes;
    
  } catch (error) {
    throw new Error(`Contact sheet generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}