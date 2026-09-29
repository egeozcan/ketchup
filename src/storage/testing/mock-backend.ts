// src/storage/testing/mock-backend.ts
import { MemoryBackend } from '../memory/index.js';

let counter = 0;
function mockUUID(): string {
  return `mock-${++counter}`;
}

/** MemoryBackend with predictable ids (`mock-1`, `mock-2`, ...), restarted per instance. */
export class MockBackend extends MemoryBackend {
  constructor() {
    counter = 0;
    super(mockUUID);
  }
}
