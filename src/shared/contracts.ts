export type Side = 'left' | 'right';
export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'gb18030';
export type TargetStatus = 'pending' | 'saving' | 'saved' | 'conflict' | 'error' | 'rejected' | 'withdrawn';
export interface SaveReceipt {
  operationId: string; targetPath: string; backupPath?: string;
  beforeHash: string | null; afterHash: string; savedAt: string; side: Side;
}
export interface TargetView {
  id: string; path: string; encoding: TextEncoding; bom: boolean; exists: boolean;
  baseHash: string | null; status: TargetStatus; error?: string; receipt?: SaveReceipt;
}
export interface PaneView { text: string; revision: number; targetId: string | null; }
export interface ReviewSource { agent: string; threadId?: string; threadTitle?: string; }
export const REVIEW_SOURCE_LIMITS = { agent: 80, threadId: 200, threadTitle: 300 } as const;
export function isReviewSource(value: unknown): value is ReviewSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return typeof source.agent === 'string' && Object.keys(source).every(key => Object.hasOwn(REVIEW_SOURCE_LIMITS, key)) &&
    Object.entries(REVIEW_SOURCE_LIMITS).every(([field, limit]) => source[field] === undefined ? field !== 'agent' :
      typeof source[field] === 'string' && source[field].trim().length > 0 && source[field].length <= limit);
}
export interface ReviewView {
  id: string; title: string; mode: 'single' | 'pair' | 'proposal' | 'text';
  source?: ReviewSource;
  closedAt?: string;
  withdrawnAt?: string;
  createdAt: string; updatedAt: string; left: PaneView; right: PaneView; targets: TargetView[];
}
export interface WorkspaceView { reviews: ReviewView[]; }
export interface BaselineRequest { paths: string[]; encoding?: TextEncoding; }
export interface BaselineFile {
  id: string; path: string; sha256: string | null; exists: boolean;
  text: string; encoding: TextEncoding; bom: boolean;
}
export interface BaselineResponse { files: BaselineFile[]; }
export interface SubmitRequest {
  requestId: string; title?: string; source?: ReviewSource; files: { baselineId: string; text: string }[];
}
export interface SubmitResponse { reviewIds: string[]; duplicate: boolean; }
export interface WithdrawRequest { reviewId: string; requestId: string; requireUnedited?: true; }
export interface WithdrawResponse { reviewId: string; status: 'withdrawn'; withdrawnAt: string; duplicate: boolean; review: ReviewStatus; }
export interface WithdrawPreflight { token: string; reviewId: string; }
export interface WithdrawFinished extends WithdrawPreflight { withdrawnAt?: string; }
export interface OpenFilesRequest {
  paths: string[]; mode: 'single' | 'pair'; encoding?: TextEncoding;
}
export interface UpdateDraftRequest {
  reviewId: string; side: Side; text: string; expectedRevision: number;
}
export interface PrepareSaveRequest {
  reviewId: string; side: Side; expectedRevision: number; encoding?: TextEncoding;
  newPath?: string;
}
export interface SavePreview {
  token: string; reviewId: string; side: Side; revision: number;
  targetPath: string; backupPath?: string; isNew: boolean; encoding: TextEncoding;
  beforeHash: string | null; afterHash: string;
}
export interface ReviewStatus {
  id: string; title: string; targets: TargetView[]; leftRevision: number; rightRevision: number;
  source?: ReviewSource;
  lifecycle?: 'open' | 'closed' | 'deleted';
  withdrawnAt?: string;
}
export interface StatusResponse { reviews: ReviewStatus[]; }
export interface WaitRequest { reviewIds: string[]; timeoutMs: number; }
export interface WaitResponse extends StatusResponse { reason: 'saved' | 'attention' | 'timeout'; }
export const DEFAULT_WAIT_MS = 30 * 60 * 1000;
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export type CliRequest =
  | { command: 'baseline'; payload: BaselineRequest }
  | { command: 'submit'; payload: SubmitRequest }
  | { command: 'withdraw'; payload: WithdrawRequest }
  | { command: 'status'; payload: { reviewId?: string } }
  | { command: 'wait'; payload: WaitRequest };
export type WireReply = { ok: true; result: unknown } | { ok: false; error: string; code?: string; reviewIds?: string[] };
export interface AppSettings { closeToTray: boolean; }
export interface DesktopAPI {
  getSettings(): Promise<AppSettings>;
  setSettings(settings: AppSettings): Promise<AppSettings>;
  list(): Promise<WorkspaceView>;
  pickFiles(mode: 'single' | 'pair', encoding?: TextEncoding): Promise<WorkspaceView>;
  openFiles(request: OpenFilesRequest): Promise<WorkspaceView>;
  createTextReview(): Promise<ReviewView>;
  setReviewClosed(reviewId: string, closed: boolean): Promise<void>;
  deleteReview(reviewId: string): Promise<void>;
  deleteClosedReviews(reviewIds: string[]): Promise<string[]>;
  updateDraft(request: UpdateDraftRequest): Promise<ReviewView>;
  prepareSave(request: PrepareSaveRequest): Promise<SavePreview | null>;
  commitSave(token: string): Promise<SaveReceipt>;
  continueTarget(reviewId: string, targetId: string): Promise<ReviewView>;
  rejectReview(reviewId: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  getFilePath(file: File): string;
  onChanged(callback: () => void): () => void;
  onSaveShortcut(callback: () => void): () => void;
  readyToClose(): void;
  onBeforeClose(callback: () => void): () => void;
  onBeforeWithdraw(callback: (request: WithdrawPreflight) => void): () => void;
  withdrawReady(token: string, error?: string): void;
  onWithdrawFinished(callback: (result: WithdrawFinished) => void): () => void;
}
declare global { interface Window { diffEditor: DesktopAPI; } }
