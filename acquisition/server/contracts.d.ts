/** Acquisition integration contracts. No auto-posting or video production agent here. */
export type FactStatus = 'confirmed' | 'inferred' | 'unknown' | 'declined';
export type CustomerFact = { value: string; status: FactStatus; sourceMessageId: string | null; author: 'agent' | 'human' | 'customer_form'; updatedAt: string; schemaVersion: number };
export type ConversationMode = 'auto' | 'review' | 'awaiting_human' | 'human' | 'paused';
export type SendResult = { status: 'sent' | 'simulated_sent' | 'send_unknown' | 'needs_manual_execution'; externalId: string | null; evidence?: string; delivery?: 'unknown' };
export type Slot = { id: string; start: string; end: string; timezone: string; label?: string };
export interface CalendarAdapter {
  availability(business: unknown, bookings: unknown[]): Promise<Slot[]>;
  book(input: { slot: Slot; contact: unknown; requestKey: string; business: unknown; summary: string }): Promise<{ status: 'confirmed' | 'simulated'; externalId: string; url: string | null }>;
  reconcile(requestKey: string): Promise<unknown>;
  cancel(booking: unknown): Promise<unknown>;
}
export interface InstagramAdapter { send(input: { contact: unknown; text: string; media?: unknown[] }): Promise<SendResult>; }
export interface BrowserOutreachAdapter { send(job: unknown, contact: unknown, stillEligible: () => boolean): Promise<SendResult>; }
export interface DriveAdapter {
  save(relativePath: string, value: unknown): Promise<{ status: 'local_mirror' | 'synced'; fileId: string | null }>;
  saveBinary(relativePath: string, sourceFile: string, mimeType: string): Promise<unknown>;
  listSourceFiles(): Promise<{ id: string; name: string; mimeType: string; size: string; description?: string }[]>;
  readSourceFile(fileId: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
}
/** Produced by the separate video agent; ingest through POST /api/content/posts. */
export type VideoMetadata = {
  schemaVersion: 1;
  contentId: string;
  revision: number;
  platform: 'instagram';
  instagramMediaId?: string | null;
  permalink?: string | null;
  title: string;
  caption?: string;
  durationSeconds: number | null;
  video?: { driveFileId?: string | null; mimeType: 'video/mp4' };
  posterDriveFileId?: string | null;
  source: { system: string; recordId: string };
  demo?: boolean;
  rawAssets: { id: string; title: string; kind: 'image' | 'video' | 'document'; driveFileId?: string | null; description?: string; customerShareable?: boolean }[];
  facts?: VideoFact[];
  segments: {
    id: string;
    startSeconds: number;
    endSeconds: number;
    description?: string;
    transcript?: string;
    rawAssetIds: string[];
    rawRanges?: { assetId: string; startSeconds: number; endSeconds: number }[];
    keyframes?: { atSeconds: number; driveFileId: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }[];
    facts?: VideoFact[];
  }[];
};
export type VideoFact = { id: string; key: string; value: string; verified: boolean; customerVisible: boolean; sourceAssetIds: string[] };
/** External database/Drive watchers map their rows into VideoMetadata, then call the ingest endpoint.
 * source.recordId preserves the upstream database key. Credentials remain server-side.
 * A viewer or anonymous completion statistic MUST NOT be returned as a person-level prospect.
 */
export interface VideoMetadataSource { pullSince(cursor: string | null): Promise<{ posts: VideoMetadata[]; nextCursor: string | null }>; }
