import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary')
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64')
