import { bool, num, parseObject, str, type Json } from './json.ts';

export type ItemKind = 'document' | 'folder' | 'template' | 'unknown';

/** `<id>.metadata`: what an item is called, where it sits, and when it changed. */
export interface Metadata {
  name: string;
  kind: ItemKind;
  /** '' for the top level, 'trash' for the trash, else the id of the folder holding it. */
  parent: string;
  /** Epoch ms; 0 when unknown. */
  lastModified: number;
  createdTime: number;
  lastOpened: number;
  /** 0-based; null when unknown. */
  lastOpenedPage: number | null;
  pinned: boolean;
  /** Deleted for good on the tablet (awaiting purge), as opposed to in the trash. */
  deleted: boolean;
  raw: Json;
}

const KINDS: Record<string, ItemKind> = { DocumentType: 'document', CollectionType: 'folder', TemplateType: 'template' };

export function parseMetadata(input: string | Uint8Array): Metadata {
  const raw = parseObject(input, '.metadata');
  return {
    name: str(raw.visibleName, 'Untitled'),
    kind: KINDS[str(raw.type)] ?? 'unknown',
    parent: str(raw.parent),
    lastModified: num(raw.lastModified, 0),
    createdTime: num(raw.createdTime, 0),
    lastOpened: num(raw.lastOpened, 0),
    lastOpenedPage: num(raw.lastOpenedPage, null),
    pinned: bool(raw.pinned),
    deleted: bool(raw.deleted),
    raw,
  };
}

/** In the trash, or deleted for good: either way not one of the person's documents any more. */
export const isTrashed = (metadata: Pick<Metadata, 'parent' | 'deleted'>): boolean => metadata.deleted || metadata.parent === 'trash';
