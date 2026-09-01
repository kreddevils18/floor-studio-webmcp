interface RasterConstraints {
  minWidth?: number
  minHeight?: number
  width?: number
  height?: number
}

export async function validateRasterBlob(blob: Blob, constraints: RasterConstraints) {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    throw new Error('The raster could not be decoded.')
  }
  try {
    if (constraints.width !== undefined && bitmap.width !== constraints.width)
      throw new Error(`The raster width must be ${constraints.width} pixels.`)
    if (constraints.height !== undefined && bitmap.height !== constraints.height)
      throw new Error(`The raster height must be ${constraints.height} pixels.`)
    if ((constraints.minWidth ?? 0) > bitmap.width || (constraints.minHeight ?? 0) > bitmap.height)
      throw new Error(
        `The raster must be at least ${constraints.minWidth ?? 1} × ${constraints.minHeight ?? 1} pixels.`,
      )
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}
