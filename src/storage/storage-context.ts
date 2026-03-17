// src/storage/storage-context.ts
import { createContext } from '@lit/context';
import type { StorageBackend } from './types.js';
import type { ProjectService } from './project-service.js';

export const storageBackendContext = createContext<StorageBackend>('storage-backend');
export const projectServiceContext = createContext<ProjectService>('project-service');
