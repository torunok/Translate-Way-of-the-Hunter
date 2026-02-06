
export interface GlossaryEntry {
  english: string;
  ukrainian: string;
}

export interface TranslationItem {
  id: string | number;
  key: string;
  source: string;
  target?: string;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'cached';
  fileName: string;
  confidence?: number;
  validationNote?: string;
  issue?: string;
  isEdited?: boolean;
}

export interface FileEntry {
  name: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  progress: number;
  totalItems: number;
  completedItems: number;
  rawFile?: File;
}

export interface LocalizationStats {
  totalFiles: number;
  completedFiles: number;
  totalStrings: number;
  completedStrings: number;
  cachedStrings: number;
  apiCalls: number;
  errors: number;
}

export interface TranslationMemory {
  [source: string]: string;
}

export interface ToastMessage {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}
