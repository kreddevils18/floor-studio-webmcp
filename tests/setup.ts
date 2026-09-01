import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary')
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64')
if (!globalThis.createImageBitmap)
  Object.defineProperty(globalThis, 'createImageBitmap', {
    value: async (blob: Blob) => {
      const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error ?? new Error('Blob fixture could not be read.'))
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.readAsArrayBuffer(blob)
      })
      const bytes = new Uint8Array(buffer)
      const signature = [137, 80, 78, 71, 13, 10, 26, 10]
      const type = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4))
      if (
        bytes.length < 45 ||
        !signature.every((byte, index) => bytes[index] === byte) ||
        type(12) !== 'IHDR' ||
        !Buffer.from(bytes).includes(Buffer.from('IDAT')) ||
        type(bytes.length - 8) !== 'IEND'
      )
        throw new Error('Invalid PNG fixture.')
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return { width: view.getUint32(16), height: view.getUint32(20), close() {} } as ImageBitmap
    },
  })
